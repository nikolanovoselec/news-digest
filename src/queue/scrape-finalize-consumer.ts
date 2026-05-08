// Implements REQ-PIPE-003
// Implements REQ-PIPE-008
// Implements REQ-PIPE-009
//
// Cross-tick semantic dedup pass for the global-feed pipeline. Runs
// once per scrape tick AFTER all chunks have written their articles +
// vectors. The chunk consumer that closes the run stamps the run as
// `ready` so articles become visible immediately and enqueues a single
// `scrape-finalize` message carrying just the `scrape_run_id`. This
// consumer picks that message up and:
//
//   1. Loads every article from this scrape run that has an embedding
//      in Vectorize. Articles whose embed call failed
//      (`embedding_status='failed'`) skip dedup — they will be picked
//      up by the admin embed-backfill + historical-dedup routes once
//      their vectors land.
//   2. For each article, runs `VECTORIZE.query(topK=5)` and filters
//      matches to (a) different article id, (b) cosine score >=
//      DEDUP_COSINE_THRESHOLD (default 0.78 per the 2026-05-07 prod
//      audit; see AD36), (c) match `published_at < self.published_at`
//      so older articles always win.
//   3. When at least one match qualifies: pick the OLDEST match by
//      `published_at`, batch the 6-statement `mergeAsAltSource` SQL
//      (existing wins, new becomes alt-source, new row deleted), and
//      delete the new article's vector from Vectorize.
//   4. Folds tokens + cost (zero — bge-base is free) + losers_deleted
//      into the scrape_runs row via the same atomic conditional UPDATE
//      as before, so the per-run idempotency gate from migration 0010
//      still holds across queue redeliveries.
//
// Why semantic embedding instead of an LLM dedup call:
// independent LLM-rewritten summaries of the same event share
// almost no token vocabulary (Jaccard ~0.10-0.13 measured against
// production data), so the previous LLM call could not catch them at
// scale. bge-base-en-v1.5 cosine at 0.78 (post-2026-05-07 calibration)
// catches the same-event cluster reliably; see
// `documentation/decisions/AD33...` (Vectorize + embeddings ADR) and
// AD36 (2026-05-07 threshold recalibration) for evidence.

import { log } from '~/lib/log';
import { applyForeignKeysPragma } from '~/lib/db';
import { mergeAsAltSource } from '~/lib/finalize-merge';
import { handleBatch } from '~/lib/queue-handler';
import {
  readCosineThreshold,
  readSameVendorPenalty,
  deleteVectorsBatched,
} from '~/lib/embeddings';
import { readRerankFloor, rerankBorderlinePair } from '~/lib/dedup-rerank';
import { sameVendor } from '~/lib/etld';

/** Hard cap on candidates per finalize call. Comfortable headroom over
 *  current production loads (~150-200 articles per tick). Vectorize
 *  query latency dominates, not candidate volume — the cap exists so
 *  ticks that briefly produce 1000+ articles don't drag finalize past
 *  the queue isolate budget. */
const FINALIZE_CANDIDATE_CAP = 250;

/** TopK for each Vectorize query. Five gives the dedup loop enough
 *  signal to pick the best older match while keeping per-call latency
 *  bounded. Scores below threshold are filtered client-side; topK is
 *  not the gate. */
const VECTORIZE_TOPK = 5;

/** Message shape for the SCRAPE_FINALIZE queue. */
export interface FinalizeJobMessage {
  scrape_run_id: string;
}

interface ArticleRow {
  id: string;
  title: string;
  source_snippet: string | null;
  published_at: number;
  ingested_at: number;
  primary_source_url: string;
}

/** Handle one batch of `scrape-finalize` messages. Per REQ-PIPE-008
 *  AC 8 we deliberately do NOT pass `onTerminalFailure` — the run is
 *  already `ready` from the chunk consumer's last-chunk write, the
 *  articles are visible, and only the cross-tick dedup is missing.
 *  Operators investigate via the `finalize_failed` log event. */
export async function handleFinalizeBatch(
  batch: MessageBatch<FinalizeJobMessage>,
  env: Env,
): Promise<void> {
  await handleBatch(batch, env, {
    process: processOneFinalize,
    throwLogStatus: 'finalize_failed',
    extraLogFields: (body) => ({ scrape_run_id: body.scrape_run_id }),
    // No onTerminalFailure — REQ-PIPE-008 AC 8.
  });
}

/** Process a single finalize message end-to-end. Exported for direct
 *  unit testing without faking the queue batch envelope. */
export async function processOneFinalize(
  env: Env,
  body: FinalizeJobMessage,
): Promise<void> {
  await applyForeignKeysPragma(env.DB);

  // Step 0 — best-effort upfront short-circuit on queue redelivery.
  // The atomic UPDATE later in this function is the genuine race
  // safety net; the upfront check exists to avoid issuing N Vectorize
  // queries on every redelivery for runs that already finalized.
  const gateProbe = await env.DB
    .prepare(`SELECT finalize_recorded FROM scrape_runs WHERE id = ?1`)
    .bind(body.scrape_run_id)
    .first<{ finalize_recorded: number }>();
  if (gateProbe !== null && gateProbe.finalize_recorded === 1) {
    log('info', 'digest.generation', {
      status: 'finalize_redelivery_skipped_upfront',
      scrape_run_id: body.scrape_run_id,
      reason: 'finalize_recorded_already_set',
    });
    return;
  }

  // Step 1 — load this run's surviving article IDs that have a vector
  // in Vectorize. Articles whose embed call failed are excluded; they
  // ship un-deduped this tick and the admin backfill route catches
  // them later.
  const result = await env.DB
    .prepare(
      `SELECT id, title, source_snippet, published_at, ingested_at, primary_source_url
         FROM articles
        WHERE scrape_run_id = ?1
          AND embedding_status = 'embedded'
        ORDER BY ingested_at DESC
        LIMIT ?2`,
    )
    .bind(body.scrape_run_id, FINALIZE_CANDIDATE_CAP)
    .all<ArticleRow>();
  const rows: ArticleRow[] = result.results ?? [];

  if (rows.length === 0) {
    log('info', 'digest.generation', {
      status: 'finalize_noop',
      scrape_run_id: body.scrape_run_id,
      article_count: 0,
    });
    // Still flip the gate so operator dashboards reflect the run as
    // finalized even when zero articles had vectors.
    await flipGate(env, body.scrape_run_id, 0);
    return;
  }

  const threshold = readCosineThreshold(env);
  const sameVendorPenalty = readSameVendorPenalty(env);
  const rerankFloor = readRerankFloor(env);

  // Step 2 — for each article, query Vectorize for top-K matches and
  // pick the oldest sufficiently-similar older article (if any).
  // Auto-merge band wins outright; if no auto-merge match exists but a
  // borderline match (>= floor, < threshold) does, the LLM rerank
  // decides whether to merge. REQ-PIPE-009.
  //
  // Per-merge batching: each merge runs as its own `env.DB.batch(...)`
  // inside the loop rather than accumulating every merge's statements
  // into one trailing super-batch. Mirrors the historical-dedup pattern
  // in `runHistoricalDedupBatch` (`src/lib/historical-dedup.ts`). The
  // earlier shape — one batch holding 6 × N merges — silently failed
  // at runtime on busy ticks: a tick with ~50 merges produced a 300-
  // statement batch that exceeded D1's per-batch ceiling, throwing a
  // single error that aborted ALL merges for the run. The screenshot
  // duplicate clusters on news.graymatter.ch from runs prior to
  // 2026-05-08 trace to exactly this failure mode (cosines well above
  // threshold, finalize_recorded=1 set by the upfront flip, zero
  // article_sources rows added).
  const mergedNewIds = new Set<string>();
  let losersDeleted = 0;
  let queriesAttempted = 0;
  let queriesFailed = 0;
  let rerankCalls = 0;
  let rerankAccepts = 0;

  for (const self of rows) {
    if (mergedNewIds.has(self.id)) continue; // already merged this pass

    queriesAttempted += 1;
    let queryResult: VectorizeMatches;
    try {
      // queryById queries the stored vector by id — semantically
      // equivalent to fetch-then-query but a single round-trip.
      queryResult = await env.VECTORIZE.queryById(self.id, {
        topK: VECTORIZE_TOPK,
        returnMetadata: 'all',
      });
    } catch (err) {
      queriesFailed += 1;
      log('warn', 'digest.generation', {
        status: 'finalize_vectorize_query_failed',
        scrape_run_id: body.scrape_run_id,
        article_id: self.id,
        detail: String(err).slice(0, 500),
      });
      continue;
    }

    const matches = queryResult.matches ?? [];
    let autoMatchId: string | null = null;
    let autoMatchPublishedAt = Number.POSITIVE_INFINITY;
    let borderMatchId: string | null = null;
    let borderMatchPublishedAt = Number.POSITIVE_INFINITY;
    let borderMatchScore = 0;

    for (const match of matches) {
      if (match.id === self.id) continue;
      const meta = match.metadata as
        | { published_at?: unknown; primary_source_url?: unknown }
        | undefined;
      const matchPublishedAt =
        typeof meta?.published_at === 'number' ? meta.published_at : null;
      if (matchPublishedAt === null) continue;
      // Apply the same-vendor cosine penalty BEFORE the threshold gate.
      // Same-publisher pairs (cloud.google.com vs blog.google,
      // workos.com vs blog.workos.com) consistently produced inflated
      // cosines on LLM-summary embeddings because the model carried
      // publisher-style boilerplate; the offset neutralises that
      // without forbidding genuine same-publisher merges (a very
      // strong source-text match still clears 0.78 + 0.05 = 0.83).
      const matchUrl =
        typeof meta?.primary_source_url === 'string'
          ? meta.primary_source_url
          : '';
      const sameEtld1 =
        matchUrl !== '' && sameVendor(self.primary_source_url, matchUrl);
      const adjustedScore = sameEtld1
        ? match.score - sameVendorPenalty
        : match.score;
      // Only merge into STRICTLY older articles. Equal-published_at
      // matches (rare, possible for press-release feeds publishing the
      // same minute) keep both rows so the standalone tiebreak rule
      // from REQ-PIPE-008 AC 2 still applies elsewhere.
      if (matchPublishedAt >= self.published_at) continue;
      if (adjustedScore >= threshold) {
        if (matchPublishedAt < autoMatchPublishedAt) {
          autoMatchId = match.id;
          autoMatchPublishedAt = matchPublishedAt;
        }
      } else if (adjustedScore >= rerankFloor) {
        // Track the highest-scoring borderline match (oldest tiebreak).
        // We rerank at most one pair per article so the strongest
        // candidate gets the LLM call.
        if (
          adjustedScore > borderMatchScore ||
          (adjustedScore === borderMatchScore &&
            matchPublishedAt < borderMatchPublishedAt)
        ) {
          borderMatchId = match.id;
          borderMatchPublishedAt = matchPublishedAt;
          borderMatchScore = adjustedScore;
        }
      }
    }

    let bestMatchId = autoMatchId;
    let bestMatchAlreadyConfirmedExists = false;
    if (bestMatchId === null && borderMatchId !== null) {
      const existingArticle = await env.DB
        .prepare(
          `SELECT id, title, source_snippet FROM articles WHERE id = ?1`,
        )
        .bind(borderMatchId)
        .first<{ id: string; title: string; source_snippet: string | null }>();
      if (existingArticle === null) continue;
      rerankCalls += 1;
      const sameEvent = await rerankBorderlinePair(
        env,
        {
          id: self.id,
          title: self.title,
          snippet: self.source_snippet,
        },
        {
          id: existingArticle.id,
          title: existingArticle.title,
          snippet: existingArticle.source_snippet,
        },
      );
      log('info', 'digest.generation', {
        status: 'finalize_rerank_decision',
        scrape_run_id: body.scrape_run_id,
        new_article_id: self.id,
        existing_article_id: borderMatchId,
        cosine: borderMatchScore,
        same_event: sameEvent,
      });
      if (!sameEvent) continue;
      rerankAccepts += 1;
      bestMatchId = borderMatchId;
      // The borderline path already issued SELECT id, title,
      // source_snippet against bestMatchId and confirmed it exists; no
      // need to re-issue the existence guard below.
      bestMatchAlreadyConfirmedExists = true;
    }

    if (bestMatchId === null) continue;

    // Confirm the existing article still exists in D1 — Vectorize may
    // hold a vector whose D1 row was already retention-deleted in the
    // narrow window between the cleanup pass and the next finalize.
    // Without this guard, the merge SQL would write FK violations.
    // Skipped on the borderline path because the rerank-data fetch
    // above already confirmed existence.
    if (!bestMatchAlreadyConfirmedExists) {
      const existsRow = await env.DB
        .prepare(`SELECT 1 AS present FROM articles WHERE id = ?1`)
        .bind(bestMatchId)
        .first<{ present: number }>();
      if (existsRow === null) {
        log('warn', 'digest.generation', {
          status: 'finalize_vectorize_stale_match',
          scrape_run_id: body.scrape_run_id,
          new_article_id: self.id,
          existing_article_id: bestMatchId,
        });
        continue;
      }
    }

    const merge = mergeAsAltSource(env.DB, bestMatchId, self.id);
    try {
      await env.DB.batch(merge);
    } catch (err) {
      // One bad merge must not abort the rest of the run. Skip it; the
      // historical-dedup sweep will catch any pair we miss here.
      log('warn', 'digest.generation', {
        status: 'finalize_merge_failed',
        scrape_run_id: body.scrape_run_id,
        new_article_id: self.id,
        existing_article_id: bestMatchId,
        detail: String(err).slice(0, 500),
      });
      continue;
    }
    mergedNewIds.add(self.id);
    losersDeleted += 1;
  }

  // Step 4 — delete merged-away vectors from Vectorize. Best-effort:
  // a failure here leaves the vector orphan in Vectorize, but D1 is
  // canonical. The vector gets garbage-collected by the cleanup pass
  // when its retention cutoff hits (Vectorize.deleteByIds for an
  // already-deleted id is a no-op). Pages at 100 ids per call to stay
  // under the platform delete-batch ceiling — with FINALIZE_CANDIDATE_CAP
  // = 250 a worst-case "every article merged" tick would otherwise blow
  // the limit on a single deleteByIds payload.
  if (mergedNewIds.size > 0) {
    await deleteVectorsBatched(
      env.VECTORIZE,
      Array.from(mergedNewIds),
      (err, slice) => {
        log('warn', 'digest.generation', {
          status: 'finalize_vectorize_delete_failed',
          scrape_run_id: body.scrape_run_id,
          deleted_id_count: slice.length,
          detail: String(err).slice(0, 500),
        });
      },
    );
  }

  // Step 5 — refuse to flip the gate when Vectorize was hard-down for
  // the whole pass. If every queryById threw, we have no information
  // about cross-tick duplicates for this run — flipping the gate now
  // would commit "finalized with zero merges" forever (the upfront
  // SELECT short-circuits future redeliveries on finalize_recorded=1).
  // Throwing instead lets the queue redelivery path retry the whole
  // pass when Vectorize recovers.
  if (
    queriesAttempted > 0 &&
    queriesFailed === queriesAttempted
  ) {
    log('error', 'digest.generation', {
      status: 'finalize_vectorize_unavailable',
      scrape_run_id: body.scrape_run_id,
      queries_attempted: queriesAttempted,
      queries_failed: queriesFailed,
    });
    throw new Error(
      `finalize: Vectorize.queryById failed for all ${queriesAttempted} articles in run ${body.scrape_run_id}`,
    );
  }

  // Step 6 — flip the per-run idempotency gate + record losers count.
  // Tokens / cost are zero (bge-base is free on Workers AI as of
  // 2026-05-06) so the cost-recording branch from the previous LLM
  // path is gone — the gate just needs to flip.
  const wonRecording = await flipGate(env, body.scrape_run_id, losersDeleted);

  if (wonRecording) {
    log('info', 'digest.generation', {
      status: 'finalize_ready',
      scrape_run_id: body.scrape_run_id,
      article_count: rows.length,
      groups_merged: losersDeleted,
      losers_deleted: losersDeleted,
      cost_recorded: true,
      capped_at_250: rows.length === FINALIZE_CANDIDATE_CAP,
      cosine_threshold: threshold,
      rerank_floor: rerankFloor,
      rerank_calls: rerankCalls,
      rerank_accepts: rerankAccepts,
    });
  } else {
    log('info', 'digest.generation', {
      status: 'finalize_redelivery_skipped',
      scrape_run_id: body.scrape_run_id,
      reason: 'race_lost',
    });
  }
}

/**
 * Single atomic UPDATE that flips finalize_recorded AND adds the
 * losers_deleted count to articles_deduped, gated by
 * `WHERE finalize_recorded = 0`. On the first successful pass the
 * WHERE matches and the row is fully updated; on every queue
 * redelivery the row's finalize_recorded is already 1, the WHERE
 * doesn't match, and nothing changes (the dedup count is not
 * double-counted). Same idempotency contract as migration 0010.
 *
 * Returns true when this attempt won the race, false otherwise.
 */
async function flipGate(
  env: Env,
  scrape_run_id: string,
  losersDeleted: number,
): Promise<boolean> {
  const result = await env.DB
    .prepare(
      `UPDATE scrape_runs
          SET finalize_recorded = 1,
              articles_deduped = articles_deduped + ?2
        WHERE id = ?1 AND finalize_recorded = 0`,
    )
    .bind(scrape_run_id, losersDeleted)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}
