// Implements REQ-PIPE-003 AC 9
// Implements REQ-PIPE-009
//
// Pure helper for one batch of the historical same-story sweep,
// extracted so both the synchronous admin endpoint
// (`/api/admin/historical-dedup` for backwards-compat scripted
// callers) and the queue-driven self-chaining consumer
// (`src/queue/dedup-sweep-consumer.ts`) can call the same body.
// Walks already-embedded articles oldest-first and merges any newer
// near-duplicates into them as alt-sources via {@link mergeAsAltSource}.
//
// The cursor is composite: (`published_at`, `id`). A single
// `published_at` cursor was insufficient because the corpus has many
// articles per second (one scrape tick lands several at the same
// epoch second); the secondary `id` key extends the resume predicate
// to `(pa > ?1) OR (pa = ?1 AND id > ?2)` so equal-time pairs are
// re-visited across batches AND so the strict-greater filter inside
// the loop can apply a deterministic tie-break (lower ULID = older =
// wins) instead of silently dropping equal-time same-story pairs.

import { log } from '~/lib/log';
import { mergeAsAltSource } from '~/lib/finalize-merge';
import {
  readCosineThreshold,
  readHighConfidenceCosine,
  readSameVendorPenalty,
  readTimeWindowSeconds,
  deleteVectorsBatched,
} from '~/lib/embeddings';
import { readRerankFloor, rerankBorderlinePair } from '~/lib/dedup-rerank';
import { sameVendor } from '~/lib/etld';

/** Default articles scanned per call when the caller omits `batch`.
 *  Sized so a single batch's worst-case (25 × Vectorize.queryById +
 *  up to 25 × topK LLM reranks at p99 ~1.5s each) stays well within
 *  the queue consumer's 15-minute wall-clock budget. The queue-driven
 *  sweep drives many short batches via continuation messages. */
export const DEFAULT_BATCH = 25;

/** Hard cap so a malformed `batch: 99999` doesn't blow the isolate
 *  budget. */
export const MAX_BATCH = 500;


/** TopK for each Vectorize query. Bumped from 5 to 20 on 2026-05-09
 *  (AD40) — same reasoning as `scrape-finalize-consumer.ts`: the AD39
 *  threshold raise widened the rerank band to 18 cosine points, and 5
 *  nearest neighbours can be consumed by topical noise above 0.80 in
 *  dense theme periods. 20 is cheap and covers realistic cluster
 *  sizes. */
const VECTORIZE_TOPK = 20;

interface ArticleRow {
  id: string;
  title: string;
  source_snippet: string | null;
  published_at: number;
  primary_source_url: string;
}

/** Composite cursor — `published_at` alone is insufficient because the
 *  corpus has many articles per second (one scrape tick can land
 *  several at the exact same epoch second). The previous single-value
 *  cursor advanced via strict `published_at > ?` and lost any
 *  same-second tail past the batch boundary; the secondary `id` key
 *  closes that gap by extending the resume predicate to
 *  `(pa > ?1) OR (pa = ?1 AND id > ?2)`. */
export interface DedupCursor {
  pa: number;
  id: string;
}

export interface DedupBatchResult {
  ok: true;
  scanned: number;
  merged: number;
  next_cursor: DedupCursor | null;
  remaining: number;
  done: boolean;
}

/** Run exactly one bounded batch of the sweep. Caller threads
 *  `cursor` from the previous result. Returns `done: true` and
 *  `next_cursor: null` when the cursor is past the corpus tail. */
export async function runHistoricalDedupBatch(
  env: Env,
  cursor: DedupCursor | null,
  batch: number,
): Promise<DedupBatchResult> {
  const threshold = readCosineThreshold(env);
  const sameVendorPenalty = readSameVendorPenalty(env);
  const rerankFloor = readRerankFloor(env);
  const timeWindowSeconds = readTimeWindowSeconds(env);
  const highConfidenceCosine = readHighConfidenceCosine(env);

  // Walk articles by ascending (published_at, id), starting strictly
  // after the supplied composite cursor (or from the beginning when
  // null). Only already-embedded articles participate — un-embedded
  // articles need the embed-backfill route first. The composite
  // resume predicate (`pa > ?1` OR `pa = ?1 AND id > ?2`) ensures
  // equal-time pairs that straddle a batch boundary are still picked
  // up on the next call instead of being silently dropped by the
  // strict-greater filter.
  const cursorPaBind = cursor?.pa ?? -1;
  const cursorIdBind = cursor?.id ?? '';
  const result = await env.DB
    .prepare(
      `SELECT id, title, source_snippet, published_at, primary_source_url
         FROM articles
        WHERE embedding_status = 'embedded'
          AND (
            published_at > ?1
            OR (published_at = ?1 AND id > ?2)
          )
        ORDER BY published_at ASC, id ASC
        LIMIT ?3`,
    )
    .bind(cursorPaBind, cursorIdBind, batch)
    .all<ArticleRow>();
  const rows = result.results ?? [];

  if (rows.length === 0) {
    return {
      ok: true,
      scanned: 0,
      merged: 0,
      next_cursor: null,
      remaining: 0,
      done: true,
    };
  }

  const removedIds = new Set<string>();
  let merged = 0;
  let rerankCallsThisBatch = 0;
  let rerankAccepts = 0;

  for (const self of rows) {
    if (removedIds.has(self.id)) continue;

    let queryResult: VectorizeMatches;
    try {
      queryResult = await env.VECTORIZE.queryById(self.id, {
        topK: VECTORIZE_TOPK,
        returnMetadata: 'all',
      });
    } catch (err) {
      log('warn', 'digest.generation', {
        status: 'historical_dedup_query_failed',
        article_id: self.id,
        detail: String(err).slice(0, 500),
      });
      continue;
    }

    const matches = queryResult.matches ?? [];
    for (const match of matches) {
      if (match.id === self.id) continue;
      if (removedIds.has(match.id)) continue;
      const meta = match.metadata as
        | { published_at?: unknown; primary_source_url?: unknown }
        | undefined;
      const matchPublishedAt =
        typeof meta?.published_at === 'number' ? meta.published_at : null;
      if (matchPublishedAt === null) continue;
      // Hard time-window gate — pairs published further apart than the
      // configured window are not the same news event regardless of
      // cosine. Cuts dense-theme false-merges from cross-news-cycle
      // matches (REQ-PIPE-003).
      const deltaSeconds = Math.abs(self.published_at - matchPublishedAt);
      if (deltaSeconds > timeWindowSeconds) {
        log('info', 'digest.generation', {
          status: 'historical_dedup_match_skipped_time_window',
          self_id: self.id,
          match_id: match.id,
          delta_seconds: deltaSeconds,
        });
        continue;
      }
      // High-confidence band (AD40, 2026-05-09): pairs whose RAW
      // cosine clears `highConfidenceCosine` auto-merge unconditionally,
      // bypassing the same-vendor penalty. Mirrors the finalize-
      // consumer behaviour so the per-tick and operator-sweep paths
      // make consistent decisions on near-duplicate-headline pairs.
      const isHighConfidence = match.score >= highConfidenceCosine;
      // Same-vendor cosine penalty (REQ-PIPE-003 AC 11). Subtracts
      // the configured offset before comparing to the threshold so
      // same-publisher pairs need a stronger signal than cross-
      // publisher pairs to merge — neutralises publisher-style
      // boilerplate inflating cosines on LLM-summary embeddings.
      // Skipped when the pair is already in the high-confidence band.
      const matchUrl =
        typeof meta?.primary_source_url === 'string'
          ? meta.primary_source_url
          : '';
      const sameEtld1 =
        matchUrl !== '' && sameVendor(self.primary_source_url, matchUrl);
      const adjustedScore = sameEtld1 && !isHighConfidence
        ? match.score - sameVendorPenalty
        : match.score;
      // We're walking oldest-first: any match with strictly NEWER
      // published_at is a candidate to fold into self. Older matches
      // were already processed (so `match.id` would have absorbed
      // self in a prior step). Equal-time pairs are tie-broken by
      // ULID — lower ULID = older creation = wins. Without the tie-
      // break, two articles ingested in the same scrape tick that
      // share a `published_at` timestamp could never fold into each
      // other (the strict `>` filter rejected both directions). The
      // 2026-05-07 prod audit found Palo Alto / BTIG-$216 pair stuck
      // at the same `published_at = 1778082516` for exactly this
      // reason; the tie-break unblocks it.
      if (matchPublishedAt < self.published_at) continue;
      if (matchPublishedAt === self.published_at && self.id >= match.id)
        continue;
      const isAutoMerge = isHighConfidence || adjustedScore >= threshold;
      const isBorderline =
        !isAutoMerge && adjustedScore >= rerankFloor;
      if (!isAutoMerge && !isBorderline) continue;

      // Confirm the newer article still exists in D1; Vectorize may
      // hold a vector whose D1 row was retention-deleted in the
      // narrow window since the SELECT above. For the borderline
      // path we also need title + snippet for the LLM rerank, so
      // SELECT them in one round-trip rather than two.
      const stillThere = await env.DB
        .prepare(
          `SELECT id, title, source_snippet FROM articles WHERE id = ?1`,
        )
        .bind(match.id)
        .first<{ id: string; title: string; source_snippet: string | null }>();
      if (stillThere === null) continue;

      if (isBorderline) {
        // No per-batch rerank cap — the queue consumer has a 15-min
        // wall-clock budget per message; the prior 4-rerank cap was
        // a leftover from the synchronous browser-loop era and was
        // silently dropping merges (2026-05-07 prod audit: PANW
        // valuation cluster, 6 borderline pairs in one batch, 2 of 6
        // reached rerank, the rest were dropped).
        rerankCallsThisBatch += 1;
        const sameEvent = await rerankBorderlinePair(
          env,
          {
            id: self.id,
            title: self.title,
            snippet: self.source_snippet,
          },
          {
            id: stillThere.id,
            title: stillThere.title,
            snippet: stillThere.source_snippet,
          },
        );
        log('info', 'digest.generation', {
          status: 'historical_dedup_rerank_decision',
          older_article_id: self.id,
          newer_article_id: match.id,
          cosine: adjustedScore,
          same_event: sameEvent,
        });
        if (!sameEvent) continue;
        rerankAccepts += 1;
      }

      // Run each 6-statement merge as its own D1.batch so the route
      // never approaches D1's per-batch statement cap regardless of
      // the outer `batch` size or topK fan-out (worst case here was
      // 500 outer rows × 5 matches × 6 stmts = 15k in one batch).
      // Each merge is still atomic against itself; partial progress
      // across the outer batch is exactly what we want — the cursor
      // advances per outer row, so a transient mid-loop failure
      // restarts cleanly from the resume point.
      const mergeStatements = mergeAsAltSource(env.DB, self.id, match.id);
      await env.DB.batch(mergeStatements);
      removedIds.add(match.id);
      merged += 1;
    }
  }

  // Page deletes at 100 ids per call to stay under the platform delete-
  // batch ceiling — worst case here is `batch` (≤500) outer rows × topK
  // (5) matches = 2500 ids, well above the single-call limit. Best-effort:
  // a page failure leaves vectors orphan in Vectorize; the daily cleanup
  // pass picks them up when the parent D1 row hits retention.
  if (removedIds.size > 0) {
    await deleteVectorsBatched(
      env.VECTORIZE,
      Array.from(removedIds),
      (err, slice) => {
        log('warn', 'digest.generation', {
          status: 'historical_dedup_vectorize_delete_failed',
          delete_count: slice.length,
          detail: String(err).slice(0, 500),
        });
      },
    );
  }

  // Cursor advances to the LAST scanned article's (published_at, id)
  // so the next call resumes immediately after — the secondary id key
  // closes the equal-time gap that caused same-second pairs at batch
  // boundaries to be silently dropped under the previous single-key
  // cursor.
  const last = rows[rows.length - 1];
  const nextCursor: DedupCursor | null =
    last !== undefined ? { pa: last.published_at, id: last.id } : null;

  // remaining = how many articles past the new cursor still qualify.
  const remainingPaBind = nextCursor?.pa ?? -1;
  const remainingIdBind = nextCursor?.id ?? '';
  const remainingRow = await env.DB
    .prepare(
      `SELECT COUNT(*) AS c
         FROM articles
        WHERE embedding_status = 'embedded'
          AND (
            published_at > ?1
            OR (published_at = ?1 AND id > ?2)
          )`,
    )
    .bind(remainingPaBind, remainingIdBind)
    .first<{ c: number }>();
  const remaining = remainingRow?.c ?? 0;

  log('info', 'digest.generation', {
    status: 'historical_dedup_batch_completed',
    scanned: rows.length,
    merged,
    next_cursor_pa: nextCursor?.pa ?? null,
    next_cursor_id: nextCursor?.id ?? null,
    remaining,
    rerank_floor: rerankFloor,
    rerank_calls_this_batch: rerankCallsThisBatch,
    rerank_accepts_this_batch: rerankAccepts,
  });

  return {
    ok: true,
    scanned: rows.length,
    merged,
    next_cursor: nextCursor,
    remaining,
    done: remaining === 0,
  };
}
