// Implements REQ-PIPE-003 AC 9
// Implements REQ-PIPE-009
//
// Self-chaining queue consumer that drives the historical same-story
// sweep across the entire embedded article pool without requiring a
// browser tab to keep posting batch requests. One queue message ==
// one bounded batch (the existing `runHistoricalDedupBatch` body); the
// consumer updates the `dedup_runs` audit row, then either re-enqueues
// a continuation message (next cursor) or flips the row terminal
// (status='done').
//
// Why a queue rather than `ctx.waitUntil(self_url)` self-chain:
//   - `waitUntil` extends the current isolate's CPU budget; a long
//     chain still pays the per-request edge cut on every hop.
//   - Queue messages cross isolate boundaries cleanly. Each batch gets
//     a fresh ~30s CPU budget; transient failures retry via the
//     standard queue retry envelope (`handleBatch` + max_retries from
//     wrangler.toml).
//   - Self-chaining over queues is the same pattern the chunk → finalize
//     handoff already uses (REQ-PIPE-008), so operators have one mental
//     model for "background pipeline work continues without a tab".
//
// On terminal queue retry exhaustion the consumer flips the
// `dedup_runs` row to `status='failed'` so the polling endpoint
// surfaces the failure to the operator. The sweep can be resumed by
// clicking "Full pipeline run" again — a fresh run_id starts a new
// row and walks the corpus from the head; merges already applied
// produce no new merges (idempotent by construction).

import { log } from '~/lib/log';
import { handleBatch } from '~/lib/queue-handler';
import {
  runHistoricalDedupBatch,
  DEFAULT_BATCH,
} from '~/lib/historical-dedup';
import type { DedupCursor } from '~/lib/historical-dedup';

/** Queue message envelope. `cursor: null` on the first message in a
 *  run — the sweep starts at the corpus head. Subsequent messages
 *  carry the composite cursor returned by the previous batch. */
export interface DedupSweepMessage {
  run_id: string;
  cursor: DedupCursor | null;
  /** Per-batch size override; defaults to DEFAULT_BATCH (25) when
   *  unset so the kicker doesn't have to reach into the dedup helper
   *  to pick a sensible default. Capped server-side at MAX_BATCH. */
  batch?: number;
}

/** Handle one batch of `dedup-sweep` messages. We do NOT pass an
 *  `onTerminalFailure` because the failure side-effect we want is not
 *  "mark the parent run failed automatically" but rather "flip the
 *  audit row's status to 'failed' with the error detail" — and that
 *  shape doesn't match the generic `onTerminalFailure(env, body)`
 *  contract (the generic helper has no access to the message attempt
 *  count vs. max-retries inside the body). Instead, the per-message
 *  processor catches its own throw, writes the failure row, and
 *  re-throws so the queue still retries. */
export async function handleDedupSweepBatch(
  batch: MessageBatch<DedupSweepMessage>,
  env: Env,
): Promise<void> {
  await handleBatch(batch, env, {
    process: processOneDedupSweep,
    throwLogStatus: 'dedup_sweep_throw',
    extraLogFields: (body) => ({
      dedup_run_id: body.run_id,
      cursor_pa: body.cursor?.pa ?? null,
      cursor_id: body.cursor?.id ?? null,
    }),
    onTerminalFailure: async (env, body) => {
      // Last-ditch update: flip the audit row to 'failed' so the
      // polling endpoint stops reporting 'running' indefinitely. The
      // per-batch processor already best-effort-writes the error
      // detail; this UPDATE is the catch-all for the case where the
      // processor's own UPDATE itself threw (e.g., D1 transient).
      try {
        const now = Math.floor(Date.now() / 1000);
        await env.DB
          .prepare(
            `UPDATE dedup_runs
                SET status = 'failed',
                    updated_at = ?2,
                    error = COALESCE(error, 'terminal queue retry exhaustion')
              WHERE id = ?1
                AND status = 'running'`,
          )
          .bind(body.run_id, now)
          .run();
      } catch (err) {
        log('error', 'digest.generation', {
          status: 'dedup_sweep_terminal_update_failed',
          dedup_run_id: body.run_id,
          detail: String(err).slice(0, 500),
        });
      }
    },
    terminalFailureLogStatus: 'dedup_sweep_terminal_update_failed',
  });
}

/** Process exactly one sweep batch end-to-end. Exported for direct
 *  unit testing without a queue envelope. */
export async function processOneDedupSweep(
  env: Env,
  body: DedupSweepMessage,
): Promise<void> {
  // Step 0 — short-circuit on already-terminal runs. The audit row
  // moves to 'done' or 'failed' after the last batch; a queue
  // redelivery should not re-run the sweep. We also exit early on a
  // missing row so a stale message after the table is wiped doesn't
  // recreate state.
  const probe = await env.DB
    .prepare(`SELECT status FROM dedup_runs WHERE id = ?1`)
    .bind(body.run_id)
    .first<{ status: string }>();
  if (probe === null) {
    log('warn', 'digest.generation', {
      status: 'dedup_sweep_missing_run',
      dedup_run_id: body.run_id,
    });
    return;
  }
  if (probe.status !== 'running') {
    log('info', 'digest.generation', {
      status: 'dedup_sweep_skip_terminal',
      dedup_run_id: body.run_id,
      run_status: probe.status,
    });
    return;
  }

  const batchSize = body.batch ?? DEFAULT_BATCH;

  let result: Awaited<ReturnType<typeof runHistoricalDedupBatch>>;
  try {
    result = await runHistoricalDedupBatch(env, body.cursor, batchSize);
  } catch (err) {
    const detail = String(err).slice(0, 500);
    // Best-effort: stamp the error onto the audit row so the polling
    // endpoint reports it. Do NOT flip status here — let the queue
    // retry first. status flips to 'failed' on terminal exhaustion via
    // onTerminalFailure above.
    try {
      const now = Math.floor(Date.now() / 1000);
      await env.DB
        .prepare(
          `UPDATE dedup_runs
              SET error = ?2,
                  updated_at = ?3
            WHERE id = ?1`,
        )
        .bind(body.run_id, detail, now)
        .run();
    } catch {
      /* swallow — primary error is already logged via handleBatch */
    }
    throw err;
  }

  // Step 1 — fold this batch's progress into the audit row.
  //
  // CAS guard on the incoming cursor: queues are at-least-once, so a
  // redelivered message must not double-increment scanned/merged/
  // batch_count. We require the saved last_cursor to equal THIS
  // message's incoming cursor — true for the natural first delivery
  // (saved was advanced by the previous batch to exactly this point),
  // false for a redelivery (saved already moved on to the outgoing
  // cursor on the original successful run). On CAS skip, meta.changes
  // is 0 and we log the skip; we still attempt the continuation send
  // below because the original send may itself have failed (which is
  // how this redelivery happened in the first place).
  //
  // Trade-off (explicit): "always send on skip" can briefly fork the
  // chain — if the original message both UPDATEd successfully AND
  // sent its continuation, then was redelivered (worker preempted
  // before ack), the redelivery's send re-enqueues a duplicate
  // continuation. Each downstream consumer's own CAS rejects exactly
  // one of the duplicates per advance, so counters stay truthful and
  // the chain converges in linear time. Wasted CPU is bounded; data
  // integrity is preserved. The alternative — skip the send on CAS
  // miss — silently kills the chain whenever the original send was
  // the actual failure, which is the worse failure mode.
  const now = Math.floor(Date.now() / 1000);
  const newStatus = result.done ? 'done' : 'running';
  const updateMeta = await env.DB
    .prepare(
      `UPDATE dedup_runs
          SET status = ?2,
              scanned = scanned + ?3,
              merged = merged + ?4,
              batch_count = batch_count + 1,
              last_cursor_pa = ?5,
              last_cursor_id = ?6,
              remaining = ?7,
              updated_at = ?8,
              error = NULL
        WHERE id = ?1
          AND status = 'running'
          AND last_cursor_pa IS ?9
          AND last_cursor_id IS ?10`,
    )
    .bind(
      body.run_id,
      newStatus,
      result.scanned,
      result.merged,
      result.next_cursor?.pa ?? null,
      result.next_cursor?.id ?? null,
      result.remaining,
      now,
      body.cursor?.pa ?? null,
      body.cursor?.id ?? null,
    )
    .run();

  const applied = (updateMeta.meta?.changes ?? 0) > 0;
  log('info', 'digest.generation', {
    status: applied ? 'dedup_sweep_batch_done' : 'dedup_sweep_batch_skip_retry',
    dedup_run_id: body.run_id,
    scanned: result.scanned,
    merged: result.merged,
    remaining: result.remaining,
    next_cursor_pa: result.next_cursor?.pa ?? null,
    next_cursor_id: result.next_cursor?.id ?? null,
    done: result.done,
    cas_applied: applied,
  });

  // Step 2 — chain the next batch when the sweep is not yet complete.
  // The send is best-effort fire-and-forget; if the queue producer
  // throws, the per-message handler will rethrow and the queue retry
  // re-runs THIS batch (which is idempotent — the audit row's
  // status='running' guard above would short-circuit if a
  // double-process landed) and re-attempts the enqueue.
  if (!result.done && result.next_cursor !== null) {
    const next: DedupSweepMessage = {
      run_id: body.run_id,
      cursor: result.next_cursor,
    };
    if (body.batch !== undefined) {
      next.batch = body.batch;
    }
    await env.DEDUP_SWEEP.send(next);
  }
}
