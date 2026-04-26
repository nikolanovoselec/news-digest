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
//      ingested_at DESC.
//   2. Calls Workers AI with FINALIZE_DEDUP_SYSTEM over the title +
//      source list, asking for `dedup_groups` over the prompt indices.
//   3. For each returned group of size >= 2, picks a winner (earliest
//      published_at, id-tiebreaker) and merges the losers into it via
//      the 6-statement sequence in `src/lib/finalize-merge.ts`.
//   4. Folds tokens + cost + losers_deleted into `addChunkStats` so
//      the scrape_runs row reflects the full dedup work done for the
//      tick.
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
// is a no-op. `addChunkStats` is the only non-idempotent side effect;
// we gate it on `losersDeleted > 0` so a clean retry doesn't
// double-count.

import { log } from '~/lib/log';
import { applyForeignKeysPragma, batch as batchExec } from '~/lib/db';
import { addChunkStats } from '~/lib/scrape-run';
import { DEFAULT_MODEL_ID, FALLBACK_MODEL_ID, estimateCost } from '~/lib/models';
import { FINALIZE_DEDUP_SYSTEM, finalizeDedupUserPrompt, LLM_PARAMS } from '~/lib/prompts';
import {
  extractResponsePayload,
  extractTokensIn,
  extractTokensOut,
  parseLLMJson,
  type AIRunResponse,
} from '~/lib/generate';
import { pickWinner, buildMergeStatements, type FinalizeRow } from '~/lib/finalize-merge';

/** Hard cap on candidates per finalize call. Comfortable headroom over
 *  current production loads (~150-200 articles per tick) and well
 *  under the LLM's input-token budget. Runs that produced more articles
 *  skip dedup on the tail (REQ-PIPE-008 AC 6). */
const FINALIZE_CANDIDATE_CAP = 250;

/** Message shape for the SCRAPE_FINALIZE queue. */
export interface FinalizeJobMessage {
  scrape_run_id: string;
}

/** Row shape returned by the per-run article fetch. */
interface ArticleRow {
  id: string;
  title: string;
  primary_source_name: string;
  published_at: number;
  ingested_at: number;
}

/** Handle one batch of `scrape-finalize` messages. Queues sets
 *  `max_batch_size = 1` in wrangler.toml so this loop is almost always
 *  length 1; we still iterate to be safe and never let a sibling
 *  message's failure poison the others. */
export async function handleFinalizeBatch(
  batch: MessageBatch<FinalizeJobMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processOneFinalize(env, message.body);
      message.ack();
    } catch (err) {
      log('error', 'digest.generation', {
        status: 'finalize_failed',
        scrape_run_id: message.body.scrape_run_id,
        attempts: message.attempts,
        detail: String(err).slice(0, 500),
      });
      // Per REQ-PIPE-008 AC 8: never flip the run from `ready` to
      // `failed` here. The articles are real and visible; only the
      // cross-chunk merge is missing. Operators investigate via the
      // `finalize_failed` log event.
      message.retry();
    }
  }
}

/** Process a single finalize message end-to-end. Exported for direct
 *  unit testing without faking the queue batch envelope. */
export async function processOneFinalize(
  env: Env,
  body: FinalizeJobMessage,
): Promise<void> {
  await applyForeignKeysPragma(env.DB);

  // Step 1 — load surviving articles for the run, capped at 250 by
  // ingested_at DESC so we always prioritise the freshest tail when
  // the cap bites.
  const result = await env.DB
    .prepare(
      `SELECT id, title, primary_source_name, published_at, ingested_at
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
  // so the LLM's dedup_groups indices map directly back.
  const candidates = rows.map((r, idx) => ({
    index: idx,
    title: r.title,
    source_name: r.primary_source_name,
    published_at: r.published_at,
  }));

  const ai = env.AI as unknown as {
    run: (model: string, params: Record<string, unknown>) => Promise<AIRunResponse>;
  };
  const runLLM = async (modelId: string): Promise<AIRunResponse> =>
    ai.run(modelId, {
      messages: [
        { role: 'system', content: FINALIZE_DEDUP_SYSTEM },
        { role: 'user', content: finalizeDedupUserPrompt(candidates) },
      ],
      ...LLM_PARAMS,
    });

  // Step 4 — primary call, then fall back to the JSON-strict secondary
  // model if the primary returns malformed JSON. Mirrors the chunk
  // consumer's pattern at scrape-chunk-consumer.ts:230-296.
  let modelUsed = DEFAULT_MODEL_ID;
  let aiResult = await runLLM(modelUsed);
  let rawResponse = extractResponsePayload(aiResult);
  let parsed = parseLLMJson(rawResponse);

  let wastedTokensIn = 0;
  let wastedTokensOut = 0;
  let wastedCostUsd = 0;

  if (parsed === null) {
    wastedTokensIn = extractTokensIn(aiResult);
    wastedTokensOut = extractTokensOut(aiResult);
    wastedCostUsd = estimateCost(DEFAULT_MODEL_ID, wastedTokensIn, wastedTokensOut);
    log('warn', 'digest.generation', {
      status: 'finalize_invalid_json_fallback_try',
      scrape_run_id: body.scrape_run_id,
      primary_model: DEFAULT_MODEL_ID,
      fallback_model: FALLBACK_MODEL_ID,
      primary_tokens_in: wastedTokensIn,
      primary_tokens_out: wastedTokensOut,
      primary_cost_usd: wastedCostUsd,
    });
    modelUsed = FALLBACK_MODEL_ID;
    aiResult = await runLLM(modelUsed);
    rawResponse = extractResponsePayload(aiResult);
    parsed = parseLLMJson(rawResponse);
    if (parsed === null) {
      log('error', 'digest.generation', {
        status: 'finalize_invalid_json',
        scrape_run_id: body.scrape_run_id,
        fallback_model: FALLBACK_MODEL_ID,
      });
      throw new Error('finalize_invalid_json');
    }
  }

  // Step 5 — extract dedup_groups from the parsed payload.
  const dedupGroups = normaliseDedupGroups(
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
    await batchExec(env.DB, statements);
  }

  // Step 8 — fold cost into the run's totals. Gate on losersDeleted > 0
  // so a clean retry (every loser already deleted, zero merges performed)
  // doesn't double-count tokens. AC 5 + AC 7.
  const successTokensIn = extractTokensIn(aiResult);
  const successTokensOut = extractTokensOut(aiResult);
  const tokensIn = successTokensIn + wastedTokensIn;
  const tokensOut = successTokensOut + wastedTokensOut;
  const costUsd = estimateCost(modelUsed, successTokensIn, successTokensOut) + wastedCostUsd;
  if (losersDeleted > 0) {
    await addChunkStats(env.DB, body.scrape_run_id, {
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      estimated_cost_usd: costUsd,
      articles_ingested: 0,
      articles_deduped: losersDeleted,
    });
  }

  log('info', 'digest.generation', {
    status: 'finalize_ready',
    scrape_run_id: body.scrape_run_id,
    article_count: rows.length,
    groups_merged: groupsMerged,
    losers_deleted: losersDeleted,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    estimated_cost_usd: costUsd,
    model_used: modelUsed,
    capped_at_250: rows.length === FINALIZE_CANDIDATE_CAP,
  });
}

/** Coerce the LLM's `dedup_groups` payload into a clean `number[][]`.
 *  Same defensive shape-check the chunk consumer applies at
 *  scrape-chunk-consumer.ts:696. */
function normaliseDedupGroups(value: unknown): number[][] {
  if (!Array.isArray(value)) return [];
  const out: number[][] = [];
  for (const group of value) {
    if (!Array.isArray(group)) continue;
    // Dedupe indices within a group: an LLM that emits `[0, 1, 1]` would
    // otherwise inflate `losers_deleted` and queue redundant merge SQL
    // for the duplicated index. Set-uniquing collapses each occurrence.
    const seen = new Set<number>();
    for (const idx of group) {
      if (Number.isInteger(idx) && (idx as number) >= 0) {
        seen.add(idx as number);
      }
    }
    if (seen.size >= 2) out.push(Array.from(seen));
  }
  return out;
}

function toFinalizeRow(r: ArticleRow): FinalizeRow {
  return {
    id: r.id,
    title: r.title,
    source_name: r.primary_source_name,
    published_at: r.published_at,
  };
}
