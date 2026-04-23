// Implements REQ-PIPE-001
// Implements REQ-PIPE-005
// Implements REQ-MAIL-001
//
// Module Worker entry point for the global-feed pipeline. Exports
// `scheduled` (cron dispatcher), `queue` (queue dispatcher branching on
// batch.queue name), and `fetch` (delegates to the Astro-generated
// handler in production; minimal fallback in tests).
//
// Cron schedule (wrangler.toml: `crons = ["0 */4 * * *", "0 3 * * *", "*/5 * * * *"]`):
//   - `0 */4 * * *` — global-feed coordinator enqueue, every 4 hours
//                     (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC).
//                     Creates a `scrape_runs` row (ULID, status=running)
//                     and sends one `{scrape_run_id}` message to
//                     SCRAPE_COORDINATOR. Work runs in queue isolates.
//   - `0 3 * * *`   — daily retention cleanup (REQ-PIPE-005). Delegates
//                     to `src/queue/cleanup.ts#runCleanup`.
//   - `*/5 * * * *` — two fixed chores: discovery drain
//                     (`processPendingDiscoveries`, up to N tags/tick)
//                     and the daily-email dispatcher
//                     (`dispatchDailyEmails`). The retired per-user
//                     digest scheduler (REQ-GEN-001, pre-rework) has
//                     been deleted from this path.
//
// Queue dispatch (wrangler.toml: two consumers):
//   - `scrape-coordinator` → handleCoordinatorBatch (REQ-PIPE-001).
//   - `scrape-chunks`      → handleChunkBatch (REQ-PIPE-002).
//
// The Astro Cloudflare adapter's generated `_worker.js` owns the HTTP
// fetch handler in production (`main` in wrangler.toml). This file's
// `fetch` export exists so the Module-Worker type contract is
// satisfied; the test pool (which points `main` at this file) never
// calls `fetch` — API routes are imported and called directly.

import { processPendingDiscoveries } from '~/lib/discovery';
import { log } from '~/lib/log';
import { generateUlid } from '~/lib/ulid';
import { startRun } from '~/lib/scrape-run';
import { DEFAULT_MODEL_ID } from '~/lib/models';
import {
  handleCoordinatorBatch,
  type CoordinatorMessage,
} from '~/queue/scrape-coordinator';
import {
  handleChunkBatch,
  type ChunkJobMessage,
} from '~/queue/scrape-chunk-consumer';
import { runCleanup } from '~/queue/cleanup';
import { dispatchDailyEmails } from '~/lib/email-dispatch';

/** Upper bound on the pending-discoveries batch drained per cron run.
 * Chosen so the 5-minute window comfortably accommodates the fan-out
 * and downstream LLM call per tag. */
const DISCOVERY_BATCH_LIMIT = 3;

/**
 * Cron dispatcher. Branches on `controller.cron` so each cron line has
 * its own code path. Branch failures log and return so one bad cron
 * doesn't poison the others — each firing is independent.
 */
export async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  if (controller.cron === '0 */4 * * *') {
    await handleHourlyScrape(env, ctx);
    return;
  }
  if (controller.cron === '0 3 * * *') {
    try {
      await runCleanup(env);
    } catch (err) {
      log('error', 'digest.generation', {
        status: 'cleanup_failed',
        detail: String(err).slice(0, 500),
      });
    }
    return;
  }
  if (controller.cron === '*/5 * * * *') {
    // Discovery drain — failures here must not block the email
    // dispatcher. Mirrored pattern: try/catch around each branch.
    try {
      await processPendingDiscoveries(env, DISCOVERY_BATCH_LIMIT);
    } catch (err) {
      log('error', 'discovery.completed', {
        status: 'discovery_processor_failed',
        detail: String(err).slice(0, 500),
      });
    }
    try {
      await dispatchDailyEmails(env);
    } catch (err) {
      log('error', 'email.send.failed', {
        user_id: null,
        digest_id: null,
        status: null,
        error: String(err).slice(0, 500),
      });
    }
    return;
  }

  log('warn', 'digest.generation', {
    status: 'unknown_cron',
    cron: controller.cron,
  });
}

/**
 * Hourly global-feed coordinator enqueue. Creates a new scrape_runs
 * row with status='running' and sends exactly one CoordinatorMessage
 * to the SCRAPE_COORDINATOR queue; the coordinator consumer fans out
 * across sources and enqueues per-chunk work.
 */
async function handleHourlyScrape(
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const scrape_run_id = generateUlid();
  try {
    await startRun(env.DB, {
      id: scrape_run_id,
      model_id: DEFAULT_MODEL_ID,
    });
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'scrape_run_start_failed',
      detail: String(err).slice(0, 500),
    });
    return;
  }
  // `waitUntil` keeps the enqueue alive past the return of the cron
  // handler but never blocks it — a slow SCRAPE_COORDINATOR producer
  // shouldn't delay the worker event loop.
  ctx.waitUntil(env.SCRAPE_COORDINATOR.send({ scrape_run_id }));
  log('info', 'digest.generation', {
    status: 'coordinator_dispatched',
    scrape_run_id,
  });
}

/**
 * Queue dispatcher. Branches on `batch.queue` so one handler can
 * service both queue bindings. Every message is routed to the consumer
 * module that owns it; unknown queue names log and return without
 * retrying (unknown-queue messages are effectively unhandleable).
 */
export async function queue(
  batch: MessageBatch<unknown>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  switch (batch.queue) {
    case 'scrape-coordinator':
      await handleCoordinatorBatch(
        batch as MessageBatch<CoordinatorMessage>,
        env,
      );
      return;
    case 'scrape-chunks':
      await handleChunkBatch(batch as MessageBatch<ChunkJobMessage>, env);
      return;
    default:
      log('error', 'digest.generation', {
        status: 'unknown_queue',
        queue: batch.queue,
      });
  }
}

/**
 * HTTP handler. In production the Astro Cloudflare adapter's generated
 * worker is the real entry point. This export satisfies the Module-
 * Worker type contract and supports the test pool's direct entry into
 * this file — tests always call API routes directly so this branch is
 * only reached for a stray request.
 */
export default {
  scheduled,
  queue,
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (env.ASSETS !== undefined) {
      return env.ASSETS.fetch(request);
    }
    return new Response('news-digest', { status: 200 });
  },
};
