// Implements REQ-PIPE-008
//
// Cross-chunk semantic dedup pass for the global-feed pipeline.
//
// Runs once per scrape tick AFTER all chunks have written their
// articles to D1. The chunk consumer that closes the run (KV counter
// hits 0) does two things in order: it stamps the run as `ready` so
// articles become visible immediately, and it enqueues a single
// `scrape-finalize` message carrying just the `scrape_run_id`. This
// consumer picks that message up and:
//
//   1. Loads up to 250 surviving articles for the run, ordered by
//      ingested_at DESC. The SELECT pulls each article's `details`
//      body so the dedup model grounds decisions in actual content.
//   2. Calls Workers AI with FINALIZE_DEDUP_SYSTEM over the title +
//      full summary body for each candidate (source name dropped per
//      REQ-PIPE-008 AC 1), asking for `dedup_groups` over the prompt
//      indices.
//   3. For each returned group of size >= 2, picks a winner (earliest
//      published_at, id-tiebreaker) and merges the losers into it via
//      the 6-statement sequence in `src/lib/finalize-merge.ts`.
//   4. Folds tokens + cost + losers_deleted into the scrape_runs
//      row via a single atomic UPDATE that conditionally adds the
//      stats only when `finalize_recorded = 0`, then flips the
//      column to 1. Per REQ-PIPE-008 AC 7 the LLM-call cost is
//      real and must surface on the daily tally even when zero
//      merges occurred. Per-run idempotency on redelivery is
//      enforced by the same statement's gating WHERE clause
//      (migration 0010); a redelivered finalize sees
//      `finalize_recorded = 1` already and the WHERE doesn't
//      match, so no rows change and the cost is not double-counted.
//
// Articles are visible to users throughout — the merge runs in the
// background and may briefly leave duplicates visible (REQ-PIPE-008
// AC 4). On permanent failure (queue retries exhausted) we log
// `finalize_failed` and leave the articles un-merged; the run stays
// `ready` because the articles ARE real (AC 8).
//
// Idempotency invariants live in `src/lib/finalize-merge.ts` — every
// INSERT…SELECT in the merge filters on `WHERE article_id = ?loserId`
// (the article-row DELETE filters on `WHERE id = ?loserId`), so a
// retry after a successful prior pass walks an empty source set and
// is a no-op.

import { log } from '~/lib/log';
import { applyForeignKeysPragma } from '~/lib/db';
import { FALLBACK_MODEL_ID } from '~/lib/models';
import { FINALIZE_DEDUP_SYSTEM, finalizeDedupUserPrompt, FINALIZE_LLM_PARAMS } from '~/lib/prompts';
import { parseLLMJson } from '~/lib/generate';
import { runJsonWithFallback } from '~/lib/llm-json';
import { pickWinner, buildMergeStatements, type FinalizeRow } from '~/lib/finalize-merge';
import { normaliseRawDedupGroups } from '~/lib/dedupe';
import { handleBatch } from '~/lib/queue-handler';

/** Hard cap on candidates per finalize call. Comfortable headroom over
 *  current production loads (~150-200 articles per tick) and well
 *  under the LLM's input-token budget. Runs that produced more articles
 *  skip dedup on the tail (REQ-PIPE-008 AC 6). */
const FINALIZE_CANDIDATE_CAP = 250;

/** Message shape for the SCRAPE_FINALIZE queue. */
export interface FinalizeJobMessage {
  scrape_run_id: string;
}

/** Row shape returned by the per-run article fetch. `details` is the
 *  full summary body the chunk consumer wrote; the dedup prompt
 *  consumes it directly (REQ-PIPE-008 AC 1). */
interface ArticleRow {
  id: string;
  title: string;
  details: string;
  published_at: number;
  ingested_at: number;
}

/** Handle one batch of `scrape-finalize` messages. Delegates to the
 *  shared `handleBatch` envelope. Per REQ-PIPE-008 AC 8 we deliberately
 *  do NOT pass `onTerminalFailure` — the run is already `ready` from
 *  the chunk consumer's last-chunk write, the articles are visible,
 *  and only the cross-chunk merge is missing. Operators investigate
 *  via the `finalize_failed` log event. */
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
  // safety net (two concurrent redeliveries can both pass this SELECT
  // and only one will win the UPDATE). The upfront check exists to
  // avoid paying full Workers AI cost on every redelivery for runs
  // that already finalized cleanly — under Queue redelivery storms
  // that becomes real money. A miss here just falls through to the
  // existing path; it never produces a wrong outcome.
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

  // Step 1 — load surviving articles for the run, capped at 250 by
  // ingested_at DESC so we always prioritise the freshest tail when
  // the cap bites.
  const result = await env.DB
    .prepare(
      `SELECT id, title, details, published_at, ingested_at
         FROM articles
        WHERE scrape_run_id = ?1
        ORDER BY ingested_at DESC
        LIMIT ?2`,
    )
    .bind(body.scrape_run_id, FINALIZE_CANDIDATE_CAP)
    .all<ArticleRow>();
  const rows: ArticleRow[] = result.results ?? [];

  // Step 2 — skip the LLM call when there's nothing to dedup. AC 1.
  if (rows.length <= 1) {
    log('info', 'digest.generation', {
      status: 'finalize_noop',
      scrape_run_id: body.scrape_run_id,
      article_count: rows.length,
    });
    return;
  }

  // Step 3 — build the prompt. Index aligns to row position in `rows`
  // so the LLM's dedup_groups indices map directly back. Title +
  // full body per REQ-PIPE-008 AC 1; source name deliberately
  // omitted as a non-signal.
  const candidates = rows.map((r, idx) => ({
    index: idx,
    title: r.title,
    details: r.details,
    published_at: r.published_at,
  }));

  // Step 4 — primary-then-fallback retry centralised in
  // src/lib/llm-json.ts (CF-009) so chunk + finalize share identical
  // waste-cost accounting and single-attempt narrowing.
  const llmRun = await runJsonWithFallback({
    ai: env.AI as unknown as { run: (m: string, p: Record<string, unknown>) => Promise<unknown> },
    params: {
      messages: [
        { role: 'system', content: FINALIZE_DEDUP_SYSTEM },
        { role: 'user', content: finalizeDedupUserPrompt(candidates) },
      ],
      ...FINALIZE_LLM_PARAMS,
    },
    narrow: (raw) => parseLLMJson(raw),
    onPrimaryFailure: (info) => {
      log('warn', 'digest.generation', {
        status: 'finalize_invalid_json_fallback_try',
        scrape_run_id: body.scrape_run_id,
        primary_model: info.modelUsed,
        fallback_model: FALLBACK_MODEL_ID,
        primary_tokens_in: info.tokensIn,
        primary_tokens_out: info.tokensOut,
        primary_cost_usd: info.costUsd,
      });
    },
  });

  if (!llmRun.ok) {
    log('error', 'digest.generation', {
      status: 'finalize_invalid_json',
      scrape_run_id: body.scrape_run_id,
      fallback_model: llmRun.fallback.modelUsed,
    });
    throw new Error('finalize_invalid_json');
  }

  const parsed = llmRun.parsed;
  const modelUsed = llmRun.modelUsed;
  const wastedTokensIn = llmRun.wastedTokensIn;
  const wastedTokensOut = llmRun.wastedTokensOut;
  const wastedCostUsd = llmRun.wastedCostUsd;

  // Step 5 — extract dedup_groups from the parsed payload.
  const dedupGroups = normaliseRawDedupGroups(
    (parsed as { dedup_groups?: unknown }).dedup_groups,
  );

  // Step 6 — for each group of size >= 2, pick a winner and assemble
  // the merge statements for every loser.
  const statements: D1PreparedStatement[] = [];
  let losersDeleted = 0;
  let groupsMerged = 0;
  for (const group of dedupGroups) {
    // Resolve indices to row objects, drop any out-of-range entries
    // the LLM might emit (shouldn't happen given a strict prompt; the
    // belt-and-suspenders matters for production safety).
    const groupRows: FinalizeRow[] = [];
    for (const idx of group) {
      const row = rows[idx];
      if (row !== undefined) groupRows.push(toFinalizeRow(row));
    }
    if (groupRows.length < 2) continue;
    const winner = pickWinner(groupRows);
    const losers = groupRows.filter((r) => r.id !== winner.id);
    for (const loser of losers) {
      const merge = buildMergeStatements(env.DB, winner.id, loser.id);
      for (const stmt of merge) statements.push(stmt);
    }
    losersDeleted += losers.length;
    groupsMerged += 1;
  }

  // Step 7 — execute the batch atomically. D1 rolls back the whole
  // batch on any statement failure, so a partial merge can't land.
  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  // Step 8 — fold cost into the run's totals. The previous gate
  // `if (losersDeleted > 0)` hid the cost of every finalize call
  // that returned zero merges, even though Workers AI was billed
  // for the call. Per REQ-PIPE-008 AC 7 (revised 2026-05-03) the
  // cost is recorded on the first successful LLM call regardless
  // of merge outcome.
  //
  // Idempotency on queue redelivery is enforced by a single atomic
  // UPDATE that adds the stats AND flips `finalize_recorded`,
  // gated by a `WHERE id = ?1 AND finalize_recorded = 0` clause:
  //
  //   UPDATE scrape_runs
  //      SET finalize_recorded = 1,
  //          tokens_in = tokens_in + ?2,
  //          ...
  //    WHERE id = ?1 AND finalize_recorded = 0
  //
  // On the first pass the WHERE matches, every SET clause fires,
  // and `meta.changes === 1`. On every redelivery the row's
  // `finalize_recorded` is already 1, the WHERE doesn't match,
  // zero rows change, and the cost is not double-counted. The
  // single-statement gate also rules out the prior split-update
  // failure mode: a transient error inside the statement rolls
  // back BOTH the gate flip and the cost add, so a retry can
  // re-record cleanly. AC 5 + AC 7. Counters from
  // runJsonWithFallback (CF-009).
  const tokensIn = llmRun.tokensIn + wastedTokensIn;
  const tokensOut = llmRun.tokensOut + wastedTokensOut;
  const costUsd = llmRun.costUsd + wastedCostUsd;
  // Single atomic UPDATE that flips the gate AND adds the stats only
  // when the row's `finalize_recorded` is currently 0. On the first
  // successful pass the WHERE matches and every SET clause fires
  // (cost recorded, gate flipped, meta.changes === 1). On every
  // queue redelivery the WHERE doesn't match (gate already 1) and
  // nothing changes (meta.changes === 0, cost not double-counted).
  // The previous split — gate UPDATE then `addChunkStats` UPDATE —
  // was non-atomic and would leave the gate flipped if the second
  // call failed, permanently hiding that tick's spend.
  const gateAndStats = await env.DB
    .prepare(
      `UPDATE scrape_runs
          SET finalize_recorded = 1,
              tokens_in = tokens_in + ?2,
              tokens_out = tokens_out + ?3,
              estimated_cost_usd = estimated_cost_usd + ?4,
              articles_ingested = articles_ingested + ?5,
              articles_deduped = articles_deduped + ?6
        WHERE id = ?1 AND finalize_recorded = 0`,
    )
    .bind(body.scrape_run_id, tokensIn, tokensOut, costUsd, 0, losersDeleted)
    .run();
  const wonRecording = (gateAndStats.meta?.changes ?? 0) === 1;

  if (wonRecording) {
    log('info', 'digest.generation', {
      status: 'finalize_ready',
      scrape_run_id: body.scrape_run_id,
      article_count: rows.length,
      groups_merged: groupsMerged,
      losers_deleted: losersDeleted,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      estimated_cost_usd: costUsd,
      cost_recorded: true,
      model_used: modelUsed,
      capped_at_250: rows.length === FINALIZE_CANDIDATE_CAP,
    });
  } else {
    // Race lost to a concurrent redelivery that finished first.
    // Only the fields that describe the outcome of THIS attempt go
    // here — the per-row counters were already absorbed by the
    // winning attempt and would mislead operators if repeated.
    log('info', 'digest.generation', {
      status: 'finalize_redelivery_skipped',
      scrape_run_id: body.scrape_run_id,
      model_used: modelUsed,
      reason: 'race_lost',
    });
  }
}

function toFinalizeRow(r: ArticleRow): FinalizeRow {
  return {
    id: r.id,
    title: r.title,
    published_at: r.published_at,
  };
}
