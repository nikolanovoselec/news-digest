// Implements REQ-PIPE-003
// Implements REQ-AUTH-001
//
// Operator-only resumable backfill of article embeddings. POST/GET
// /api/admin/embed-backfill loops over batches of {@link BATCH_SIZE}
// articles whose `embedding_status` is NULL or 'failed', embeds them
// via Workers AI bge-base-en-v1.5, upserts the vectors into Vectorize,
// and stamps `embedding_status='embedded'` + `embedded_at` on each.
//
// One request drives the whole backfill. The handler keeps batching
// inside a single isolate until `done` (or the platform tears the
// request down — Cloudflare's edge cuts requests at ~100s with a 524).
// Browser callers (the /settings button) get a 303 redirect back with
// `?embed=done|partial&processed=N`; scripted callers opting in with
// `Accept: application/json` get the cumulative JSON shape.
//
// Three-layer admin auth (CF-001) — same gate every other admin route
// uses. CF-015: Origin check is applied to browser-driven calls so a
// logged-in admin clicking a malicious link cannot trigger a corpus-
// wide re-embed (Workers AI cost). Scripted callers opt out via
// `Authorization: Bearer ...` (the dev-bypass curl path carries no
// cookies, so it is not a CSRF surface).

import type { APIContext } from 'astro';
import { log } from '~/lib/log';
import { requireAdminSession } from '~/middleware/admin-auth';
import { applyRefreshCookie } from '~/middleware/auth';
import { checkOrigin, hasBearerAuth, originOf } from '~/middleware/origin-check';
import { runOneBackfillBatch } from '~/lib/embed-backfill';
import { clearWatermark } from '~/lib/dedup-watermark';

interface CumulativeResult {
  ok: true;
  processed: number;
  failed: number;
  remaining: number;
  done: boolean;
  iterations: number;
  elapsed_ms: number;
}

export async function POST(context: APIContext): Promise<Response> {
  return handle(context);
}

export async function GET(context: APIContext): Promise<Response> {
  return handle(context);
}

async function handle(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return new Response('Application not configured', { status: 500 });
  }
  const appOrigin = originOf(env.APP_URL);
  const wantsJson = (context.request.headers.get('Accept') ?? '').includes(
    'application/json',
  );

  // CF-015: defence-in-depth CSRF guard for browser-driven calls only
  // on state-changing methods (POST). GET is exempt per REQ-AUTH-003
  // (idempotent). Scripted Bearer callers carry no cookies and are
  // not a CSRF surface.
  if (context.request.method === 'POST' && !hasBearerAuth(context.request)) {
    const originResult = checkOrigin(context.request, appOrigin);
    if (!originResult.ok) return originResult.response;
  }

  const adminAuth = await requireAdminSession(context);
  if (!adminAuth.ok) {
    if (wantsJson) return adminAuth.response;
    return new Response(null, {
      status: 303,
      headers: { Location: `${appOrigin}/settings?embed=denied` },
    });
  }

  // ?reembed=1 forces a re-embed of every article regardless of
  // current embedding_status. Used after the embedding input or model
  // changes (REQ-PIPE-003 AC 12) — the operator clicks the button on
  // /settings, the route flips every row to 'failed' in one UPDATE,
  // and the existing batch loop picks them up oldest-first. Idempotent
  // when re-fired mid-loop because already-flipped rows simply stay
  // in the SELECT predicate.
  const reembed = context.url.searchParams.get('reembed') === '1';
  if (reembed) {
    if (context.request.method !== 'POST') {
      if (wantsJson) {
        return new Response(
          JSON.stringify({ ok: false, error: 'reembed requires POST' }),
          { status: 405, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('reembed requires POST', { status: 405 });
    }
    await env.DB
      .prepare(`UPDATE articles SET embedding_status = 'failed'`)
      .run();
    // AD48 — re-embedding changes cosine geometry, so every prior
    // same-event verdict is suspect. Clear the auto-sweep watermark
    // so the next sweep re-judges every borderline pair against the
    // new vectors. Best-effort: a KV delete failure is logged but
    // does not block the re-embed; the worst case is the next sweep
    // skips some pairs it should have re-checked, which the operator
    // can force by clicking the historical-dedup button (which sets
    // bypassWatermark=true regardless).
    try {
      await clearWatermark(env);
    } catch (err) {
      log('warn', 'digest.generation', {
        status: 'dedup_watermark_clear_failed',
        detail: String(err).slice(0, 500),
      });
    }
    log('info', 'digest.generation', {
      status: 'embed_backfill_reembed_requested',
    });
  }

  const startedAt = Date.now();
  let totalProcessed = 0;
  let totalFailed = 0;
  let lastRemaining = 0;
  let iterations = 0;
  let done = false;

  try {
    for (;;) {
      const result = await runOneBackfillBatch(env);
      iterations += 1;
      totalProcessed += result.processed;
      totalFailed += result.failed;
      lastRemaining = result.remaining;
      if (result.done) {
        done = true;
        break;
      }
      // Forward-progress guard: bail when a batch produced ZERO
      // successful embeds. The failed rows have already been flipped
      // to embedding_status='failed' by runOneBackfillBatch, so they
      // stay in the SELECT predicate — but a persistent AI or
      // Vectorize outage would otherwise have us re-pull the same
      // rows on every iteration and burn ~30 wasted AI calls per
      // click. Bailing on processed===0 means "one click, one shot
      // at each batch"; the operator clicks again to retry, which is
      // the right UX when the upstream service is degraded.
      if (result.processed === 0) {
        break;
      }
    }
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'embed_backfill_failed',
      detail: String(err).slice(0, 500),
      iterations,
      processed: totalProcessed,
    });
    if (wantsJson) {
      return applyRefreshCookie(
        new Response(
          JSON.stringify({ ok: false, error: 'embed_backfill_failed' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        ),
        adminAuth,
      );
    }
    return applyRefreshCookie(
      new Response(null, {
        status: 303,
        headers: { Location: `${appOrigin}/settings?embed=error` },
      }),
      adminAuth,
    );
  }

  log('info', 'digest.generation', {
    status: 'embed_backfill_loop_completed',
    iterations,
    processed: totalProcessed,
    failed: totalFailed,
    remaining: lastRemaining,
    done,
    elapsed_ms: Date.now() - startedAt,
  });

  if (wantsJson) {
    const body: CumulativeResult = {
      ok: true,
      processed: totalProcessed,
      failed: totalFailed,
      remaining: lastRemaining,
      done,
      iterations,
      elapsed_ms: Date.now() - startedAt,
    };
    return applyRefreshCookie(
      new Response(JSON.stringify(body, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
      adminAuth,
    );
  }

  const status = done ? 'done' : 'partial';
  const location =
    `${appOrigin}/settings?embed=${status}` +
    `&processed=${totalProcessed}` +
    `&failed=${totalFailed}` +
    `&remaining=${lastRemaining}`;
  return applyRefreshCookie(
    new Response(null, {
      status: 303,
      headers: { Location: location },
    }),
    adminAuth,
  );
}

// runOneBackfillBatch + countRemaining now live in `~/lib/embed-backfill`
// so the pipeline-consumer queue handler can import the work without
// crossing the route-handler layer. This file stays an HTTP wrapper.
