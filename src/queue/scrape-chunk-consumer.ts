// Implements REQ-PIPE-002
// Implements REQ-PIPE-008 (last-chunk SCRAPE_FINALIZE enqueue)
//
// Chunk consumer for the `scrape-chunks` Cloudflare Queue. Each message
// is one chunk of up to 100 canonical-deduped candidates produced by
// the every-4-hours coordinator (REQ-PIPE-001). The consumer:
//
//   1. Builds the chunk prompt: PROCESS_CHUNK_SYSTEM + processChunkUserPrompt.
//   2. Calls Workers AI once (env.AI.run) with the default model.
//   3. Parses strict JSON via the shared extractResponsePayload +
//      parseLLMPayload helpers from `src/lib/generate.ts`.
//   4. Collapses intra-chunk dedup_groups (LLM-hinted "these are the
//      same story" groups) via mergeClustersByLlmHints, so only one
//      article row lands in D1 per real story.
//   5. Validates every output tag against the allowlist (DEFAULT_HASHTAGS
//      ∪ discovered-tag KV keys). Articles with zero valid tags are
//      dropped — they're either off-topic or the LLM hallucinated tags
//      outside the allowlist.
//   6. Sanitizes title + details via the shared sanitizeText helper.
//   7. Writes articles + article_sources + article_tags in a single D1
//      batch (atomic — partial failure rolls back).
//   8. Accumulates chunk stats into the scrape_runs row via addChunkStats.
//   9. Decrements the KV chunks_remaining counter; the last chunk calls
//      finishRun(run_id, 'ready'), closing the run.
//
// Retry contract: throwing from the handler marks the message for queue
// retry up to `max_retries` in wrangler.toml. We throw on
// llm_failed/llm_invalid_json (possibly a transient model hiccup) so
// Queues retries; we ack on parse+persist success even when the LLM
// returned zero usable articles (no retry would help).

import {
  PROCESS_CHUNK_SYSTEM,
  LLM_PARAMS,
  processChunkUserPrompt,
} from '~/lib/prompts';
import {
  parseLLMPayload,
  sanitizeText,
} from '~/lib/generate';
import {
  mergeClustersByLlmHints,
  type Candidate,
  type Cluster,
} from '~/lib/dedupe';
import { fetchArticleBodies } from '~/lib/article-fetch';
import { DEFAULT_HASHTAGS } from '~/lib/default-hashtags';
import { splitIntoParagraphs } from '~/lib/paragraph-split';
import { FALLBACK_MODEL_ID } from '~/lib/models';
import { runJsonWithFallback, previewRawResponse } from '~/lib/llm-json';
import { addChunkStats, finishRun } from '~/lib/scrape-run';
import { generateUlid } from '~/lib/ulid';
import { applyForeignKeysPragma, batch as batchExec } from '~/lib/db';
import { log } from '~/lib/log';

/** Shape of every `scrape-chunks` queue message. Produced by the
 * coordinator in `src/queue/scrape-coordinator.ts`. `candidates` are the
 * canonical-deduped survivors for this chunk; the consumer preserves
 * input order when mapping LLM output indices back to source rows. */
export interface ChunkJobMessage {
  scrape_run_id: string;
  chunk_index: number;
  total_chunks: number;
  candidates: Array<{
    canonical_url: string;
    source_url: string;
    source_name: string;
    title: string;
    /** Unix seconds. Used as the tiebreaker when two candidates cluster
     * together — earliest-published wins as the cluster primary. */
    published_at: number;
    body_snippet?: string;
    /** Optional alternative sources discovered by the coordinator for
     * the same canonical URL (multi-feed cluster). These land in
     * `article_sources` under the primary article. */
    alternatives?: Array<{
      source_url: string;
      source_name: string;
    }>;
  }>;
}

/** One article the LLM returned, after shape validation. */
interface LLMChunkArticle {
  /** Candidate index the LLM claims this entry corresponds to. Required
   * in the prompt contract (REQ-PIPE-002) so the consumer can align LLM
   * output back to the input candidate by VALUE, not by position —
   * models occasionally reorder, skip, or invent entries, which caused
   * summaries to be stapled to the wrong canonical URL. */
  index?: unknown;
  title?: unknown;
  details?: unknown;
  tags?: unknown;
}

/** Full shape the chunk LLM is instructed to return. */
interface LLMChunkPayload {
  articles?: LLMChunkArticle[];
  dedup_groups?: unknown;
}

/** Handle one batch of `scrape-chunks` messages. Queues sets
 * `max_batch_size = 1` in wrangler.toml, so `batch.messages` is almost
 * always length 1 — we still loop to be safe. */
export async function handleChunkBatch(
  batch: MessageBatch<ChunkJobMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processOneChunk(env, message.body);
      message.ack();
    } catch (err) {
      log('error', 'digest.generation', {
        status: 'chunk_consumer_throw',
        scrape_run_id: message.body.scrape_run_id,
        chunk_index: message.body.chunk_index,
        attempts: message.attempts,
        detail: String(err).slice(0, 500),
      });
      // On final retry, mark the parent run as failed so operators
      // and the UI don't see an orphan stuck at status='running'.
      if (message.attempts >= 3) {
        try {
          await finishRun(env.DB, message.body.scrape_run_id, 'failed');
        } catch (finishErr) {
          log('error', 'digest.generation', {
            status: 'chunk_finish_failed_after_throw',
            scrape_run_id: message.body.scrape_run_id,
            detail: String(finishErr).slice(0, 500),
          });
        }
      }
      message.retry();
    }
  }
}

/** Process a single chunk message end-to-end. Exported for direct unit
 * testing without having to fake the queue batch envelope. */
export async function processOneChunk(
  env: Env,
  body: ChunkJobMessage,
): Promise<void> {
  await applyForeignKeysPragma(env.DB);

  const allowedTags = await loadAllowedTags(env.KV);
  const allowedTagSet = new Set(allowedTags);

  // Fetch article bodies for candidates whose feed snippet is thin.
  // Happens inside the chunk consumer (not the coordinator) so the
  // coordinator's execution budget isn't blown by 500+ HTTP fetches
  // before it can enqueue chunks. Each chunk only fetches its own
  // ~100 URLs (100 × 5s / 20 workers ≈ 25s) — well within a chunk
  // consumer's 15-min queue-message budget. Feeds that ship rich
  // <content:encoded> skip the fetch; the LLM prompt's 'grounded
  // summary' branch only fires when snippet has real content.
  const SNIPPET_FLOOR = 400;
  const urlsToFetch: string[] = [];
  for (const c of body.candidates) {
    const existingSnippet = c.body_snippet ?? '';
    if (existingSnippet.length < SNIPPET_FLOOR) {
      urlsToFetch.push(c.source_url);
    }
  }
  let fetchedBodies = new Map<string, string>();
  if (urlsToFetch.length > 0) {
    const fetchStart = Date.now();
    // Pass APP_URL as the contact URL so the User-Agent on outbound
    // article fetches points at THIS deployment, not the upstream
    // repo's host. Forks deploying their own copy get correct
    // attribution; the helper falls back to a generic identifier when
    // env.APP_URL is unset (local dev with no deployment hostname).
    fetchedBodies = await fetchArticleBodies(urlsToFetch, 20, env.APP_URL);
    log('info', 'digest.generation', {
      status: 'chunk_article_bodies_fetched',
      scrape_run_id: body.scrape_run_id,
      chunk_index: body.chunk_index,
      urls_requested: urlsToFetch.length,
      urls_fetched: fetchedBodies.size,
      duration_ms: Date.now() - fetchStart,
    });
  }

  // Build candidates in the LLM-expected shape. Order is preserved so
  // output array indices line up with input indices for cluster + dedup
  // lookups. For each candidate we keep whichever snippet is longer:
  // the fetched HTML body, or the feed's own <content:encoded>.
  const promptCandidates = body.candidates.map((c, idx) => {
    const fetched = fetchedBodies.get(c.source_url) ?? '';
    const feedSnippet = c.body_snippet ?? '';
    const bestSnippet =
      fetched.length > feedSnippet.length ? fetched : feedSnippet;
    const base = {
      index: idx,
      title: c.title,
      url: c.source_url,
      source_name: c.source_name,
      published_at: c.published_at,
    };
    if (bestSnippet !== '') return { ...base, body_snippet: bestSnippet };
    return base;
  });
  // Observability: log how many candidates fell through with NO
  // snippet of any kind so we can find feeds + URLs where our
  // extractor is failing and improve the heuristic.
  const noSnippetCount = promptCandidates.filter(
    (p) => !('body_snippet' in p) || p.body_snippet === undefined || p.body_snippet === '',
  ).length;
  if (noSnippetCount > 0) {
    log('warn', 'digest.generation', {
      status: 'chunk_candidates_without_snippet',
      scrape_run_id: body.scrape_run_id,
      chunk_index: body.chunk_index,
      no_snippet: noSnippetCount,
      total: promptCandidates.length,
    });
  }

  // CF-009: primary-then-fallback retry centralised in
  // src/lib/llm-json.ts so chunk + finalize + discovery share the
  // same waste-cost accounting and the same single-attempt narrowing.
  // The hot path stays on the cheap default (gemma-4); the fallback
  // (gpt-oss-20b) is JSON-strict for runs where the primary's
  // prompt-following wobbles.
  const llmRun = await runJsonWithFallback({
    ai: env.AI as unknown as { run: (m: string, p: Record<string, unknown>) => Promise<unknown> },
    params: {
      messages: [
        { role: 'system', content: PROCESS_CHUNK_SYSTEM },
        { role: 'user', content: processChunkUserPrompt(promptCandidates, allowedTags) },
      ],
      ...LLM_PARAMS,
    },
    narrow: (raw) => narrowChunkPayload(parseLLMPayload(raw), raw),
    onPrimaryFailure: (info) => {
      log('warn', 'digest.generation', {
        status: 'chunk_invalid_json_fallback_try',
        scrape_run_id: body.scrape_run_id,
        chunk_index: body.chunk_index,
        primary_model: info.modelUsed,
        fallback_model: FALLBACK_MODEL_ID,
        primary_tokens_in: info.tokensIn,
        primary_tokens_out: info.tokensOut,
        primary_cost_usd: info.costUsd,
        primary_response_preview: previewRawResponse(info.rawResponse),
      });
    },
  });

  if (!llmRun.ok) {
    log('warn', 'digest.generation', {
      status: 'chunk_invalid_json',
      scrape_run_id: body.scrape_run_id,
      chunk_index: body.chunk_index,
      fallback_model: llmRun.fallback.modelUsed,
      fallback_tokens_in: llmRun.fallback.tokensIn,
      fallback_tokens_out: llmRun.fallback.tokensOut,
      fallback_response_preview: previewRawResponse(llmRun.fallback.rawResponse),
    });
    throw new Error('chunk_invalid_json');
  }

  const parsed = llmRun.parsed;
  const modelUsed = llmRun.modelUsed;
  const wastedTokensIn = llmRun.wastedTokensIn;
  const wastedTokensOut = llmRun.wastedTokensOut;
  const wastedCostUsd = llmRun.wastedCostUsd;

  const rawArticles = Array.isArray(parsed.articles) ? parsed.articles : [];
  const dedupGroups = normaliseDedupGroups(parsed.dedup_groups);

  // Build one candidate cluster per input row. Each starts as a
  // singleton cluster whose primary is the input candidate plus its
  // coordinator-provided alternatives. mergeClustersByLlmHints then
  // collapses groups listed in `dedup_groups`.
  const perInputClusters: Cluster[] = body.candidates.map((c) => {
    const primary: Candidate = {
      canonical_url: c.canonical_url,
      source_url: c.source_url,
      source_name: c.source_name,
      title: c.title,
      published_at: c.published_at,
      ...(typeof c.body_snippet === 'string' && c.body_snippet !== ''
        ? { body_snippet: c.body_snippet }
        : {}),
    };
    const alternatives: Candidate[] = (c.alternatives ?? []).map((alt) => ({
      canonical_url: c.canonical_url,
      source_url: alt.source_url,
      source_name: alt.source_name,
      title: c.title,
      published_at: c.published_at,
    }));
    return { primary, alternatives };
  });

  // Merge clusters per LLM dedup hints. The result array is stable-
  // ordered: each merged cluster is anchored at the minimum index of
  // its source clusters.
  const mergedClusters = mergeClustersByLlmHints(perInputClusters, dedupGroups);

  // Map merged clusters back to their LLM article payloads. A merged
  // cluster at anchor index N uses articles[N] for title/details/tags;
  // the other grouped indices are collapsed into article_sources rows.
  // Track which input indices made it into which merged cluster.
  const collapsedSet = buildCollapsedSet(perInputClusters.length, dedupGroups);

  interface Survivor {
    cluster: Cluster;
    articleIdx: number; // the LLM article index whose title/details/tags we use
    llmArticle: LLMChunkArticle;
  }
  const survivors: Survivor[] = [];
  // mergedClusters come out in input order. For each one we need the
  // "anchor" input index — the cluster's primary's original position —
  // to pick the matching LLM article.
  const anchorByCluster = buildAnchorIndices(perInputClusters, dedupGroups);

  // Align LLM output to input candidates BY VALUE using the echoed
  // `index` field, not by positional order. Models occasionally reorder
  // entries, skip candidates, or invent articles that weren't in the
  // input — when that happens, positional alignment staples the wrong
  // summary to the wrong canonical URL. Require each LLM article to
  // echo its candidate index and look it up by that key; fall back to
  // positional only when the index is missing (legacy model behaviour)
  // to preserve backwards compatibility on the first deploy after this
  // change.
  const articleByIndex = new Map<number, LLMChunkArticle>();
  let articlesWithEchoedIndex = 0;
  let duplicateEchoedIndex = 0;
  for (let i = 0; i < rawArticles.length; i += 1) {
    const art = rawArticles[i];
    if (art === undefined) continue;
    const echoed = art.index;
    if (
      typeof echoed === 'number' &&
      Number.isInteger(echoed) &&
      echoed >= 0 &&
      echoed < perInputClusters.length
    ) {
      articlesWithEchoedIndex += 1;
      if (articleByIndex.has(echoed)) {
        duplicateEchoedIndex += 1;
      } else {
        articleByIndex.set(echoed, art);
      }
    }
  }
  // Enable strict index-echo alignment only when the model demonstrably
  // adopted the contract on this chunk. A single echoed entry out of
  // 50 is likely a fluke — falling into strict mode there would drop
  // the other 49 positionally-aligned articles. Require a majority OR
  // an absolute floor of 3 echoed entries.
  const useEchoedIndex =
    articlesWithEchoedIndex >= 3 ||
    (rawArticles.length > 0 &&
      articlesWithEchoedIndex * 2 >= rawArticles.length);
  let droppedForMissingAlignment = 0;
  let droppedForTitleMismatch = 0;

  let clusterCursor = 0;
  for (const merged of mergedClusters) {
    const anchor = anchorByCluster[clusterCursor] ?? 0;
    clusterCursor++;
    const llmArticle = useEchoedIndex
      ? articleByIndex.get(anchor)
      : rawArticles[anchor];
    if (llmArticle === undefined) {
      droppedForMissingAlignment += 1;
      continue;
    }
    // Defense-in-depth: even when the LLM echoes the right index, it
    // could still write content for a different candidate. Compare the
    // LLM title against the source candidate title for at least one
    // shared non-trivial word. Zero overlap on two long titles signals
    // the LLM got its wires crossed (the "CF CLI Local Explorer"
    // summary on a SageMaker URL bug had exactly zero shared tokens).
    const llmTitle = typeof llmArticle.title === 'string' ? llmArticle.title : '';
    if (!titlesShareAnyToken(llmTitle, merged.primary.title)) {
      droppedForTitleMismatch += 1;
      log('warn', 'digest.generation', {
        status: 'chunk_article_dropped_title_mismatch',
        scrape_run_id: body.scrape_run_id,
        chunk_index: body.chunk_index,
        anchor_index: anchor,
        candidate_title: merged.primary.title.slice(0, 120),
        llm_title: llmTitle.slice(0, 120),
      });
      continue;
    }
    survivors.push({ cluster: merged, articleIdx: anchor, llmArticle });
  }

  // Sanitize + validate each surviving article. Articles with zero
  // allowed tags after validation are dropped.
  interface PreparedArticle {
    id: string;
    canonical_url: string;
    title: string;
    details: string[]; // 1-3 paragraphs, persisted as JSON array in details_json
    tags: string[];
    primary_source_url: string;
    primary_source_name: string;
    alternatives: Array<{ source_url: string; source_name: string }>;
    published_at: number;
  }
  const prepared: PreparedArticle[] = [];
  for (const s of survivors) {
    const title = sanitizeText(s.llmArticle.title);
    const detailsRaw = s.llmArticle.details;
    // The prompt contract asks the LLM for a single string with
    // paragraphs separated by `\n`. A minority of responses escape the
    // separator as the two-character sequence `\n` (backslash + n)
    // rather than a real newline — splitIntoParagraphs normalises both
    // forms before splitting. If the model ignores the contract and
    // returns an array, apply the same normaliser per element.
    const rawPieces: string[] = Array.isArray(detailsRaw)
      ? detailsRaw.flatMap((p) =>
          typeof p === 'string' ? splitIntoParagraphs(p) : [],
        )
      : typeof detailsRaw === 'string'
        ? splitIntoParagraphs(detailsRaw)
        : [];
    const details = rawPieces
      .map((p) => sanitizeText(p))
      .filter((p) => p !== '');
    if (title === '' || details.length === 0) continue;

    const llmTags = Array.isArray(s.llmArticle.tags) ? s.llmArticle.tags : [];
    const tags: string[] = [];
    const seen = new Set<string>();
    for (const t of llmTags) {
      if (typeof t !== 'string') continue;
      const normalised = t.trim().toLowerCase().replace(/^#/, '');
      if (normalised === '' || seen.has(normalised)) continue;
      if (!allowedTagSet.has(normalised)) continue;
      seen.add(normalised);
      tags.push(normalised);
    }
    if (tags.length === 0) continue;

    const primary = s.cluster.primary;
    prepared.push({
      id: generateUlid(),
      canonical_url: primary.canonical_url,
      title,
      details,
      tags,
      primary_source_url: primary.source_url,
      primary_source_name: primary.source_name,
      alternatives: s.cluster.alternatives.map((alt) => ({
        source_url: alt.source_url,
        source_name: alt.source_name,
      })),
      published_at: primary.published_at,
    });
  }

  // Build the atomic batch: one INSERT per article, one per alt source,
  // one per tag. D1 handles ordering + rollback. Column list mirrors
  // migrations/0003_global_feed.sql exactly — details_json / tags_json
  // are JSON arrays, ingested_at stamps row creation, scrape_run_id
  // is the parent run attribution.
  const statements: D1PreparedStatement[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  for (const a of prepared) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO articles
           (id, canonical_url, primary_source_name, primary_source_url,
            title, details_json, tags_json, published_at, ingested_at,
            scrape_run_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      ).bind(
        a.id,
        a.canonical_url,
        a.primary_source_name,
        a.primary_source_url,
        a.title,
        JSON.stringify(a.details),
        JSON.stringify(a.tags),
        a.published_at,
        nowSec,
        body.scrape_run_id,
      ),
    );
    for (const alt of a.alternatives) {
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO article_sources
             (article_id, source_name, source_url, published_at)
           VALUES (?1, ?2, ?3, ?4)`,
        ).bind(a.id, alt.source_name, alt.source_url, a.published_at),
      );
    }
    for (const tag of a.tags) {
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO article_tags (article_id, tag) VALUES (?1, ?2)`,
        ).bind(a.id, tag),
      );
    }
  }

  if (statements.length > 0) {
    await batchExec(env.DB, statements);
  }

  // Accumulate chunk stats into the scrape_runs row. Tokens from the
  // failed primary call (when the fallback was taken) count too — they
  // burned real budget even though their output was unusable — so we
  // add them to the reported totals. Both live and wasted counters
  // come from runJsonWithFallback (CF-009).
  const tokensIn = llmRun.tokensIn + wastedTokensIn;
  const tokensOut = llmRun.tokensOut + wastedTokensOut;
  // `modelUsed` is DEFAULT_MODEL_ID on the happy path, FALLBACK_MODEL_ID
  // when the fallback retry produced the output. Cost = winning attempt
  // + wasted primary attempt (zero on the happy path).
  const costUsd = llmRun.costUsd + wastedCostUsd;
  // Deduped count = input candidates that ended up collapsed into a
  // primary plus input candidates that were dropped entirely (e.g. zero
  // valid tags after validation).
  const articlesIngested = prepared.length;
  const articlesDeduped = body.candidates.length - articlesIngested;
  await addChunkStats(env.DB, body.scrape_run_id, {
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    estimated_cost_usd: costUsd,
    articles_ingested: articlesIngested,
    articles_deduped: articlesDeduped,
  });

  // Decrement the KV chunks_remaining counter. Last chunk closes the run.
  const counterKey = `scrape_run:${body.scrape_run_id}:chunks_remaining`;
  const raw = await env.KV.get(counterKey, 'text');
  const current = raw === null ? 0 : Math.max(0, parseInt(raw, 10) || 0);
  const next = Math.max(0, current - 1);
  await env.KV.put(counterKey, String(next), { expirationTtl: 3 * 3600 });
  if (next === 0) {
    await finishRun(env.DB, body.scrape_run_id, 'ready');
    // REQ-PIPE-008: kick off the cross-chunk semantic dedup pass. Articles
    // are already visible (run is `ready`) — finalize is a background
    // cleanup that may briefly leave duplicates in the feed.
    //
    // The KV counter clamps to 0 (line 570 above), which means a redelivered
    // last-chunk message would re-enter this branch and re-enqueue
    // SCRAPE_FINALIZE — every redelivery would burn another LLM call.
    // Gate the send on a separate KV "enqueued" flag; the merge SQL is
    // idempotent on retry but the LLM call is not.
    const enqueuedKey = `scrape_run:${body.scrape_run_id}:finalize_enqueued`;
    const alreadyEnqueued = await env.KV.get(enqueuedKey, 'text');
    if (alreadyEnqueued === null) {
      // Send first, then mark the gate. If `send()` throws on a transient
      // queue API failure, the gate is still null and the message retry
      // gets to try again. The narrow risk this leaves open is a duplicate
      // send if `send()` succeeded but the subsequent KV.put failed before
      // ack — that is far rarer and far cheaper than permanently losing
      // the finalize on a transient send hiccup.
      await env.SCRAPE_FINALIZE.send({ scrape_run_id: body.scrape_run_id });
      await env.KV.put(enqueuedKey, '1', { expirationTtl: 3 * 3600 });
    }
  }

  log('info', 'digest.generation', {
    status: 'chunk_ready',
    scrape_run_id: body.scrape_run_id,
    chunk_index: body.chunk_index,
    total_chunks: body.total_chunks,
    articles_ingested: articlesIngested,
    articles_deduped: articlesDeduped,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    estimated_cost_usd: costUsd,
    alignment_mode: useEchoedIndex ? 'echoed_index' : 'positional_fallback',
    articles_with_echoed_index: articlesWithEchoedIndex,
    duplicate_echoed_index: duplicateEchoedIndex,
    dropped_for_missing_alignment: droppedForMissingAlignment,
    dropped_for_title_mismatch: droppedForTitleMismatch,
  });

  // Suppress unused-variable warning for collapsedSet; kept for future
  // per-alternative source attribution refinements.
  void collapsedSet;
}

/** Very cheap token-overlap check for defense-in-depth against LLM
 * summaries that echo the correct candidate index but describe a
 * different candidate's story. Returns true when the two titles share
 * at least one non-trivial token (alnum, length ≥ 4, case-insensitive,
 * common English stopwords excluded). Returns true trivially when
 * either title is empty or very short (we only reject when BOTH titles
 * are substantial enough to compare meaningfully — never drop on a
 * short headline). */
function titlesShareAnyToken(a: string, b: string): boolean {
  const tokensA = tokenizeTitle(a);
  const tokensB = tokenizeTitle(b);
  // Be conservative: if either side has fewer than 2 meaningful tokens
  // the overlap signal is too noisy — accept rather than drop.
  if (tokensA.size < 2 || tokensB.size < 2) return true;
  for (const t of tokensA) {
    if (tokensB.has(t)) return true;
  }
  return false;
}

const TITLE_STOPWORDS = new Set([
  'the', 'that', 'this', 'with', 'from', 'into', 'over', 'your', 'their',
  'have', 'will', 'been', 'were', 'what', 'when', 'about', 'after',
  'announce', 'announces', 'announced', 'release', 'released', 'launches',
  'launch', 'update', 'updates', 'updated', 'says', 'said', 'introduces',
  'introduced', 'adds', 'added', 'gets', 'gains', 'makes', 'made',
  'using', 'uses', 'based', 'new', 'via', 'now', 'for', 'and',
]);

/** Extract meaningful tokens from a title for the overlap check:
 *  lowercase, alnum only, length ≥ 4, not in the small stopword list. */
function tokenizeTitle(title: string): Set<string> {
  const out = new Set<string>();
  const lowered = title.toLowerCase();
  const words = lowered.split(/[^a-z0-9]+/);
  for (const w of words) {
    if (w.length < 4) continue;
    if (TITLE_STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

/** Load the tag allowlist: DEFAULT_HASHTAGS ∪ any tag whose
 * `sources:{tag}` KV key exists. De-duplicated, lowercase, no leading `#`. */
async function loadAllowedTags(kv: KVNamespace): Promise<string[]> {
  const set = new Set<string>();
  for (const t of DEFAULT_HASHTAGS) set.add(t);
  // List up to 1000 keys matching `sources:*`. KV list pagination via
  // cursor is supported but the discovered-tag count is bounded by the
  // number of user-added tags across the deployment — practically <500.
  try {
    let cursor: string | undefined;
    do {
      const listResult: KVNamespaceListResult<unknown> = await kv.list({
        prefix: 'sources:',
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const key of listResult.keys) {
        const tag = key.name.slice('sources:'.length).toLowerCase();
        if (tag !== '') set.add(tag);
      }
      cursor = listResult.list_complete ? undefined : listResult.cursor;
    } while (cursor !== undefined);
  } catch {
    // KV list is best-effort; fall back to DEFAULT_HASHTAGS if the
    // binding misbehaves. A strict failure would block the chunk for no
    // strong reason.
  }
  return Array.from(set);
}

/** Validate + narrow the LLM payload to the chunk shape. Accepts the
 * parseLLMPayload output (which already verified `articles` is an
 * array) and additionally pulls out `dedup_groups` if present. */
function narrowChunkPayload(
  parsed: { articles?: unknown } | null,
  rawResponse: unknown,
): LLMChunkPayload | null {
  if (parsed === null) return null;
  const articles = parsed.articles;
  if (!Array.isArray(articles)) return null;
  // parseLLMPayload only surfaces `articles`; re-read the raw response
  // to pick up `dedup_groups` without re-parsing JSON twice.
  let dedupGroups: unknown = undefined;
  if (rawResponse !== null && typeof rawResponse === 'object') {
    dedupGroups = (rawResponse as Record<string, unknown>)['dedup_groups'];
  } else if (typeof rawResponse === 'string') {
    try {
      const reparsed = JSON.parse(rawResponse) as Record<string, unknown>;
      dedupGroups = reparsed['dedup_groups'];
    } catch {
      dedupGroups = undefined;
    }
  }
  return { articles: articles as LLMChunkArticle[], dedup_groups: dedupGroups };
}

/** Coerce an unknown dedup_groups payload into a clean `number[][]`. */
function normaliseDedupGroups(raw: unknown): number[][] {
  if (!Array.isArray(raw)) return [];
  const out: number[][] = [];
  for (const group of raw) {
    if (!Array.isArray(group)) continue;
    const indices: number[] = [];
    for (const v of group) {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
        indices.push(v);
      }
    }
    if (indices.length >= 2) out.push(indices);
  }
  return out;
}

/** For each merged cluster (in output order), pick the "anchor" input
 * index — the minimum index across the source clusters that were
 * merged. Non-merged clusters have an anchor equal to their own index. */
function buildAnchorIndices(
  perInputClusters: Cluster[],
  dedupGroups: number[][],
): number[] {
  const merged = new Set<number>();
  const anchorForMerged = new Map<number, number>();
  for (const group of dedupGroups) {
    const valid = group
      .filter(
        (i) =>
          Number.isInteger(i) && i >= 0 && i < perInputClusters.length,
      )
      .sort((a, b) => a - b);
    if (valid.length < 2) continue;
    const anchor = valid[0] ?? 0;
    for (const i of valid) {
      merged.add(i);
      anchorForMerged.set(anchor, anchor);
    }
  }
  const anchors: number[] = [];
  for (let i = 0; i < perInputClusters.length; i++) {
    if (anchorForMerged.has(i)) {
      anchors.push(i);
      continue;
    }
    if (merged.has(i)) continue; // collapsed into an earlier anchor
    anchors.push(i);
  }
  return anchors;
}

/** Track which input indices were collapsed into a merged cluster so
 * their candidate rows land in `article_sources` rather than creating
 * a new `articles` row. Returned for future per-alternative source
 * attribution; currently referenced via `void` to silence the linter. */
function buildCollapsedSet(
  inputCount: number,
  dedupGroups: number[][],
): Set<number> {
  const collapsed = new Set<number>();
  for (const group of dedupGroups) {
    const valid = group
      .filter((i) => Number.isInteger(i) && i >= 0 && i < inputCount)
      .sort((a, b) => a - b);
    if (valid.length < 2) continue;
    for (const i of valid.slice(1)) collapsed.add(i);
  }
  return collapsed;
}
