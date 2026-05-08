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
// uses. No Origin check on POST because the backfill is also driven
// from curl / scripts via the dev-bypass session; CSRF defence-in-
// depth on form posts would block the legitimate scripted flow.

import type { APIContext } from 'astro';
import { log } from '~/lib/log';
import { requireAdminSession } from '~/middleware/admin-auth';
import { applyRefreshCookie } from '~/middleware/auth';
import { originOf } from '~/middleware/origin-check';
import { buildEmbeddingInput, embedTexts } from '~/lib/embeddings';

/** Per-batch ceiling. 50 articles × 768-dim ≈ 150 KB of vectors per
 *  upsert — well inside Vectorize batch limits, and small enough that
 *  a single Workers AI call stays under the per-request 2-minute
 *  isolate budget even if the model takes a few seconds. */
const BATCH_SIZE = 50;


interface ArticleRow {
  id: string;
  title: string;
  details_json: string;
  source_snippet: string | null;
  published_at: number;
  primary_source_url: string;
}

interface BatchResult {
  ok: true;
  processed: number;
  failed: number;
  remaining: number;
  done: boolean;
}

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

export async function runOneBackfillBatch(env: Env): Promise<BatchResult> {
  const result = await env.DB
    .prepare(
      `SELECT id, title, details_json, source_snippet, published_at,
              primary_source_url
         FROM articles
        WHERE embedding_status IS NULL OR embedding_status = 'failed'
        ORDER BY published_at ASC
        LIMIT ?1`,
    )
    .bind(BATCH_SIZE)
    .all<ArticleRow>();

  const rows = result.results ?? [];
  if (rows.length === 0) {
    return { ok: true, processed: 0, failed: 0, remaining: 0, done: true };
  }

  const inputs = rows.map((r) => buildEmbeddingInput(r));
  let vectors: number[][];
  try {
    vectors = await embedTexts(env.AI, inputs);
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'embed_backfill_embed_failed',
      batch_size: rows.length,
      detail: String(err).slice(0, 500),
    });
    // Mark every row in this batch failed so the next pass tries
    // again. Without this UPDATE the rows stay NULL and the same
    // batch would loop forever on a poison input.
    await env.DB
      .prepare(
        `UPDATE articles
            SET embedding_status = 'failed'
          WHERE id IN (${rows.map((_, i) => `?${i + 1}`).join(',')})`,
      )
      .bind(...rows.map((r) => r.id))
      .run();
    const remaining = await countRemaining(env);
    return {
      ok: true,
      processed: 0,
      failed: rows.length,
      remaining,
      done: remaining === 0,
    };
  }

  // Upsert into Vectorize.
  try {
    await env.VECTORIZE.upsert(
      rows.map((r, i) => ({
        id: r.id,
        values: vectors[i] as number[],
        metadata: {
          published_at: r.published_at,
          primary_source_url: r.primary_source_url,
        },
      })),
    );
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'embed_backfill_upsert_failed',
      batch_size: rows.length,
      detail: String(err).slice(0, 500),
    });
    // Same recovery: mark failed so the next pass retries.
    await env.DB
      .prepare(
        `UPDATE articles
            SET embedding_status = 'failed'
          WHERE id IN (${rows.map((_, i) => `?${i + 1}`).join(',')})`,
      )
      .bind(...rows.map((r) => r.id))
      .run();
    const remaining = await countRemaining(env);
    return {
      ok: true,
      processed: 0,
      failed: rows.length,
      remaining,
      done: remaining === 0,
    };
  }

  // Stamp success on D1 in one batch UPDATE.
  const nowSec = Math.floor(Date.now() / 1000);
  const updates = rows.map((r) =>
    env.DB
      .prepare(
        `UPDATE articles
            SET embedding_status = 'embedded', embedded_at = ?2
          WHERE id = ?1`,
      )
      .bind(r.id, nowSec),
  );
  await env.DB.batch(updates);

  const remaining = await countRemaining(env);
  log('info', 'digest.generation', {
    status: 'embed_backfill_batch_completed',
    processed: rows.length,
    remaining,
  });

  return {
    ok: true,
    processed: rows.length,
    failed: 0,
    remaining,
    done: remaining === 0,
  };
}

async function countRemaining(env: Env): Promise<number> {
  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS c FROM articles
        WHERE embedding_status IS NULL OR embedding_status = 'failed'`,
    )
    .first<{ c: number }>();
  return row?.c ?? 0;
}
