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
//      matches to (a) different article id, (b) within the 72h
//      news-cycle window (DEDUP_TIME_WINDOW_SECONDS), (c) cosine
//      score >= DEDUP_COSINE_THRESHOLD (default 0.88 per the
//      2026-05-08 false-merge audit; see AD39), (d) match
//      `published_at < self.published_at` so older articles always win.
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
  readHighConfidenceCosine,
  readSameVendorPenalty,
  readTimeWindowSeconds,
  deleteVectorsBatched,
} from '~/lib/embeddings';
import { readRerankFloor, rerankBorderlinePair } from '~/lib/dedup-rerank';
import { sameVendor } from '~/lib/etld';
import { generateUlid } from '~/lib/ulid';

/** Hard cap on candidates per finalize call. Comfortable headroom over
 *  current production loads (~150-200 articles per tick). Vectorize
 *  query latency dominates, not candidate volume — the cap exists so
 *  ticks that briefly produce 1000+ articles don't drag finalize past
 *  the queue isolate budget. */
const FINALIZE_CANDIDATE_CAP = 250;

/** TopK for each Vectorize query. Bumped from 5 to 20 on 2026-05-09
 *  (AD40) after the AD39 threshold raise widened the rerank band from
 *  8 cosine points to 18: in dense-theme periods the 5 nearest
 *  neighbours can be consumed by topical noise scoring above 0.80,
 *  starving the loop of the actual same-event candidate at rank 6+.
 *  20 is cheap (Vectorize cost is per-query, not per-result) and
 *  comfortably covers any realistic per-article cluster size. */
const VECTORIZE_TOPK = 20;

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

/** Auto-merge candidate. `selfIsOlder` encodes the merge direction:
 *  true means self IS the older article and match folds INTO self;
 *  false means match is the older article and self folds INTO match
 *  (the pre-2026-05-09 direction). */
interface AutoCandidate {
  matchId: string;
  matchPublishedAt: number;
  adjustedScore: number;
  selfIsOlder: boolean;
}

/** Borderline candidate (cosine in `[rerankFloor, threshold)`) — the
 *  LLM rerank decides whether the pair merges. Same direction
 *  encoding as {@link AutoCandidate}. */
type BorderCandidate = AutoCandidate;

/** Auto-merge ranking. The cluster anchors at the OLDEST overall
 *  article, so prefer candidates whose merge keeps the older direction
 *  (`!selfIsOlder` — match is older). Within the same direction, prefer
 *  the older `match.published_at` (existing semantics). When the only
 *  candidates are newer-than-self (cluster anchors at self), pick the
 *  highest-scoring match — the older the cosine peak, the more likely
 *  the LLM-summary embedding identified the same news event. */
function isBetterAutoCandidate(
  cand: AutoCandidate,
  best: AutoCandidate | null,
): boolean {
  if (best === null) return true;
  if (!cand.selfIsOlder && best.selfIsOlder) return true;
  if (cand.selfIsOlder && !best.selfIsOlder) return false;
  if (!cand.selfIsOlder) {
    return cand.matchPublishedAt < best.matchPublishedAt;
  }
  return cand.adjustedScore > best.adjustedScore;
}

/** Borderline ranking. Pure highest-cosine-wins because we can only
 *  afford one LLM rerank call per article and want the strongest
 *  signal. Tie-break on direction (prefer match-older) then on
 *  match.published_at. */
function isBetterBorderCandidate(
  cand: BorderCandidate,
  best: BorderCandidate | null,
): boolean {
  if (best === null) return true;
  if (cand.adjustedScore > best.adjustedScore) return true;
  if (cand.adjustedScore < best.adjustedScore) return false;
  if (!cand.selfIsOlder && best.selfIsOlder) return true;
  if (cand.selfIsOlder && !best.selfIsOlder) return false;
  return cand.matchPublishedAt < best.matchPublishedAt;
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
  const timeWindowSeconds = readTimeWindowSeconds(env);
  const highConfidenceCosine = readHighConfidenceCosine(env);

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
  // Tracks every article ID deleted as a merge loser this pass. Used to
  // (a) skip self in subsequent iterations if a prior iteration absorbed
  // it, (b) skip a match candidate that was already absorbed, (c) drive
  // the trailing Vectorize delete batch. Bidirectional: a loser can be
  // self.id (self-folds-into-match) or match.id (match-folds-into-self).
  const losersDeleted = new Set<string>();
  let queriesAttempted = 0;
  let queriesFailed = 0;
  let rerankCalls = 0;
  let rerankAccepts = 0;

  for (const self of rows) {
    if (losersDeleted.has(self.id)) continue; // already absorbed this pass

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
    // Bidirectional candidate tracking. A pair (self, match) merges
    // with the OLDER article as winner regardless of which one was
    // just ingested — the cluster anchors at the deepest-rooted
    // article. The pre-2026-05-09 logic only handled "self folds into
    // older match" and silently dropped the late-arriving-older case
    // (newly-ingested article whose published_at is older than an
    // already-stored match), leaving genuine duplicates unmerged. See
    // AD41 for the prod evidence (Cloudflare-layoffs LA Times / KRON4
    // pair, cosine 0.896, 24h apart, never merged).
    let bestAuto: AutoCandidate | null = null;
    let bestBorder: BorderCandidate | null = null;

    // Per-article diagnostic counters (AD40 + AD41). Emitted as one
    // info log line after the inner match loop so operators can
    // diagnose under-merge from `wrangler tail` without re-running the
    // pipeline. The line answers: how many candidates did we see, how
    // many cleared each band, what was the best score, why didn't we
    // merge.
    let candidatesSeen = 0;
    let candidatesSkippedTimeWindow = 0;
    let candidatesSkippedAlreadyAbsorbed = 0;
    let candidatesSelfOlder = 0;
    let candidatesSelfNewer = 0;
    let candidatesAboveFloor = 0;
    let candidatesAboveThreshold = 0;
    let candidatesHighConfidence = 0;
    let bestCosineRaw = 0;
    let bestCosineAdjusted = 0;

    for (const match of matches) {
      if (match.id === self.id) continue;
      // A candidate already absorbed by a prior iteration of this same
      // finalize pass cannot merge again. Skip without counting it as
      // a normal-eligibility candidate.
      if (losersDeleted.has(match.id)) {
        candidatesSkippedAlreadyAbsorbed += 1;
        continue;
      }
      candidatesSeen += 1;
      const meta = match.metadata as
        | { published_at?: unknown; primary_source_url?: unknown }
        | undefined;
      const matchPublishedAt =
        typeof meta?.published_at === 'number' ? meta.published_at : null;
      if (matchPublishedAt === null) continue;
      // Hard time-window gate — pairs further apart than the configured
      // window are not the same news event regardless of how high the
      // cosine score is. Cuts dense-theme false-merges (e.g. "AI agent
      // governance") that score above the cosine ceiling on topical
      // overlap alone. Applied BEFORE same-vendor penalty + threshold.
      const deltaSeconds = Math.abs(self.published_at - matchPublishedAt);
      if (deltaSeconds > timeWindowSeconds) {
        candidatesSkippedTimeWindow += 1;
        log('info', 'digest.generation', {
          status: 'finalize_match_skipped_time_window',
          scrape_run_id: body.scrape_run_id,
          self_id: self.id,
          match_id: match.id,
          delta_seconds: deltaSeconds,
        });
        continue;
      }
      // High-confidence band (AD40, 2026-05-09): pairs whose RAW
      // cosine clears `highConfidenceCosine` auto-merge unconditionally,
      // bypassing the same-vendor penalty. At raw >= 0.92 the articles
      // are essentially restating each other (wire-syndicated stories,
      // near-identical headlines) and the penalty would otherwise drop
      // genuine duplicates into the rerank band where an LLM
      // hallucination can reject them.
      const isHighConfidence = match.score >= highConfidenceCosine;
      // Apply the same-vendor cosine penalty BEFORE the threshold gate
      // (skipped for high-confidence pairs). Same-publisher pairs
      // (cloud.google.com vs blog.google, workos.com vs blog.workos.com)
      // consistently produced inflated cosines on LLM-summary
      // embeddings because the model carried publisher-style
      // boilerplate; the offset neutralises that without forbidding
      // genuine same-publisher merges.
      const matchUrl =
        typeof meta?.primary_source_url === 'string'
          ? meta.primary_source_url
          : '';
      const sameEtld1 =
        matchUrl !== '' && sameVendor(self.primary_source_url, matchUrl);
      const adjustedScore = sameEtld1 && !isHighConfidence
        ? match.score - sameVendorPenalty
        : match.score;
      // Direction. self_is_older means self IS the older article in
      // the pair — the cluster anchors at self and we'd absorb match
      // INTO self. self_is_older=false means match is older — self
      // folds into match (the pre-2026-05-09 direction). Equal
      // `published_at` is tie-broken by ULID; lower id = older. The
      // strict-older branches below reject the impossible self.id ===
      // match.id case (already filtered above).
      const selfIsOlder =
        self.published_at < matchPublishedAt ||
        (self.published_at === matchPublishedAt && self.id < match.id);
      if (selfIsOlder) {
        candidatesSelfOlder += 1;
      } else {
        candidatesSelfNewer += 1;
      }
      if (adjustedScore > bestCosineAdjusted) {
        bestCosineRaw = match.score;
        bestCosineAdjusted = adjustedScore;
      }
      if (isHighConfidence) candidatesHighConfidence += 1;
      if (isHighConfidence || adjustedScore >= threshold) {
        candidatesAboveThreshold += 1;
        candidatesAboveFloor += 1;
        const cand: AutoCandidate = {
          matchId: match.id,
          matchPublishedAt,
          adjustedScore,
          selfIsOlder,
        };
        if (isBetterAutoCandidate(cand, bestAuto)) {
          bestAuto = cand;
        }
      } else if (adjustedScore >= rerankFloor) {
        candidatesAboveFloor += 1;
        // Track the highest-scoring borderline match across BOTH
        // directions — the LLM rerank then judges same-event yes/no
        // and the merge runs in whichever direction puts the older
        // article as winner.
        const cand: BorderCandidate = {
          matchId: match.id,
          matchPublishedAt,
          adjustedScore,
          selfIsOlder,
        };
        if (isBetterBorderCandidate(cand, bestBorder)) {
          bestBorder = cand;
        }
      }
    }

    // Per-article diagnostic log (AD40 + AD41). One line per ingested
    // article summarising what the dedup pass observed: candidate
    // count after self/null filter, direction breakdown
    // (`candidates_self_older` = self is the older article in the
    // pair; `candidates_self_newer` = match is older), best cosine
    // seen post-time-window, and the outcome class. Operators grep
    // `wrangler tail` for `decision="no_above_threshold"` etc. to
    // localise under-merge.
    let decision: string;
    let chosenDirection: 'self_loses' | 'self_wins' | null = null;
    if (bestAuto !== null) {
      decision = bestAuto.selfIsOlder ? 'auto_merge_self_wins' : 'auto_merge';
      chosenDirection = bestAuto.selfIsOlder ? 'self_wins' : 'self_loses';
    } else if (bestBorder !== null) {
      decision = 'rerank_pending';
    } else if (candidatesAboveFloor > 0) {
      decision = 'no_above_threshold';
    } else if (candidatesSeen > 0) {
      decision = 'no_match_below_floor';
    } else {
      decision = 'no_candidates';
    }
    log('info', 'digest.generation', {
      status: 'finalize_dedup_diag',
      scrape_run_id: body.scrape_run_id,
      self_id: self.id,
      candidates_seen: candidatesSeen,
      candidates_skipped_time_window: candidatesSkippedTimeWindow,
      candidates_skipped_already_absorbed: candidatesSkippedAlreadyAbsorbed,
      candidates_self_older: candidatesSelfOlder,
      candidates_self_newer: candidatesSelfNewer,
      candidates_above_floor: candidatesAboveFloor,
      candidates_above_threshold: candidatesAboveThreshold,
      candidates_high_confidence: candidatesHighConfidence,
      best_cosine_raw: bestCosineRaw,
      best_cosine_adjusted: bestCosineAdjusted,
      decision,
      chosen_direction: chosenDirection,
    });

    // Pick the chosen candidate. Auto wins outright; borderline goes
    // through the LLM rerank gate. The chosen candidate carries
    // `selfIsOlder` so the merge knows which side is winner / loser.
    let chosen: AutoCandidate | null = bestAuto;
    let chosenAlreadyConfirmedExists = false;
    if (chosen === null && bestBorder !== null) {
      const existingArticle = await env.DB
        .prepare(
          `SELECT id, title, source_snippet FROM articles WHERE id = ?1`,
        )
        .bind(bestBorder.matchId)
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
        existing_article_id: bestBorder.matchId,
        cosine: bestBorder.adjustedScore,
        same_event: sameEvent,
        direction: bestBorder.selfIsOlder ? 'self_wins' : 'self_loses',
      });
      if (!sameEvent) continue;
      rerankAccepts += 1;
      chosen = bestBorder;
      // The borderline path already issued SELECT id, title,
      // source_snippet against the match and confirmed it exists; no
      // need to re-issue the existence guard below.
      chosenAlreadyConfirmedExists = true;
    }

    if (chosen === null) continue;

    // Resolve winner / loser by direction. selfIsOlder=true means self
    // is the older article (cluster anchors at self) and the newer
    // match folds INTO self. selfIsOlder=false is the pre-2026-05-09
    // direction (self folds into older match). mergeAsAltSource(...,
    // winnerId, loserId) preserves winner's title + body; loser's URL
    // becomes an alt-source row on winner; loser's existing alt-
    // sources / stars / read-marks repoint; loser is DELETE-d.
    const winnerId = chosen.selfIsOlder ? self.id : chosen.matchId;
    const loserId = chosen.selfIsOlder ? chosen.matchId : self.id;

    // Confirm the OTHER article still exists in D1 — Vectorize may
    // hold a vector whose D1 row was already retention-deleted in the
    // narrow window between the cleanup pass and the next finalize.
    // Without this guard, the merge SQL would write FK violations.
    // For chosen.selfIsOlder=true the "other" is the match (which the
    // borderline path may have already confirmed); for the existing
    // direction the "other" is also the match.
    if (!chosenAlreadyConfirmedExists) {
      const existsRow = await env.DB
        .prepare(`SELECT 1 AS present FROM articles WHERE id = ?1`)
        .bind(chosen.matchId)
        .first<{ present: number }>();
      if (existsRow === null) {
        log('warn', 'digest.generation', {
          status: 'finalize_vectorize_stale_match',
          scrape_run_id: body.scrape_run_id,
          new_article_id: self.id,
          existing_article_id: chosen.matchId,
        });
        continue;
      }
    }

    const merge = mergeAsAltSource(env.DB, winnerId, loserId);
    try {
      await env.DB.batch(merge);
    } catch (err) {
      // One bad merge must not abort the rest of the run. Skip it; the
      // post-tick auto-sweep will catch any pair we miss here.
      log('warn', 'digest.generation', {
        status: 'finalize_merge_failed',
        scrape_run_id: body.scrape_run_id,
        winner_id: winnerId,
        loser_id: loserId,
        detail: String(err).slice(0, 500),
      });
      continue;
    }
    losersDeleted.add(loserId);
  }

  // Step 4 — delete merged-away vectors from Vectorize. Best-effort:
  // a failure here leaves the vector orphan in Vectorize, but D1 is
  // canonical. The vector gets garbage-collected by the cleanup pass
  // when its retention cutoff hits (Vectorize.deleteByIds for an
  // already-deleted id is a no-op). Pages at 100 ids per call to stay
  // under the platform delete-batch ceiling — with FINALIZE_CANDIDATE_CAP
  // = 250 a worst-case "every article merged" tick would otherwise blow
  // the limit on a single deleteByIds payload. Bidirectional (AD41):
  // a loser can be self.id (self-folds-into-match) or match.id
  // (match-folds-into-self), so we delete every absorbed id regardless
  // of which side of the pair it was on.
  if (losersDeleted.size > 0) {
    await deleteVectorsBatched(
      env.VECTORIZE,
      Array.from(losersDeleted),
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
  const losersDeletedCount = losersDeleted.size;
  const wonRecording = await flipGate(
    env,
    body.scrape_run_id,
    losersDeletedCount,
  );

  if (wonRecording) {
    log('info', 'digest.generation', {
      status: 'finalize_ready',
      scrape_run_id: body.scrape_run_id,
      article_count: rows.length,
      groups_merged: losersDeletedCount,
      losers_deleted: losersDeletedCount,
      cost_recorded: true,
      capped_at_250: rows.length === FINALIZE_CANDIDATE_CAP,
      cosine_threshold: threshold,
      rerank_floor: rerankFloor,
      rerank_calls: rerankCalls,
      rerank_accepts: rerankAccepts,
    });

    // Step 7 — kick a bounded post-tick dedup sweep (AD41). Catches
    // pairs that finalize couldn't merge due to Vectorize eventual
    // consistency (same-batch articles upserted moments earlier may
    // not yet be queryable), plus any cross-tick or late-arriving-
    // older pairs that escape the per-tick window. Scoped to the last
    // `AUTO_SWEEP_LOOKBACK_SECONDS` so each tick's auto-sweep stays
    // cheap (sub-corpus walk, ~50-100 articles in a busy 48h window
    // vs. the full 1.3k-article corpus on the operator-triggered
    // /api/admin/historical-dedup path). Best-effort: a failure here
    // is logged but does NOT roll back finalize_recorded — the
    // operator can still kick a manual sweep.
    try {
      await enqueueAutoSweep(env, body.scrape_run_id);
    } catch (err) {
      log('warn', 'digest.generation', {
        status: 'finalize_auto_sweep_enqueue_failed',
        scrape_run_id: body.scrape_run_id,
        detail: String(err).slice(0, 500),
      });
    }
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

/** Lookback window for the post-tick auto-sweep (AD41). 48h covers
 *  the cases finalize misses: same-second siblings (Vectorize
 *  eventual consistency lag), cross-tick pairs that arrived in a
 *  prior tick whose finalize finished before this tick's chunks
 *  embedded, and late-arriving-older articles whose published_at
 *  predates the already-stored match. Tighter than the 72h dedup
 *  time window because the auto-sweep runs every 4h and overlapping
 *  windows are deliberate (each pair gets multiple chances). The
 *  full corpus stays accessible via the operator-triggered
 *  /api/admin/historical-dedup endpoint when needed. */
const AUTO_SWEEP_LOOKBACK_SECONDS = 48 * 3600;

/** Enqueue a single dedup-sweep continuation message scoped to the
 *  last {@link AUTO_SWEEP_LOOKBACK_SECONDS}. Mirrors the body shape
 *  of `/api/admin/historical-dedup`'s queue path: insert a
 *  `dedup_runs` audit row with status='running', then send one
 *  `DedupSweepMessage` carrying the seeded composite cursor.
 *  Subsequent batches re-enqueue continuation messages until the
 *  sweep reaches the corpus tail (`done: true`). */
async function enqueueAutoSweep(
  env: Env,
  scrape_run_id: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const sweepRunId = generateUlid();
  const cursorPa = now - AUTO_SWEEP_LOOKBACK_SECONDS;
  await env.DB
    .prepare(
      `INSERT INTO dedup_runs (id, status, scanned, merged, batch_count,
                               last_cursor_pa, last_cursor_id, remaining,
                               started_at, updated_at)
       VALUES (?1, 'running', 0, 0, 0, ?2, '', 0, ?3, ?3)`,
    )
    .bind(sweepRunId, cursorPa, now)
    .run();
  try {
    // `id: ''` is the lowest sortable string; the consumer's resume
    // predicate (pa = cursorPa AND id > '') is functionally
    // "everything at exactly cursorPa or newer." The operator path
    // sends `cursor: null` to start at the corpus head; the auto-path
    // is scoped to a recent window so we seed an explicit floor.
    await env.DEDUP_SWEEP.send({
      run_id: sweepRunId,
      cursor: { pa: cursorPa, id: '' },
    });
  } catch (err) {
    // Mirror the operator path: flip the run to status='failed' so
    // operators polling dedup_runs can distinguish a transient queue
    // send failure from a sweep that's genuinely still running. Swallow
    // any secondary D1 error from the UPDATE itself — the primary
    // error is the queue send failure and must reach the caller; a
    // failed status-flip would only mask it. The `status='running'`
    // guard prevents double-flipping a row that some other path
    // already moved out of running.
    try {
      await env.DB
        .prepare(
          `UPDATE dedup_runs
              SET status='failed',
                  error=?2,
                  updated_at=?3
            WHERE id=?1 AND status='running'`,
        )
        .bind(
          sweepRunId,
          (err instanceof Error ? err.message : String(err)).slice(0, 500),
          Math.floor(Date.now() / 1000),
        )
        .run();
    } catch {
      // Intentionally swallowed; original `err` below is the real
      // failure operators need to see.
    }
    throw err;
  }
  log('info', 'digest.generation', {
    status: 'finalize_auto_sweep_enqueued',
    scrape_run_id,
    sweep_run_id: sweepRunId,
    cursor_pa: cursorPa,
  });
}
