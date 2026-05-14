// Implements REQ-PIPE-001
// Implements REQ-PIPE-005
// Implements REQ-PIPE-003
// Implements REQ-MAIL-001
// Implements REQ-DISC-001
//
// Module Worker entry point for the global-feed pipeline. Exports
// `scheduled` (cron dispatcher), `queue` (queue dispatcher branching on
// batch.queue name), and `fetch` (delegates to the Astro-generated
// handler in production; minimal fallback in tests).
//
// Cron schedule (wrangler.toml: four crons):
//   - `0 */4 * * *` - global-feed coordinator enqueue, every 4 hours
//                     (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC).
//                     Creates a `scrape_runs` row (ULID, status=running)
//                     and sends one `{scrape_run_id}` message to
//                     SCRAPE_COORDINATOR. Work runs in queue isolates.
//   - `0 3 * * *`   - daily retention cleanup (REQ-PIPE-005). Delegates
//                     to `src/queue/cleanup.ts#runCleanup`.
//   - `*/5 * * * *` - daily-email dispatcher (`dispatchDailyEmails`).
//   - `2,12,22,32,42,52 * * * *` - discovery drain
//                     (`processPendingDiscoveries`, up to N tags/tick).
//                     CF-028: split from the email cron and run every
//                     10 min on a 2-min offset so a new user's first
//                     tag is discovered in ~2 minutes (REQ-DISC-001).
//
// Queue dispatch (wrangler.toml: four consumers):
//   - `scrape-coordinator` → handleCoordinatorBatch (REQ-PIPE-001).
//   - `scrape-chunks`      → handleChunkBatch (REQ-PIPE-002).
//   - `scrape-finalize`    → handleFinalizeBatch (REQ-PIPE-003).
//   - `dedup-sweep`        → handleDedupSweepBatch (REQ-PIPE-003 AC 9).
//   - `pipeline-jobs`      → handlePipelineJobsBatch (REQ-OPS-008).
//
// The Astro Cloudflare adapter's generated `_worker.js` owns the HTTP
// fetch handler in production (`main` in wrangler.toml). This file's
// `fetch` export exists so the Module-Worker type contract is
// satisfied; the test pool (which points `main` at this file) never
// calls `fetch` - API routes are imported and called directly.

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
import {
  handleFinalizeBatch,
  type FinalizeJobMessage,
} from '~/queue/scrape-finalize-consumer';
import {
  handleDedupSweepBatch,
  type DedupSweepMessage,
} from '~/queue/dedup-sweep-consumer';
import {
  handlePipelineJobsBatch,
  type PipelineJobMessage,
} from '~/queue/pipeline-consumer';
import { runCleanup } from '~/queue/cleanup';
import { dispatchDailyEmails } from '~/lib/email-dispatch';

/** Upper bound on the pending-discoveries batch drained per cron run.
 * Chosen so the 5-minute window comfortably accommodates the fan-out
 * and downstream LLM call per tag. */
const DISCOVERY_BATCH_LIMIT = 3;

/** CF-051 - lookup table replacing the if/else cron-string equality
 * chain. Adding a new cron line means adding one row here, not
 * threading another else-if through the dispatcher. Each handler is
 * wrapped in an async closure so the dispatcher can await it uniformly.
 *
 * Handlers run inside try/catch at the table level (see `scheduled`)
 * so one bad cron never poisons the others. */
const CRON_HANDLERS: Record<
  string,
  (env: Env, ctx: ExecutionContext) => Promise<void>
> = {
  '0 */4 * * *': async (env, ctx) => {
    await handleScrapeTick(env, ctx);
  },
  '0 3 * * *': async (env) => {
    await runCleanup(env);
  },
  '*/5 * * * *': async (env) => {
    // Email dispatcher only - CF-028 split the discovery drain onto
    // its own 10-min cron (`2,12,22,32,42,52 * * * *`) so a new user's
    // first-tag discovery lands within ~2 minutes instead of waiting
    // up to ~10 behind the 4-hour scrape cycle's other work.
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
  },
  '2,12,22,32,42,52 * * * *': async (env, ctx) => {
    // CF-028: dedicated discovery drain. `ctx.waitUntil` lets the
    // dispatcher return as soon as the batch is queued - the LLM
    // calls inside `processPendingDiscoveries` run alongside the next
    // cron rather than blocking the worker event loop.
    ctx.waitUntil(
      processPendingDiscoveries(env, DISCOVERY_BATCH_LIMIT).then(
        () => undefined,
        (err: unknown) => {
          log('error', 'discovery.completed', {
            status: 'discovery_processor_failed',
            detail: String(err).slice(0, 500),
          });
        },
      ),
    );
  },
};

/**
 * Cron dispatcher. Looks up `controller.cron` in {@link CRON_HANDLERS}
 * and calls the matching handler. Unknown cron strings log a warning.
 * Each handler runs inside its own try/catch so one failing cron does
 * not poison the others.
 */
export async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const handler = CRON_HANDLERS[controller.cron];
  if (handler === undefined) {
    log('warn', 'digest.generation', {
      status: 'unknown_cron',
      cron: controller.cron,
    });
    return;
  }
  try {
    await handler(env, ctx);
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'cron_handler_failed',
      cron: controller.cron,
      detail: String(err).slice(0, 500),
    });
  }
}

/**
 * Every-4-hours global-feed coordinator enqueue. Creates a new scrape_runs
 * row with status='running' and sends exactly one CoordinatorMessage
 * to the SCRAPE_COORDINATOR queue; the coordinator consumer fans out
 * across sources and enqueues per-chunk work.
 */
async function handleScrapeTick(
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
  // handler but never blocks it - a slow SCRAPE_COORDINATOR producer
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
  // Integration uses suffixed queue names (`scrape-coordinator-integration`,
  // ...); production uses bare names. Strip the env suffix so one dispatcher
  // serves both. Without this, integration queue messages hit the default
  // branch, log `unknown_queue`, and runs hang at chunk_count=0 forever.
  const queueKey = batch.queue.replace(/-(integration|staging)$/, '');
  switch (queueKey) {
    case 'scrape-coordinator':
      await handleCoordinatorBatch(
        batch as MessageBatch<CoordinatorMessage>,
        env,
      );
      return;
    case 'scrape-chunks':
      await handleChunkBatch(batch as MessageBatch<ChunkJobMessage>, env);
      return;
    case 'scrape-finalize':
      await handleFinalizeBatch(
        batch as MessageBatch<FinalizeJobMessage>,
        env,
      );
      return;
    case 'dedup-sweep':
      await handleDedupSweepBatch(
        batch as MessageBatch<DedupSweepMessage>,
        env,
      );
      return;
    case 'pipeline-jobs':
      await handlePipelineJobsBatch(
        batch as MessageBatch<PipelineJobMessage>,
        env,
      );
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
 * this file - tests always call API routes directly so this branch is
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
