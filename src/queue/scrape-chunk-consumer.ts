// Implements REQ-PIPE-002
//
// Chunk consumer for the `scrape-chunks` Cloudflare Queue. Each message
// is one chunk of up to 100 canonical-deduped candidates produced by
// the hourly coordinator (REQ-PIPE-001). The consumer:
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
  extractResponsePayload,
  extractTokensIn,
  extractTokensOut,
  parseLLMPayload,
  sanitizeText,
} from '~/lib/generate';
import type { AIRunResponse } from '~/lib/generate';
import {
  clusterByCanonical,
  mergeClustersByLlmHints,
  type Candidate,
  type Cluster,
} from '~/lib/dedupe';
import { DEFAULT_HASHTAGS } from '~/lib/default-hashtags';
import { DEFAULT_MODEL_ID, estimateCost } from '~/lib/models';
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
        detail: String(err).slice(0, 500),
      });
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

  // Build candidates in the LLM-expected shape. Order is preserved so
  // output array indices line up with input indices for cluster + dedup
  // lookups.
  const promptCandidates = body.candidates.map((c, idx) => {
    const base = {
      index: idx,
      title: c.title,
      url: c.source_url,
      source_name: c.source_name,
      published_at: c.published_at,
    };
    if (typeof c.body_snippet === 'string' && c.body_snippet !== '') {
      return { ...base, body_snippet: c.body_snippet };
    }
    return base;
  });

  // Call Workers AI. A transient model error throws up to the handler
  // so the queue retries; parse errors below are also thrown so the
  // queue can replay on a flaky JSON response.
  const ai = env.AI as unknown as {
    run: (model: string, params: Record<string, unknown>) => Promise<AIRunResponse>;
  };
  const aiResult = await ai.run(DEFAULT_MODEL_ID, {
    messages: [
      { role: 'system', content: PROCESS_CHUNK_SYSTEM },
      { role: 'user', content: processChunkUserPrompt(promptCandidates, allowedTags) },
    ],
    ...LLM_PARAMS,
  });

  const rawResponse = extractResponsePayload(aiResult);
  const parsedDigestShape = parseLLMPayload(rawResponse);
  // parseLLMPayload asserts {articles: [...]}. For the chunk pipeline
  // we also want the optional `dedup_groups` field — re-narrow here.
  const parsed = narrowChunkPayload(parsedDigestShape, rawResponse);
  if (parsed === null) {
    log('warn', 'digest.generation', {
      status: 'chunk_invalid_json',
      scrape_run_id: body.scrape_run_id,
      chunk_index: body.chunk_index,
    });
    throw new Error('chunk_invalid_json');
  }

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
  let clusterCursor = 0;
  for (const merged of mergedClusters) {
    const anchor = anchorByCluster[clusterCursor] ?? 0;
    clusterCursor++;
    const llmArticle = rawArticles[anchor];
    if (llmArticle === undefined) continue;
    survivors.push({ cluster: merged, articleIdx: anchor, llmArticle });
  }

  // Sanitize + validate each surviving article. Articles with zero
  // allowed tags after validation are dropped.
  interface PreparedArticle {
    id: string;
    canonical_url: string;
    title: string;
    details: string;
    tags: string[];
    primary_source_url: string;
    primary_source_name: string;
    alternatives: Array<{ source_url: string; source_name: string }>;
    published_at: number;
  }
  const prepared: PreparedArticle[] = [];
  for (const s of survivors) {
    const title = sanitizeText(s.llmArticle.title);
    const details = sanitizeText(s.llmArticle.details);
    if (title === '' || details === '') continue;

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
  // one per tag. D1 handles ordering + rollback.
  const statements: D1PreparedStatement[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  for (const a of prepared) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO articles
           (id, canonical_url, title, details, primary_source_url, primary_source_name, published_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(
        a.id,
        a.canonical_url,
        a.title,
        a.details,
        a.primary_source_url,
        a.primary_source_name,
        a.published_at,
        nowSec,
      ),
    );
    for (const alt of a.alternatives) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO article_sources (article_id, source_url, source_name)
           VALUES (?1, ?2, ?3)`,
        ).bind(a.id, alt.source_url, alt.source_name),
      );
    }
    for (const tag of a.tags) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO article_tags (article_id, tag) VALUES (?1, ?2)`,
        ).bind(a.id, tag),
      );
    }
  }

  if (statements.length > 0) {
    await batchExec(env.DB, statements);
  }

  // Accumulate chunk stats into the scrape_runs row.
  const tokensIn = extractTokensIn(aiResult);
  const tokensOut = extractTokensOut(aiResult);
  const costUsd = estimateCost(DEFAULT_MODEL_ID, tokensIn, tokensOut);
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
  });

  // Suppress unused-variable warning for collapsedSet; kept for future
  // per-alternative source attribution refinements.
  void collapsedSet;
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
