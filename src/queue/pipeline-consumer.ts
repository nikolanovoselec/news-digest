// Implements REQ-OPS-008
//
// Backend-driven full pipeline orchestrator. The /settings "Full
// pipeline run" button now POSTs once to /api/admin/pipeline-run and
// gets back a `pipeline_runs.id`. Everything after that — the embed
// drains, the scrape kick + wait, the dedup kick + wait — is driven
// by self-chained `pipeline-jobs` queue messages handled here. The
// browser tab only polls `/api/admin/pipeline-status?id=...` for
// display; closing the tab does not interrupt the orchestration.
//
// Why a queue-driven self-chain instead of the previous browser loop:
//   - Mobile tabs throttle and sleep aggressively. The previous
//     settings.astro `while(!done) fetch(/api/admin/embed-backfill)`
//     pattern silently halted whenever the tab slept, so dedup_kick
//     never ran, and duplicate articles persisted on prod (this is
//     exactly the failure mode that motivated REQ-OPS-008).
//   - The historical-dedup sweep already proved this pattern at one
//     level down (`dedup_runs` + `dedup-sweep-consumer`); this consumer
//     is the same shape one level up over the seven phases.
//
// Phase progression (advanced via self-chained `pipeline-jobs` messages):
//
//     reembed_flip → reembed_drain ──┐
//                                    │
//     scrape_kick → scrape_wait → embed_drain → dedup_kick → dedup_wait → done
//                       ↑                                       ↑
//                       └─ delaySeconds re-enqueue              └─ delaySeconds re-enqueue
//                          while scrape_runs.status='running'      while dedup_runs.status='running'
//
// `mode='full'`  starts at scrape_kick (refresh + dedup, embeddings reused).
// `mode='wipe'`  starts at reembed_flip (re-embed everything before scraping).
//
// Each phase handler:
//   1. Reads the audit row (short-circuits if status != 'running').
//   2. Performs its phase work.
//   3. UPDATEs the audit row (current_phase, scrape_run_id, etc.).
//   4. Either sends the next `pipeline-jobs` message (with optional
//      delaySeconds for wait phases) or stamps status='done'/'failed'.
//
// At-least-once tolerance: queue redelivery would re-run a phase. The
// short-circuit on status + the per-phase idempotence (UPDATE … WHERE
// current_phase = expected) keeps that safe — a redelivered phase
// observes its own UPDATE already landed and moves on.

import { log } from '~/lib/log';
import { handleBatch } from '~/lib/queue-handler';
import { generateUlid } from '~/lib/ulid';
import { kickCoordinator } from '~/lib/kick-coordinator';
import { runOneBackfillBatch } from '~/pages/api/admin/embed-backfill';
import { DEFAULT_BATCH as DEDUP_DEFAULT_BATCH } from '~/lib/historical-dedup';

/** Phase tags written to `pipeline_runs.current_phase` and carried in
 *  every `pipeline-jobs` message body. */
export type PipelinePhase =
  | 'reembed_flip'
  | 'reembed_drain'
  | 'scrape_kick'
  | 'scrape_wait'
  | 'embed_drain'
  | 'dedup_kick'
  | 'dedup_wait'
  | 'done';

export interface PipelineJobMessage {
  pipeline_run_id: string;
  phase: PipelinePhase;
}

interface PipelineRunRow {
  id: string;
  status: 'running' | 'done' | 'failed';
  mode: 'full' | 'wipe';
  current_phase: PipelinePhase;
  scrape_run_id: string | null;
  dedup_run_id: string | null;
  embed_processed: number;
  embed_remaining: number;
}

/** How long scrape_wait / dedup_wait sleep before re-checking. Queue
 *  delaySeconds is the platform-native way to back off without burning
 *  a worker isolate; 10s keeps the operator's polling responsive
 *  without hammering D1. */
const WAIT_DELAY_SECONDS = 10;

/** Maximum number of embed-drain self-chain hops before bailing. Each
 *  hop processes ~50 articles via runOneBackfillBatch — a 1000-article
 *  re-embed therefore costs ~20 hops. Cap at 200 (10k articles) so a
 *  pathological loop can't spin forever. */
const EMBED_DRAIN_MAX_HOPS = 200;

export async function handlePipelineJobsBatch(
  batch: MessageBatch<PipelineJobMessage>,
  env: Env,
): Promise<void> {
  await handleBatch(batch, env, {
    process: processOnePipelineMessage,
    throwLogStatus: 'pipeline_jobs_throw',
    extraLogFields: (body) => ({
      pipeline_run_id: body.pipeline_run_id,
      phase: body.phase,
    }),
    onTerminalFailure: async (envInner, body) => {
      try {
        const now = Math.floor(Date.now() / 1000);
        await envInner.DB
          .prepare(
            `UPDATE pipeline_runs
                SET status = 'failed',
                    updated_at = ?2,
                    error = COALESCE(error, 'terminal queue retry exhaustion')
              WHERE id = ?1
                AND status = 'running'`,
          )
          .bind(body.pipeline_run_id, now)
          .run();
      } catch (err) {
        log('error', 'digest.generation', {
          status: 'pipeline_jobs_terminal_update_failed',
          pipeline_run_id: body.pipeline_run_id,
          phase: body.phase,
          detail: String(err).slice(0, 500),
        });
      }
    },
    terminalFailureLogStatus: 'pipeline_jobs_terminal_update_failed',
  });
}

export async function processOnePipelineMessage(
  env: Env,
  body: PipelineJobMessage,
): Promise<void> {
  const probe = await env.DB
    .prepare(
      `SELECT id, status, mode, current_phase, scrape_run_id, dedup_run_id,
              embed_processed, embed_remaining
         FROM pipeline_runs WHERE id = ?1`,
    )
    .bind(body.pipeline_run_id)
    .first<PipelineRunRow>();

  if (probe === null) {
    log('warn', 'digest.generation', {
      status: 'pipeline_jobs_missing_run',
      pipeline_run_id: body.pipeline_run_id,
      phase: body.phase,
    });
    return;
  }
  if (probe.status !== 'running') {
    log('info', 'digest.generation', {
      status: 'pipeline_jobs_skip_terminal',
      pipeline_run_id: body.pipeline_run_id,
      phase: body.phase,
      run_status: probe.status,
    });
    return;
  }

  switch (body.phase) {
    case 'reembed_flip':
      await runReembedFlip(env, probe);
      return;
    case 'reembed_drain':
      await runReembedDrain(env, probe);
      return;
    case 'scrape_kick':
      await runScrapeKick(env, probe);
      return;
    case 'scrape_wait':
      await runScrapeWait(env, probe);
      return;
    case 'embed_drain':
      await runEmbedDrain(env, probe);
      return;
    case 'dedup_kick':
      await runDedupKick(env, probe);
      return;
    case 'dedup_wait':
      await runDedupWait(env, probe);
      return;
    case 'done':
      log('info', 'digest.generation', {
        status: 'pipeline_jobs_done_redelivered',
        pipeline_run_id: probe.id,
      });
      return;
    default: {
      const phase: never = body.phase;
      throw new Error(`unknown pipeline phase: ${String(phase)}`);
    }
  }
}

async function runReembedFlip(env: Env, run: PipelineRunRow): Promise<void> {
  await env.DB
    .prepare(`UPDATE articles SET embedding_status = 'failed'`)
    .run();
  await advancePhase(env, run.id, 'reembed_flip', 'reembed_drain');
  await env.PIPELINE_JOBS.send({
    pipeline_run_id: run.id,
    phase: 'reembed_drain',
  });
  log('info', 'digest.generation', {
    status: 'pipeline_phase_complete',
    pipeline_run_id: run.id,
    phase: 'reembed_flip',
  });
}

async function runReembedDrain(env: Env, run: PipelineRunRow): Promise<void> {
  await runEmbedDrainShared(env, run, 'reembed_drain', 'scrape_kick');
}

async function runScrapeKick(env: Env, run: PipelineRunRow): Promise<void> {
  const { run_id: scrapeRunId, reused } = await kickCoordinator(env);
  const now = Math.floor(Date.now() / 1000);
  await env.DB
    .prepare(
      `UPDATE pipeline_runs
          SET current_phase = 'scrape_wait',
              scrape_run_id = ?2,
              updated_at = ?3
        WHERE id = ?1
          AND status = 'running'
          AND current_phase = 'scrape_kick'`,
    )
    .bind(run.id, scrapeRunId, now)
    .run();
  await env.PIPELINE_JOBS.send({
    pipeline_run_id: run.id,
    phase: 'scrape_wait',
  });
  log('info', 'digest.generation', {
    status: 'pipeline_phase_complete',
    pipeline_run_id: run.id,
    phase: 'scrape_kick',
    scrape_run_id: scrapeRunId,
    reused,
  });
}

async function runScrapeWait(env: Env, run: PipelineRunRow): Promise<void> {
  if (run.scrape_run_id === null) {
    throw new Error('pipeline_run scrape_wait without scrape_run_id');
  }
  const row = await env.DB
    .prepare(
      `SELECT status, finalize_recorded FROM scrape_runs WHERE id = ?1`,
    )
    .bind(run.scrape_run_id)
    .first<{ status: string; finalize_recorded: number }>();

  // Advance once both: scrape_runs.status != 'running' AND finalize
  // has been recorded (the finalize-consumer is the last writer of
  // articles_deduped + the dedup pass). Otherwise re-enqueue.
  const scrapeReady =
    row !== null &&
    row.status !== 'running' &&
    row.finalize_recorded === 1;

  if (!scrapeReady) {
    await env.PIPELINE_JOBS.send(
      { pipeline_run_id: run.id, phase: 'scrape_wait' },
      { delaySeconds: WAIT_DELAY_SECONDS },
    );
    log('info', 'digest.generation', {
      status: 'pipeline_phase_waiting',
      pipeline_run_id: run.id,
      phase: 'scrape_wait',
      scrape_run_id: run.scrape_run_id,
      scrape_status: row?.status ?? 'missing',
      finalize_recorded: row?.finalize_recorded ?? 0,
    });
    return;
  }

  if (row.status === 'failed') {
    await markFailed(env, run.id, 'scrape_failed');
    return;
  }

  await advancePhase(env, run.id, 'scrape_wait', 'embed_drain');
  await env.PIPELINE_JOBS.send({
    pipeline_run_id: run.id,
    phase: 'embed_drain',
  });
  log('info', 'digest.generation', {
    status: 'pipeline_phase_complete',
    pipeline_run_id: run.id,
    phase: 'scrape_wait',
    scrape_run_id: run.scrape_run_id,
  });
}

async function runEmbedDrain(env: Env, run: PipelineRunRow): Promise<void> {
  await runEmbedDrainShared(env, run, 'embed_drain', 'dedup_kick');
}

/** Shared between reembed_drain and embed_drain — both are "drain
 *  embedding_status IN (NULL,'failed') one batch at a time, self-
 *  chain until empty". */
async function runEmbedDrainShared(
  env: Env,
  run: PipelineRunRow,
  phase: 'reembed_drain' | 'embed_drain',
  nextPhase: 'scrape_kick' | 'dedup_kick',
): Promise<void> {
  const result = await runOneBackfillBatch(env);
  const now = Math.floor(Date.now() / 1000);
  const cumulative = run.embed_processed + result.processed;

  if (result.done) {
    await env.DB
      .prepare(
        `UPDATE pipeline_runs
            SET current_phase = ?2,
                embed_processed = ?3,
                embed_remaining = 0,
                updated_at = ?4
          WHERE id = ?1
            AND status = 'running'
            AND current_phase = ?5`,
      )
      .bind(run.id, nextPhase, cumulative, now, phase)
      .run();
    await env.PIPELINE_JOBS.send({
      pipeline_run_id: run.id,
      phase: nextPhase,
    });
    log('info', 'digest.generation', {
      status: 'pipeline_phase_complete',
      pipeline_run_id: run.id,
      phase,
      processed_total: cumulative,
    });
    return;
  }

  // Forward-progress guard: a batch with processed===0 and !done means
  // the AI / Vectorize side is failing. Mark the pipeline failed
  // rather than self-chaining indefinitely.
  if (result.processed === 0) {
    await markFailed(env, run.id, `${phase}_no_progress`);
    return;
  }

  // Hop ceiling — guards against runaway loops the same way
  // EMBED_DRAIN_MAX_HOPS commented above. embed_processed is the
  // accumulator we count from.
  if (cumulative >= EMBED_DRAIN_MAX_HOPS * 50) {
    await markFailed(env, run.id, `${phase}_hop_ceiling`);
    return;
  }

  await env.DB
    .prepare(
      `UPDATE pipeline_runs
          SET embed_processed = ?2,
              embed_remaining = ?3,
              updated_at = ?4
        WHERE id = ?1
          AND status = 'running'
          AND current_phase = ?5`,
    )
    .bind(run.id, cumulative, result.remaining, now, phase)
    .run();

  await env.PIPELINE_JOBS.send({
    pipeline_run_id: run.id,
    phase,
  });
  log('info', 'digest.generation', {
    status: 'pipeline_phase_progress',
    pipeline_run_id: run.id,
    phase,
    processed_this_batch: result.processed,
    processed_total: cumulative,
    remaining: result.remaining,
  });
}

async function runDedupKick(env: Env, run: PipelineRunRow): Promise<void> {
  const dedupRunId = generateUlid();
  const now = Math.floor(Date.now() / 1000);
  await env.DB
    .prepare(
      `INSERT INTO dedup_runs (id, status, started_at, updated_at)
       VALUES (?1, 'running', ?2, ?2)`,
    )
    .bind(dedupRunId, now)
    .run();
  await env.DEDUP_SWEEP.send({
    run_id: dedupRunId,
    cursor: null,
    batch: DEDUP_DEFAULT_BATCH,
  });
  await env.DB
    .prepare(
      `UPDATE pipeline_runs
          SET current_phase = 'dedup_wait',
              dedup_run_id = ?2,
              updated_at = ?3
        WHERE id = ?1
          AND status = 'running'
          AND current_phase = 'dedup_kick'`,
    )
    .bind(run.id, dedupRunId, now)
    .run();
  await env.PIPELINE_JOBS.send({
    pipeline_run_id: run.id,
    phase: 'dedup_wait',
  });
  log('info', 'digest.generation', {
    status: 'pipeline_phase_complete',
    pipeline_run_id: run.id,
    phase: 'dedup_kick',
    dedup_run_id: dedupRunId,
  });
}

async function runDedupWait(env: Env, run: PipelineRunRow): Promise<void> {
  if (run.dedup_run_id === null) {
    throw new Error('pipeline_run dedup_wait without dedup_run_id');
  }
  const row = await env.DB
    .prepare(`SELECT status FROM dedup_runs WHERE id = ?1`)
    .bind(run.dedup_run_id)
    .first<{ status: string }>();

  if (row === null || row.status === 'running') {
    await env.PIPELINE_JOBS.send(
      { pipeline_run_id: run.id, phase: 'dedup_wait' },
      { delaySeconds: WAIT_DELAY_SECONDS },
    );
    log('info', 'digest.generation', {
      status: 'pipeline_phase_waiting',
      pipeline_run_id: run.id,
      phase: 'dedup_wait',
      dedup_run_id: run.dedup_run_id,
      dedup_status: row?.status ?? 'missing',
    });
    return;
  }

  if (row.status === 'failed') {
    await markFailed(env, run.id, 'dedup_failed');
    return;
  }

  // status === 'done' — the whole pipeline completed.
  const now = Math.floor(Date.now() / 1000);
  await env.DB
    .prepare(
      `UPDATE pipeline_runs
          SET status = 'done',
              current_phase = 'done',
              updated_at = ?2
        WHERE id = ?1
          AND status = 'running'`,
    )
    .bind(run.id, now)
    .run();
  log('info', 'digest.generation', {
    status: 'pipeline_phase_complete',
    pipeline_run_id: run.id,
    phase: 'dedup_wait',
    dedup_run_id: run.dedup_run_id,
    pipeline_done: true,
  });
}

/** Compare-and-swap on `current_phase` so a redelivered queue message
 *  observes the prior phase's UPDATE already landed and exits without
 *  re-advancing. */
async function advancePhase(
  env: Env,
  pipelineRunId: string,
  fromPhase: PipelinePhase,
  toPhase: PipelinePhase,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB
    .prepare(
      `UPDATE pipeline_runs
          SET current_phase = ?2,
              updated_at = ?3
        WHERE id = ?1
          AND status = 'running'
          AND current_phase = ?4`,
    )
    .bind(pipelineRunId, toPhase, now, fromPhase)
    .run();
}

async function markFailed(
  env: Env,
  pipelineRunId: string,
  reason: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB
    .prepare(
      `UPDATE pipeline_runs
          SET status = 'failed',
              updated_at = ?2,
              error = COALESCE(error, ?3)
        WHERE id = ?1
          AND status = 'running'`,
    )
    .bind(pipelineRunId, now, reason)
    .run();
  log('warn', 'digest.generation', {
    status: 'pipeline_phase_failed',
    pipeline_run_id: pipelineRunId,
    reason,
  });
}
