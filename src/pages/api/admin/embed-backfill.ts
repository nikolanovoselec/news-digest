// Implements REQ-PIPE-003
// Implements REQ-AUTH-001
//
// Operator-only resumable backfill of article embeddings. POST
// /api/admin/embed-backfill picks up to {@link BATCH_SIZE} articles
// whose `embedding_status` is NULL or 'failed', embeds them via
// Workers AI bge-base-en-v1.5, upserts the vectors into Vectorize,
// and stamps `embedding_status='embedded'` + `embedded_at` on each.
//
// Resumable by design: each call processes one batch and returns
// `{ processed, remaining }`. Operators (or scripted loops via the
// dev-bypass session) keep calling until `remaining === 0`. Partial
// failures mark the affected rows `failed` so the next pass retries
// just those, not the entire backlog.
//
// Three-layer admin auth (CF-001) — same gate every other admin route
// uses. No Origin check on POST because the backfill is designed to
// be driven from curl / scripts; CSRF defence-in-depth on form posts
// would block the legitimate scripted flow.

import type { APIContext } from 'astro';
import { log } from '~/lib/log';
import { requireAdminSession } from '~/middleware/admin-auth';
import { applyRefreshCookie } from '~/middleware/auth';
import { buildEmbeddingInput, embedTexts } from '~/lib/embeddings';

/** Per-call ceiling. 50 articles × 768-dim ≈ 150 KB of vectors per
 *  upsert — well inside Vectorize batch limits, and small enough that
 *  a single Workers AI call stays under the per-request 2-minute
 *  isolate budget even if the model takes a few seconds. */
const BATCH_SIZE = 50;

interface ArticleRow {
  id: string;
  title: string;
  details_json: string;
  published_at: number;
  primary_source_url: string;
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  const adminAuth = await requireAdminSession(context);
  if (!adminAuth.ok) return adminAuth.response;

  try {
    const result = await runOneBackfillBatch(env);
    return applyRefreshCookie(
      new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
      adminAuth,
    );
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'embed_backfill_failed',
      detail: String(err).slice(0, 500),
    });
    return applyRefreshCookie(
      new Response(
        JSON.stringify({ ok: false, error: 'embed_backfill_failed' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      ),
      adminAuth,
    );
  }
}

interface BackfillResult {
  ok: true;
  processed: number;
  failed: number;
  remaining: number;
  done: boolean;
}

async function runOneBackfillBatch(env: Env): Promise<BackfillResult> {
  const result = await env.DB
    .prepare(
      `SELECT id, title, details_json, published_at, primary_source_url
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
