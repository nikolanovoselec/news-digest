// Implements REQ-PIPE-001
// Implements REQ-OPS-008
//
// Shared helper used by the operator-driven force-refresh route AND the
// backend pipeline orchestrator (REQ-OPS-008) to kick the global-feed
// coordinator. Same atomic-claim shape as before — the lift to a shared
// module is purely so the queue consumer can reuse it without
// triggering an HTTP round-trip back to the worker.

import { log } from '~/lib/log';
import { generateUlid } from '~/lib/ulid';
import { DEFAULT_MODEL_ID } from '~/lib/models';

/** Concurrency window: if a scrape_runs row with status='running' was
 *  started within this many seconds, reuse it instead of kicking a
 *  fresh coordinator. */
const REUSE_WINDOW_SECONDS = 120;

interface RecentRun {
  id: string;
  started_at: number;
}

async function findRecentRunningRun(env: Env): Promise<RecentRun | null> {
  const cutoff = Math.floor(Date.now() / 1000) - REUSE_WINDOW_SECONDS;
  const row = await env.DB
    .prepare(
      `SELECT id, started_at FROM scrape_runs
        WHERE status = 'running' AND started_at >= ?1
        ORDER BY started_at DESC LIMIT 1`,
    )
    .bind(cutoff)
    .first<RecentRun>();
  return row ?? null;
}

async function tryClaimDispatch(
  env: Env,
  scrapeRunId: string,
): Promise<{ claimed: boolean }> {
  const cutoff = Math.floor(Date.now() / 1000) - REUSE_WINDOW_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB
    .prepare(
      `INSERT INTO scrape_runs (id, model_id, started_at, status, chunk_count)
       SELECT ?1, ?2, ?3, 'running', 0
        WHERE NOT EXISTS (
          SELECT 1 FROM scrape_runs
           WHERE status = 'running' AND started_at >= ?4
        )`,
    )
    .bind(scrapeRunId, DEFAULT_MODEL_ID, now, cutoff)
    .run();
  return { claimed: (result.meta?.changes ?? 0) === 1 };
}

export async function kickCoordinator(
  env: Env,
): Promise<{ run_id: string; reused: boolean }> {
  const candidateRunId = generateUlid();
  const claim = await tryClaimDispatch(env, candidateRunId);
  if (!claim.claimed) {
    const existing = await findRecentRunningRun(env);
    if (existing !== null) {
      log('info', 'digest.generation', {
        status: 'force_refresh_skipped',
        scrape_run_id: existing.id,
        age_seconds: Math.floor(Date.now() / 1000) - existing.started_at,
      });
      return { run_id: existing.id, reused: true };
    }
    const retryRunId = generateUlid();
    const retryClaim = await tryClaimDispatch(env, retryRunId);
    if (!retryClaim.claimed) {
      throw new Error('force_refresh_claim_lost_after_retry');
    }
    await env.SCRAPE_COORDINATOR.send({ scrape_run_id: retryRunId });
    log('info', 'digest.generation', {
      status: 'force_refresh_dispatched',
      scrape_run_id: retryRunId,
    });
    return { run_id: retryRunId, reused: false };
  }
  await env.SCRAPE_COORDINATOR.send({ scrape_run_id: candidateRunId });
  log('info', 'digest.generation', {
    status: 'force_refresh_dispatched',
    scrape_run_id: candidateRunId,
  });
  return { run_id: candidateRunId, reused: false };
}
