// Implements REQ-PIPE-002
// Implements REQ-PIPE-003 (per-article embedding + Vectorize upsert)
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
//   4. Defensively normalises any `dedup_groups` field the model may
//      still emit (the prompt no longer asks for it as of 2026-05-06 —
//      cross-source dedup runs in the finalize pass with full-corpus
//      visibility, so a single chunk's view is too narrow to make the
//      call). normaliseRawDedupGroups returns [] for missing fields,
//      so the merger is effectively a no-op and every input candidate
//      keeps its own row.
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
  CHUNK_LLM_PARAMS,
  processChunkUserPrompt,
} from '~/lib/prompts';
import {
  parseLLMPayload,
  sanitizeText,
} from '~/lib/generate';
import {
  mergeClustersByLlmHints,
  normaliseRawDedupGroups,
  type Candidate,
  type Cluster,
} from '~/lib/dedupe';
import { fetchArticleBodies } from '~/lib/article-fetch';
import { DEFAULT_HASHTAGS } from '~/lib/default-hashtags';
import { normalizeHashtag } from '~/lib/hashtags';
import { splitIntoParagraphs } from '~/lib/paragraph-split';
import { runJson, previewRawResponse, asAiBinding } from '~/lib/llm-json';
import { addChunkStats, finishRun } from '~/lib/scrape-run';
import { recordChunkCompletion, countChunkCompletions } from '~/lib/articles-repo';
import { generateUlid } from '~/lib/ulid';
import { applyForeignKeysPragma } from '~/lib/db';
import { log } from '~/lib/log';
import { titlesShareAnyToken } from '~/lib/title-overlap';
import { handleBatch } from '~/lib/queue-handler';
import { setChunksRemaining } from '~/lib/kv/chunks-remaining';
import { buildEmbeddingInput, embedTexts } from '~/lib/embeddings';

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

/** Handle one batch of `scrape-chunks` messages. Delegates the per-
 * message try/ack/retry/terminal-failure pattern to the shared
 * `handleBatch` envelope. */
export async function handleChunkBatch(
  batch: MessageBatch<ChunkJobMessage>,
  env: Env,
): Promise<void> {
  await handleBatch(batch, env, {
    process: processOneChunk,
    throwLogStatus: 'chunk_consumer_throw',
    extraLogFields: (body) => ({
      scrape_run_id: body.scrape_run_id,
      chunk_index: body.chunk_index,
    }),
    onTerminalFailure: async (env, body) => {
      // On final retry, decide whether the run is genuinely failed or
      // partially successful. If at least one sibling chunk has
      // completed for this run, the run already has user-visible
      // articles — flapping the status to 'failed' would hide them
      // from the digest. Mark partial successes as 'ready' (so the
      // articles surface) and reserve 'failed' for runs where no
      // chunk completed at all.
      //
      // Without this branch a single chunk hitting `AiError: 3046:
      // Request timeout` after max-retries would mark the entire run
      // failed even though the other chunks ingested articles, which
      // we hit on 2026-05-05 (chunks 0+2 ingested 5 articles, chunk 1
      // timed out, run.status flipped to 'failed').
      const completed = await countChunkCompletions(env.DB, body.scrape_run_id);
      const finalStatus: 'ready' | 'failed' = completed > 0 ? 'ready' : 'failed';
      await finishRun(env.DB, body.scrape_run_id, finalStatus);
      if (finalStatus === 'ready') {
        // Enqueue finalize so cross-chunk dedup runs over the chunks
        // that did complete. Same atomic-lock pattern as the
        // happy-path enqueue in `recordChunkCompletionAndCheckFinalize`.
        const lockResult = await env.DB
          .prepare(
            'UPDATE scrape_runs SET finalize_enqueued = 1 WHERE id = ?1 AND finalize_enqueued = 0',
          )
          .bind(body.scrape_run_id)
          .run();
        if ((lockResult.meta?.changes ?? 0) === 1) {
          try {
            await env.SCRAPE_FINALIZE.send({ scrape_run_id: body.scrape_run_id });
          } catch (sendErr) {
            await env.DB
              .prepare(
                'UPDATE scrape_runs SET finalize_enqueued = 0 WHERE id = ?1',
              )
              .bind(body.scrape_run_id)
              .run()
              .catch(() => {});
            log('error', 'digest.generation', {
              status: 'partial_finalize_enqueue_failed',
              scrape_run_id: body.scrape_run_id,
              chunk_index: body.chunk_index,
              detail: String(sendErr).slice(0, 500),
            });
          }
        }
      }
    },
    terminalFailureLogStatus: 'chunk_finish_failed_after_throw',
  });
}

/** Aligned LLM output for one input cluster, ready for validation. */
interface Survivor {
  cluster: Cluster;
  articleIdx: number;
  llmArticle: LLMChunkArticle;
}

/** Validated, sanitised article ready to be written to D1. */
interface PreparedArticle {
  id: string;
  canonical_url: string;
  title: string;
  details: string[];
  tags: string[];
  primary_source_url: string;
  primary_source_name: string;
  alternatives: Array<{ source_url: string; source_name: string }>;
  published_at: number;
  /** Per-article embedding lifecycle state set after embedTexts.
   *  `embedded` — vector present in `embedding`, will be upserted to
   *  Vectorize after the D1 batch succeeds.
   *  `failed`   — embed call threw or returned a malformed payload;
   *  the article still ships, the admin embed-backfill route picks
   *  it up later. */
  embedding_status: 'embedded' | 'failed';
  embedded_at: number | null;
  /** 768-dim cosine vector when `embedding_status === 'embedded'`,
   *  otherwise null. */
  embedding: number[] | null;
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

  // Fetch article bodies; build prompt-ready candidates.
  const { promptCandidates } = await fetchAndBuildPromptCandidates(env, body);

  // LLM call (single-model; throws on parse failure for queue retry).
  const { llmRun, rawArticles, dedupGroups } = await runChunkLLM(
    env,
    body,
    promptCandidates,
    allowedTags,
  );

  // Build per-input singleton clusters, then merge by LLM dedup hints.
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
  const mergedClusters = mergeClustersByLlmHints(perInputClusters, dedupGroups);

  // Align LLM output to input candidates by echoed index (with positional fallback).
  const {
    survivors,
    articlesWithEchoedIndex,
    duplicateEchoedIndex,
    droppedForMissingAlignment,
    droppedForTitleMismatch,
    useEchoedIndex,
  } = alignLlmArticlesToInputs(rawArticles, perInputClusters, mergedClusters, dedupGroups, body);

  // Validate + sanitize each survivor; drop articles that fail any gate.
  const prepared: PreparedArticle[] = [];
  for (const s of survivors) {
    const article = validateAndSanitizeArticle(s, allowedTagSet, body);
    if (article !== null) prepared.push(article);
  }

  // Embed each prepared article. On success, articles carry their
  // 768-dim vector + `embedding_status='embedded'` into D1; on
  // failure, articles stay at the validateAndSanitizeArticle default
  // ('failed', null vector) and the admin backfill route picks them
  // up later. REQ-PIPE-003.
  await attachEmbeddings(env, prepared, body);

  // Write articles + sources + tags in a single atomic D1 batch.
  const statements = buildArticleBatchStatements(env.DB, prepared, body.scrape_run_id);
  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  // Vectorize.upsert runs AFTER the D1 batch lands, so a failed upsert
  // never strands articles in Vectorize without a D1 row backing them.
  // The other failure direction — D1 written but Vectorize upsert
  // throws — is handled by reverting affected rows to
  // `embedding_status='failed'` so the backfill route reattempts. The
  // article itself is real and visible regardless. REQ-PIPE-003.
  await upsertVectors(env, prepared, body);

  // Record completion + conditionally enqueue finalize.
  const {
    isFirstCompletion,
    completedCount,
  } = await recordChunkCompletionAndCheckFinalize(env, body);

  const tokensIn = llmRun.tokensIn;
  const tokensOut = llmRun.tokensOut;
  const costUsd = llmRun.costUsd;
  const articlesIngested = prepared.length;
  const articlesDeduped = body.candidates.length - articlesIngested;

  if (isFirstCompletion) {
    await addChunkStats(env.DB, body.scrape_run_id, {
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      estimated_cost_usd: costUsd,
      articles_ingested: articlesIngested,
      articles_deduped: articlesDeduped,
    });
  }

  // Keep the legacy KV counter in sync for /api/scrape-status.
  const remaining = Math.max(0, body.total_chunks - completedCount);
  await setChunksRemaining(env.KV, body.scrape_run_id, remaining);

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
}

// ---------- step helpers (colocated; not re-exported) ---------------------

/**
 * Fetch article bodies for thin-snippet candidates, then build the
 * prompt-ready candidate array.
 *
 * Happens inside the chunk consumer (not the coordinator) so the
 * coordinator's execution budget is not blown by 500+ HTTP fetches before
 * it can enqueue chunks. Each chunk only fetches its own ~100 URLs.
 */
/** Shape of one candidate after the body-fetch pass; matches the
 *  `processChunkUserPrompt` parameter so the prompt builder can be
 *  invoked without a cast. */
interface PromptCandidate {
  index: number;
  title: string;
  url: string;
  source_name: string;
  published_at: number;
  body_snippet?: string;
}

/** Minimum snippet length the chunk consumer treats as "already
 *  fetched". Below this, the consumer issues its own body fetch.
 *  Exported so the coordinator's chunk packer
 *  (`packCandidatesIntoChunks` in scrape-coordinator.ts) can size
 *  thin-snippet candidates by the same threshold instead of
 *  duplicating the literal 400 across module boundaries. */
export const SNIPPET_FLOOR = 400;

async function fetchAndBuildPromptCandidates(
  env: Env,
  body: ChunkJobMessage,
): Promise<{ promptCandidates: PromptCandidate[] }> {
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

  const noSnippetCount = promptCandidates.filter(
    (p) => !('body_snippet' in p) || (p as { body_snippet?: string }).body_snippet === undefined || (p as { body_snippet?: string }).body_snippet === '',
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

  return { promptCandidates };
}

/**
 * Run the LLM call (single model) for a chunk.
 *
 * Throws `Error('chunk_invalid_json')` when the model fails to produce
 * valid JSON — this tells the queue handler to retry the chunk message.
 * Returns the successful run result plus the parsed articles and dedup groups.
 */
async function runChunkLLM(
  env: Env,
  body: ChunkJobMessage,
  promptCandidates: PromptCandidate[],
  allowedTags: string[],
): Promise<{
  // Narrow to the `ok: true` branch — the helper throws on the
  // `ok: false` path so the caller never receives a failure value.
  // Without this Extract, TypeScript leaves `llmRun` as the full
  // discriminated union and access to `tokensIn`/`tokensOut`/`costUsd`
  // at the call site triggers a TS2339 error on the never-reachable
  // failure branch.
  llmRun: Extract<
    Awaited<ReturnType<typeof runJson<LLMChunkPayload>>>,
    { ok: true }
  >;
  rawArticles: LLMChunkArticle[];
  dedupGroups: number[][];
}> {
  const llmRun = await runJson<LLMChunkPayload>({
    ai: asAiBinding(env.AI),
    params: {
      messages: [
        { role: 'system', content: PROCESS_CHUNK_SYSTEM },
        { role: 'user', content: processChunkUserPrompt(promptCandidates, allowedTags) },
      ],
      ...CHUNK_LLM_PARAMS,
    },
    narrow: (raw) => narrowChunkPayload(parseLLMPayload(raw), raw),
  });

  if (!llmRun.ok) {
    log('warn', 'digest.generation', {
      status: 'chunk_invalid_json',
      scrape_run_id: body.scrape_run_id,
      chunk_index: body.chunk_index,
      model_used: llmRun.attempt.modelUsed,
      tokens_in: llmRun.attempt.tokensIn,
      tokens_out: llmRun.attempt.tokensOut,
      response_preview: previewRawResponse(llmRun.attempt.rawResponse),
    });
    throw new Error('chunk_invalid_json');
  }

  const rawArticles = Array.isArray(llmRun.parsed.articles) ? llmRun.parsed.articles : [];
  const dedupGroups = normaliseRawDedupGroups(llmRun.parsed.dedup_groups);
  return { llmRun, rawArticles, dedupGroups };
}

/**
 * Align LLM output articles to input clusters.
 *
 * Prefers echoed `index` fields when the model adopted the contract (majority
 * of articles echo a valid index); falls back to positional alignment for
 * legacy model behaviour. Drops articles whose LLM title shares no non-trivial
 * token with the source candidate title (cross-wires defence-in-depth).
 *
 * CF-026: uses a single `Map<number, LLMChunkArticle>` (`articleByIndex`) as
 * the canonical lookup regardless of alignment mode — positional fallback
 * populates the same map from rawArticles before the merge pass.
 */
function alignLlmArticlesToInputs(
  rawArticles: LLMChunkArticle[],
  perInputClusters: Cluster[],
  mergedClusters: Cluster[],
  dedupGroups: number[][],
  body: ChunkJobMessage,
): {
  survivors: Survivor[];
  articlesWithEchoedIndex: number;
  duplicateEchoedIndex: number;
  droppedForMissingAlignment: number;
  droppedForTitleMismatch: number;
  useEchoedIndex: boolean;
} {
  // Build the echoed-index map first.
  // CF-047: track articles that carry an EXPLICIT but invalid index
  // (out-of-bounds or null). Those are excluded from positional fallback —
  // the model deliberately emitted a bad index, which is a different
  // signal from "the model emitted no index at all". Positional fallback
  // is only for articles with index === undefined (model omitted the field).
  const articleByIndex = new Map<number, LLMChunkArticle>();
  const explicitlyInvalid = new Set<number>(); // raw-article positions
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
    } else if (echoed !== undefined) {
      // Explicit but invalid index (null, out-of-bounds integer, string,
      // non-integer): mark position so positional fallback skips it.
      explicitlyInvalid.add(i);
    }
  }
  // Use echoed-index lookup only when the model demonstrably adopted the
  // contract on this chunk. A single echoed entry out of 50 is likely a
  // fluke — falling into strict mode there would drop the other 49
  // positionally-aligned articles.
  const useEchoedIndex =
    articlesWithEchoedIndex >= 3 ||
    (rawArticles.length > 0 &&
      articlesWithEchoedIndex * 2 >= rawArticles.length);

  // CF-026: for positional fallback, populate the SAME map from rawArticles
  // so the merge pass always reads from articleByIndex regardless of mode.
  // CF-047: skip articles with explicitly invalid indices — they had a bad
  // index value (null / out-of-bounds), not a missing one.
  if (!useEchoedIndex) {
    for (let i = 0; i < rawArticles.length; i++) {
      if (explicitlyInvalid.has(i)) continue;
      const art = rawArticles[i];
      if (art !== undefined && !articleByIndex.has(i)) {
        articleByIndex.set(i, art);
      }
    }
  }

  const anchorByCluster = buildAnchorIndices(perInputClusters, dedupGroups);
  const survivors: Survivor[] = [];
  let droppedForMissingAlignment = 0;
  let droppedForTitleMismatch = 0;

  let clusterCursor = 0;
  for (const merged of mergedClusters) {
    const anchor = anchorByCluster[clusterCursor] ?? 0;
    clusterCursor++;
    const llmArticle = articleByIndex.get(anchor);
    if (llmArticle === undefined) {
      droppedForMissingAlignment += 1;
      continue;
    }
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

  return {
    survivors,
    articlesWithEchoedIndex,
    duplicateEchoedIndex,
    droppedForMissingAlignment,
    droppedForTitleMismatch,
    useEchoedIndex,
  };
}

/**
 * Validate and sanitize one surviving article.
 *
 * Returns `null` when any gate fails (title empty, details empty, word count
 * below floor, title length outside range, or zero allowed tags after
 * filtering). Callers should skip `null` returns.
 */
function validateAndSanitizeArticle(
  s: Survivor,
  allowedTagSet: Set<string>,
  body: ChunkJobMessage,
): PreparedArticle | null {
  const title = sanitizeText(s.llmArticle.title);
  const detailsRaw = s.llmArticle.details;
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
  if (title === '' || details.length === 0) return null;

  // REQ-PIPE-002 AC3: enforce 80-word backstop floor server-side. The
  // prompt's contract is 100-150 words; the floor catches genuinely
  // truncated outputs (single-paragraph 30-word stubs) without
  // rejecting the model's natural lower-end distribution. CF-030
  // originally set this to 120 but Workers AI models regularly
  // produce 90-120-word summaries when the source snippet is thin,
  // so a strict 100 cut would drop legitimate output. 80 is a true
  // sanity floor; the 100-word target stays in the prompt as the
  // contract.
  const wordCount = details.join(' ').trim().split(/\s+/).filter((w) => w !== '').length;
  if (wordCount < 80) {
    log('warn', 'digest.generation', {
      status: 'chunk_article_dropped_word_count',
      scrape_run_id: body.scrape_run_id,
      chunk_index: body.chunk_index,
      word_count: wordCount,
      llm_title: title.slice(0, 120),
    });
    return null;
  }

  // REQ-PIPE-002 AC2: sanity-range for headline length.
  if (title.length < 5 || title.length > 500) {
    log('warn', 'digest.generation', {
      status: 'chunk_article_dropped_title_length',
      scrape_run_id: body.scrape_run_id,
      chunk_index: body.chunk_index,
      title_length: title.length,
      llm_title: title.slice(0, 120),
    });
    return null;
  }

  const llmTags = Array.isArray(s.llmArticle.tags) ? s.llmArticle.tags : [];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const t of llmTags) {
    if (typeof t !== 'string') continue;
    const normalised = normalizeHashtag(t.trim());
    if (normalised === '' || seen.has(normalised)) continue;
    if (!allowedTagSet.has(normalised)) continue;
    seen.add(normalised);
    tags.push(normalised);
  }
  if (tags.length === 0) return null;

  const primary = s.cluster.primary;
  return {
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
    // Embedding lifecycle defaults — `attachEmbeddings` overwrites
    // these post-embed. Default 'failed' so a thrown embed call leaves
    // the article in a state the backfill route can pick up.
    embedding_status: 'failed',
    embedded_at: null,
    embedding: null,
  };
}

/**
 * Build the D1 batch statements for articles, alt-sources, and tags.
 *
 * Column list mirrors migrations/0003_global_feed.sql exactly.
 * details_json / tags_json are JSON arrays; ingested_at stamps row
 * creation; scrape_run_id is the parent run attribution.
 */
function buildArticleBatchStatements(
  db: D1Database,
  prepared: PreparedArticle[],
  scrape_run_id: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  for (const a of prepared) {
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO articles
           (id, canonical_url, primary_source_name, primary_source_url,
            title, details_json, tags_json, published_at, ingested_at,
            scrape_run_id, embedding_status, embedded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
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
        scrape_run_id,
        a.embedding_status,
        a.embedded_at,
      ),
    );
    for (const alt of a.alternatives) {
      statements.push(
        db.prepare(
          `INSERT OR IGNORE INTO article_sources
             (article_id, source_name, source_url, published_at)
           VALUES (?1, ?2, ?3, ?4)`,
        ).bind(a.id, alt.source_name, alt.source_url, a.published_at),
      );
    }
    for (const tag of a.tags) {
      statements.push(
        db.prepare(
          `INSERT OR IGNORE INTO article_tags (article_id, tag) VALUES (?1, ?2)`,
        ).bind(a.id, tag),
      );
    }
  }
  return statements;
}

/**
 * Record chunk completion (idempotent via INSERT OR IGNORE) and, if this
 * is the last chunk, atomically claim the finalize-enqueue slot and kick
 * off SCRAPE_FINALIZE.
 *
 * Returns `{ isFirstCompletion, completedCount }` so the caller can gate
 * additive stat updates on `isFirstCompletion`.
 *
 * CF-002: the finalize gate uses a conditional UPDATE on `finalize_enqueued`
 * so only one concurrent last-chunk consumer triggers the finalize pass.
 */
async function recordChunkCompletionAndCheckFinalize(
  env: Env,
  body: ChunkJobMessage,
): Promise<{ isFirstCompletion: boolean; completedCount: number }> {
  const isFirstCompletion = await recordChunkCompletion(
    env.DB,
    body.scrape_run_id,
    body.chunk_index,
  );

  const completedCount = await countChunkCompletions(env.DB, body.scrape_run_id);

  if (completedCount >= body.total_chunks) {
    await finishRun(env.DB, body.scrape_run_id, 'ready');
    // REQ-PIPE-008: kick off cross-chunk semantic dedup. Articles are already
    // visible (run is ready) — finalize is a background cleanup that may
    // briefly leave duplicates in the feed.
    //
    // CF-002 follow-up: conditional UPDATE is atomic in D1 — only the consumer
    // whose statement bumps finalize_enqueued from 0 to 1 sees changes === 1
    // and enqueues the finalize message. Every other concurrent or redelivered
    // consumer short-circuits.
    const lockResult = await env.DB
      .prepare(
        'UPDATE scrape_runs SET finalize_enqueued = 1 WHERE id = ?1 AND finalize_enqueued = 0',
      )
      .bind(body.scrape_run_id)
      .run();
    const wonFinalizeRace = (lockResult.meta?.changes ?? 0) === 1;
    if (wonFinalizeRace) {
      try {
        await env.SCRAPE_FINALIZE.send({ scrape_run_id: body.scrape_run_id });
      } catch (sendErr) {
        // Roll back the lock so queue redelivery can re-attempt the send.
        // Without this, a transient send failure marks finalize_enqueued = 1
        // forever and the finalize message is lost.
        try {
          await env.DB
            .prepare(
              'UPDATE scrape_runs SET finalize_enqueued = 0 WHERE id = ?1',
            )
            .bind(body.scrape_run_id)
            .run();
        } catch (rollbackErr) {
          log('error', 'digest.generation', {
            status: 'finalize_lock_rollback_failed',
            scrape_run_id: body.scrape_run_id,
            send_error: String(sendErr).slice(0, 500),
            rollback_error: String(rollbackErr).slice(0, 500),
          });
        }
        throw sendErr;
      }
    }
  }

  return { isFirstCompletion, completedCount };
}

// titlesShareAnyToken / tokenizeTitle moved to ~/lib/title-overlap (CF-058).

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
  } catch (err) {
    // KV list is best-effort; fall back to DEFAULT_HASHTAGS if the
    // binding misbehaves. A strict failure would block the chunk for no
    // strong reason. CF-056: surface the failure in logs so silent
    // degradation is observable.
    log('warn', 'digest.generation', {
      status: 'allowed_tags.list_failed',
      error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    });
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

/**
 * Embed every prepared article in one Workers AI call. On success
 * each article carries its 768-dim vector + embedded_at timestamp;
 * on failure every article in the batch flips to
 * `embedding_status='failed'` (the validateAndSanitizeArticle default
 * — re-asserted defensively here in case a future change shifts the
 * default). Errors are logged and swallowed: the article batch still
 * lands in D1 and the admin embed-backfill route reattempts.
 */
async function attachEmbeddings(
  env: Env,
  prepared: PreparedArticle[],
  body: ChunkJobMessage,
): Promise<void> {
  if (prepared.length === 0) return;
  const inputs = prepared.map((a) =>
    buildEmbeddingInput({
      title: a.title,
      details_json: JSON.stringify(a.details),
    }),
  );
  try {
    const vectors = await embedTexts(env.AI, inputs);
    if (vectors.length !== prepared.length) {
      throw new Error(
        `attachEmbeddings: vector count ${vectors.length} != article count ${prepared.length}`,
      );
    }
    const nowSec = Math.floor(Date.now() / 1000);
    for (let i = 0; i < prepared.length; i++) {
      const article = prepared[i];
      const vector = vectors[i];
      if (article === undefined || vector === undefined) continue;
      article.embedding_status = 'embedded';
      article.embedded_at = nowSec;
      article.embedding = vector;
    }
  } catch (err) {
    for (const article of prepared) {
      article.embedding_status = 'failed';
      article.embedded_at = null;
      article.embedding = null;
    }
    log('warn', 'digest.generation', {
      status: 'chunk_embed_failed',
      scrape_run_id: body.scrape_run_id,
      chunk_index: body.chunk_index,
      article_count: prepared.length,
      detail: String(err).slice(0, 500),
    });
  }
}

/**
 * Upsert every successfully-embedded article's vector into Vectorize.
 * Runs AFTER the D1 batch lands so a failed upsert can be reverted by
 * downgrading the affected rows' embedding_status to 'failed' (the
 * articles themselves stay visible). Vectorize.upsert is idempotent
 * on (id, vector) pairs — a queue-redelivered chunk re-upserts the
 * same vectors and the index converges.
 *
 * Vectors are tagged with `published_at` and `primary_source_url` in
 * metadata so the finalize-consumer query can filter on age (older
 * articles win in semantic dedup) without re-reading D1.
 */
async function upsertVectors(
  env: Env,
  prepared: PreparedArticle[],
  body: ChunkJobMessage,
): Promise<void> {
  const embedded = prepared.filter(
    (a): a is PreparedArticle & { embedding: number[] } =>
      a.embedding !== null && a.embedding_status === 'embedded',
  );
  if (embedded.length === 0) return;
  try {
    await env.VECTORIZE.upsert(
      embedded.map((a) => ({
        id: a.id,
        values: a.embedding,
        metadata: {
          published_at: a.published_at,
          primary_source_url: a.primary_source_url,
        },
      })),
    );
    log('info', 'digest.generation', {
      status: 'chunk_vectorize_upsert',
      scrape_run_id: body.scrape_run_id,
      chunk_index: body.chunk_index,
      vectors_upserted: embedded.length,
    });
  } catch (err) {
    // Downgrade affected rows so the backfill route picks them up.
    // Use a single UPDATE…IN(…) batch so the failure mode is bounded.
    log('error', 'digest.generation', {
      status: 'chunk_vectorize_upsert_failed',
      scrape_run_id: body.scrape_run_id,
      chunk_index: body.chunk_index,
      vector_count: embedded.length,
      detail: String(err).slice(0, 500),
    });
    try {
      // Gate the rollback so a queue redelivery whose first attempt
      // already succeeded (rows committed with 'embedded' + vectors
      // upserted) does NOT downgrade those rows back to 'failed' if
      // a later attempt's upsert hits a transient Vectorize outage.
      // Without this gate the finalize pass's `embedded`-only filter
      // would silently drop the affected articles from this tick's
      // dedup, and the admin backfill route would re-do work that
      // was already correct.
      const placeholders = embedded.map((_, i) => `?${i + 1}`).join(',');
      await env.DB
        .prepare(
          `UPDATE articles
              SET embedding_status = 'failed', embedded_at = NULL
            WHERE id IN (${placeholders})
              AND embedding_status != 'embedded'`,
        )
        .bind(...embedded.map((a) => a.id))
        .run();
    } catch (rollbackErr) {
      log('error', 'digest.generation', {
        status: 'chunk_vectorize_status_rollback_failed',
        scrape_run_id: body.scrape_run_id,
        chunk_index: body.chunk_index,
        detail: String(rollbackErr).slice(0, 500),
      });
    }
  }
}

