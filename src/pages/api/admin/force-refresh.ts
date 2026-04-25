// Implements REQ-PIPE-001
// Implements REQ-OPS-004
//
// Operator-only manual kick of the global-feed coordinator (every-4-hours cron).
// Path: POST /api/admin/force-refresh + GET /api/admin/force-refresh.
//
// Accepts POST (from the Settings page button) + GET (for a direct
// URL visit). Starts a fresh scrape_runs row with status='running'
// and sends a single SCRAPE_COORDINATOR queue message — the exact
// same work the `0 * * * *` cron does.
//
// Access control: this endpoint sits under `/api/admin/*` which is
// gated at the zone level by Cloudflare Access (single wildcard rule
// covers every admin endpoint). Worker-side defence-in-depth still
// enforces an Origin check on POST (REQ-AUTH-003 pattern) to block
// cross-site CSRF even from a logged-in browser.

import type { APIContext } from 'astro';
import { log } from '~/lib/log';
import { generateUlid } from '~/lib/ulid';
import { startRun } from '~/lib/scrape-run';
import { DEFAULT_MODEL_ID } from '~/lib/models';
import { checkOrigin, originOf } from '~/middleware/origin-check';

/** Concurrency window: if a scrape_runs row with status='running' was
 * started within this many seconds, reuse it instead of kicking a
 * fresh coordinator. Guards against double-clicks separated by more
 * than the INSERT commit latency AND against link-preview bots
 * refetching the URL.
 *
 * **Known race**: two truly concurrent requests can both SELECT
 * (no running row), both INSERT fresh rows, and both enqueue. D1 has
 * no `SELECT ... FOR UPDATE`; the ULIDs are unique, so no PK collision
 * collapses the race. For this operator-only endpoint behind
 * Cloudflare Access the tradeoff is acceptable — the window only
 * needs to absorb "user clicked twice within N seconds", not a
 * contested multi-writer flood. If this endpoint ever opens to
 * non-operators, wrap the SELECT+INSERT in a Durable Object or a
 * KV SET NX mutex. */
const REUSE_WINDOW_SECONDS = 120;

interface RecentRun {
  id: string;
  started_at: number;
}

/** Find any `status='running'` row started within REUSE_WINDOW_SECONDS.
 * Returns null when there's nothing to reuse. */
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

async function kickCoordinator(env: Env): Promise<{ run_id: string; reused: boolean }> {
  const existing = await findRecentRunningRun(env);
  if (existing !== null) {
    log('info', 'digest.generation', {
      status: 'force_refresh_reused',
      scrape_run_id: existing.id,
      age_seconds: Math.floor(Date.now() / 1000) - existing.started_at,
    });
    return { run_id: existing.id, reused: true };
  }
  const scrape_run_id = generateUlid();
  await startRun(env.DB, { id: scrape_run_id, model_id: DEFAULT_MODEL_ID });
  await env.SCRAPE_COORDINATOR.send({ scrape_run_id });
  log('info', 'digest.generation', {
    status: 'force_refresh_dispatched',
    scrape_run_id,
  });
  return { run_id: scrape_run_id, reused: false };
}

function redirectToSettings(origin: string, runId: string, reused: boolean): Response {
  const status = reused ? 'reused' : 'ok';
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${origin}/settings?force_refresh=${status}&run_id=${runId}`,
    },
  });
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return new Response('Application not configured', { status: 500 });
  }
  const appOrigin = originOf(env.APP_URL);

  const originResult = checkOrigin(context.request, appOrigin);
  if (!originResult.ok) return originResult.response!;

  try {
    const { run_id, reused } = await kickCoordinator(env);
    return redirectToSettings(appOrigin, run_id, reused);
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'force_refresh_failed',
      detail: String(err).slice(0, 500),
    });
    return new Response('Failed to dispatch coordinator', { status: 500 });
  }
}

export async function GET(context: APIContext): Promise<Response> {
  // GET path exists so the operator can trigger from a bookmark or
  // curl without needing a form. Cloudflare Access is the sole gate
  // — no Origin check here (there's no state-changing browser flow).
  // The REUSE_WINDOW_SECONDS guard below prevents accidental storms
  // from link-preview bots refetching the URL.
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return new Response('Application not configured', { status: 500 });
  }
  try {
    const { run_id, reused } = await kickCoordinator(env);
    return new Response(
      JSON.stringify({ ok: true, scrape_run_id: run_id, reused }, null, 2),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      },
    );
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'force_refresh_failed',
      detail: String(err).slice(0, 500),
    });
    return new Response('Failed to dispatch coordinator', { status: 500 });
  }
}
