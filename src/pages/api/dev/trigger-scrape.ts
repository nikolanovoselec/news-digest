// DEV-ONLY pipeline trigger. Gated by DEV_BYPASS_TOKEN the same way
// /api/dev/login is, and 404s when the secret isn't set.
//
// Purpose: give scripts/e2e-test.sh a way to drive a REAL scrape
// end-to-end and verify that articles land in D1 with the expected
// shape, without waiting for the 4-hour cron tick or needing
// Cloudflare Access for /api/admin/force-refresh.
//
// Flow:
//   1. Auth: Bearer DEV_BYPASS_TOKEN (timing-safe).
//   2. Create a scrape_runs row via startRun (ULID + status=running).
//   3. Send one {scrape_run_id} message to SCRAPE_COORDINATOR.
//   4. Return the run id + a status URL the caller can poll.
//
// The downstream pipeline (coordinator → chunks → finishRun) runs
// asynchronously via Queues — the caller polls /api/scrape-status
// to watch progress; a completed run flips to status='ready' with
// articles_ingested > 0.

import type { APIContext } from 'astro';
import { generateUlid } from '~/lib/ulid';
import { startRun } from '~/lib/scrape-run';
import { DEFAULT_MODEL_ID } from '~/lib/models';
import { log } from '~/lib/log';
import { timingSafeEqualHmac } from '~/lib/crypto';

interface DevEnv {
  DEV_BYPASS_TOKEN?: string;
}

// `timingSafeEqualHmac` from ~/lib/crypto replaces the previously
// open-coded JS XOR loop (CF-005).

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env as typeof context.locals.runtime.env &
    DevEnv;

  const bypass = env.DEV_BYPASS_TOKEN;
  if (typeof bypass !== 'string' || bypass === '') {
    return new Response(null, { status: 404 });
  }

  if (typeof env.OAUTH_JWT_SECRET !== 'string' || env.OAUTH_JWT_SECRET === '') {
    return new Response(null, { status: 404 });
  }

  const auth = context.request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (
    match === null ||
    !(await timingSafeEqualHmac(match[1] ?? '', bypass, env.OAUTH_JWT_SECRET))
  ) {
    return new Response(null, { status: 404 });
  }

  const scrape_run_id = generateUlid();
  try {
    await startRun(env.DB, { id: scrape_run_id, model_id: DEFAULT_MODEL_ID });
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'dev_trigger_scrape_start_failed',
      scrape_run_id,
      detail: String(err).slice(0, 500),
    });
    return new Response(
      JSON.stringify({ ok: false, error: 'start_run_failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    await env.SCRAPE_COORDINATOR.send({ scrape_run_id });
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'dev_trigger_scrape_enqueue_failed',
      scrape_run_id,
      detail: String(err).slice(0, 500),
    });
    return new Response(
      JSON.stringify({ ok: false, error: 'enqueue_failed', scrape_run_id }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  log('info', 'digest.generation', {
    status: 'dev_trigger_scrape_enqueued',
    scrape_run_id,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      scrape_run_id,
      status_url: '/api/scrape-status',
    }),
    { status: 202, headers: { 'Content-Type': 'application/json' } },
  );
}
