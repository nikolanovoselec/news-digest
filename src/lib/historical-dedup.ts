// Implements REQ-PIPE-003 AC 9
// Implements REQ-PIPE-003 AC 17
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
import { classifyMatchPair } from '~/lib/bidirectional-dedup';

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
  // CF-004: align with scrape-finalize-consumer total-outage behavior.
  // finalize throws when `queriesFailed === queriesAttempted > 0` so the
  // gate stays un-flipped and queue retries cover Vectorize recovery.
  // historical-dedup previously logged + `continue`d, letting the cursor
  // advance past failed selves and silently leaving cross-tick duplicates
  // unmerged during a corpus-wide outage. We now track attempts/failures
  // and short-circuit the batch on total outage, returning `done: false`
  // with the INPUT cursor unchanged so the queue-driven sweep re-attempts
  // the same range on the next message instead of skipping it.
  let queriesAttempted = 0;
  let queriesFailed = 0;

  for (const self of rows) {
    if (removedIds.has(self.id)) continue;

    let queryResult: VectorizeMatches;
    queriesAttempted += 1;
    try {
      queryResult = await env.VECTORIZE.queryById(self.id, {
        topK: VECTORIZE_TOPK,
        returnMetadata: 'all',
      });
    } catch (err) {
      queriesFailed += 1;
      log('warn', 'digest.generation', {
        status: 'historical_dedup_query_failed',
        article_id: self.id,
        detail: String(err).slice(0, 500),
      });
      continue;
    }

    const matches = queryResult.matches ?? [];

    // Bidirectional sweep (AD42, 2026-05-10). Pre-AD42 historical-dedup
    // walked oldest-first and only folded NEWER matches into the older
    // self — leaving cross-tick pairs unmerged whenever the older
    // anchor article had already left the auto-sweep cursor window.
    // The Cloudflare-layoffs cluster on 2026-05-10 was the prod
    // evidence: 13 articles, anchor at pa=05-07 20:23, newest at
    // pa=05-10 18:47 (70h spread). After the 48h cursor advanced past
    // the anchor, every subsequent sweep saw the cluster's older
    // members below the cursor and could not absorb the newer ones.
    // Bidirectional flip: when self has an OLDER auto-merge candidate,
    // self folds INTO that older anchor and the cluster reroots there.
    // Mirrors AD41's bidirectional finalize-consumer logic.
    //
    // PASS 1 (preferred direction): scan all matches for the OLDEST
    // auto-merge candidate STRICTLY OLDER than self. If found, self
    // folds into that anchor and we move to the next outer row — self
    // is now a loser, no further matches matter.
    const classifierParams = {
      threshold,
      sameVendorPenalty,
      rerankFloor,
      timeWindowSeconds,
      highConfidenceCosine,
    };
    let foldIntoOlder: { id: string; pa: number } | null = null;
    for (const match of matches) {
      if (match.id === self.id) continue;
      if (removedIds.has(match.id)) continue;
      const c = classifyMatchPair(self, match, classifierParams);
      if (c.kind !== 'eligible') continue;
      // PASS 1 — only strict-older direction (selfIsOlder=false ⇒
      // match is older). Auto-merge band only; borderline candidates
      // are handled by PASS 2's rerank path.
      if (c.selfIsOlder) continue;
      if (!c.isAutoMerge) continue;
      // Prefer the OLDEST auto-merge match — the deepest-rooted anchor
      // for the cluster.
      if (foldIntoOlder === null || c.matchPublishedAt < foldIntoOlder.pa) {
        foldIntoOlder = { id: match.id, pa: c.matchPublishedAt };
      }
    }

    if (foldIntoOlder !== null) {
      // Use the same SELECT shape as PASS 2 below — the existence
      // information is all PASS 1 needs, and the title/snippet
      // columns are harmless. Mirroring the query keeps the test
      // fixture's mock single-shaped.
      const stillThere = await env.DB
        .prepare(
          `SELECT id, title, source_snippet FROM articles WHERE id = ?1`,
        )
        .bind(foldIntoOlder.id)
        .first<{ id: string; title: string; source_snippet: string | null }>();
      if (stillThere !== null) {
        const mergeStatements = mergeAsAltSource(
          env.DB,
          foldIntoOlder.id,
          self.id,
        );
        try {
          await env.DB.batch(mergeStatements);
          removedIds.add(self.id);
          merged += 1;
          log('info', 'digest.generation', {
            status: 'historical_dedup_self_folded_into_older',
            self_id: self.id,
            match_id: foldIntoOlder.id,
          });
          continue;
        } catch (err) {
          log('warn', 'digest.generation', {
            status: 'historical_dedup_merge_failed',
            winner_id: foldIntoOlder.id,
            loser_id: self.id,
            detail: String(err).slice(0, 500),
          });
          // fall through to PASS 2 — best-effort, do not stop the sweep
        }
      }
    }

    // PASS 2: existing behaviour — self absorbs each NEWER match
    // sequentially. Self is a confirmed cluster anchor (no older
    // auto-merge match exists), so accumulating absorptions is correct
    // and efficient: one Vectorize query per anchor, many merges.
    for (const match of matches) {
      if (match.id === self.id) continue;
      if (removedIds.has(match.id)) continue;
      const c = classifyMatchPair(self, match, classifierParams);
      if (c.kind === 'no_metadata') continue;
      if (c.kind === 'out_of_window') {
        // Hard time-window gate — pairs published further apart than
        // the configured window are not the same news event regardless
        // of cosine. Cuts dense-theme false-merges from cross-news-
        // cycle matches (REQ-PIPE-003).
        log('info', 'digest.generation', {
          status: 'historical_dedup_match_skipped_time_window',
          self_id: self.id,
          match_id: match.id,
          delta_seconds: c.deltaSeconds,
        });
        continue;
      }
      // PASS 2 only handles the strictly-newer direction. Older
      // matches were the responsibility of PASS 1 above. selfIsOlder
      // already encodes the equal-time ULID tie-break (lower id = older).
      if (!c.selfIsOlder) continue;
      const adjustedScore = c.adjustedScore;
      if (!c.isAutoMerge && !c.isBorderline) continue;

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

      if (c.isBorderline) {
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

  // CF-004 total-outage gate. If every Vectorize query in this batch
  // failed, the dedup decision for every row is "unknown" — advancing
  // the cursor would silently strand same-event cross-tick pairs once
  // Vectorize recovers, mirroring the production failure mode the
  // scrape-finalize-consumer already guards against by throwing.
  // Short-circuit with the INPUT cursor preserved so the queue-driven
  // self-chain re-attempts the same range on the next consumer message
  // (queue back-pressure provides the retry delay). The admin endpoint
  // surface this as `done: false` with the same cursor — operators can
  // re-poll once Vectorize is healthy.
  if (queriesAttempted > 0 && queriesFailed === queriesAttempted) {
    log('error', 'digest.generation', {
      status: 'historical_dedup_vectorize_total_outage',
      scanned: rows.length,
      queries_attempted: queriesAttempted,
      queries_failed: queriesFailed,
      cursor_pa: cursor?.pa ?? null,
      cursor_id: cursor?.id ?? null,
    });
    return {
      ok: true,
      scanned: rows.length,
      merged: 0,
      next_cursor: cursor,
      remaining: rows.length,
      done: false,
    };
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
