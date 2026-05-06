// Implements REQ-PIPE-003
// Implements REQ-AUTH-001
//
// Operator-only resumable historical-dedup sweep. POST
// /api/admin/historical-dedup walks already-embedded articles
// oldest-first and merges any newer near-duplicates into them as
// alt-sources via {@link mergeAsAltSource}. Newer matches are
// determined by Vectorize topK + cosine threshold + strict
// `published_at >` comparison; the older article always wins so
// users' stars / reads / canonical URLs are preserved.
//
// Resumable: POST `{"cursor": <unix_seconds>, "batch": <number>}` to
// resume from a given published_at. The default batch size is 100
// articles per call. The caller loops until the response reports
// `done: true`.
//
// Idempotent: a second pass over the same window finds nothing to
// merge because the previous pass already removed those vectors and
// rows. The historical-dedup route is the only path that should be
// invoked manually post-deploy; the per-tick finalize-consumer
// handles new articles inline.

import type { APIContext } from 'astro';
import { log } from '~/lib/log';
import { requireAdminSession } from '~/middleware/admin-auth';
import { applyRefreshCookie } from '~/middleware/auth';
import { mergeAsAltSource } from '~/lib/finalize-merge';
import { readCosineThreshold, deleteVectorsBatched } from '~/lib/embeddings';

/** Default articles scanned per call when the caller omits `batch`. */
const DEFAULT_BATCH = 100;

/** Hard cap so a malformed `batch: 99999` doesn't blow the isolate
 *  budget. */
const MAX_BATCH = 500;

/** TopK for each Vectorize query. Five gives the dedup loop enough
 *  signal to pick the best newer match while keeping per-call
 *  latency bounded. */
const VECTORIZE_TOPK = 5;

interface ArticleRow {
  id: string;
  published_at: number;
}

interface DedupResult {
  ok: true;
  scanned: number;
  merged: number;
  next_cursor: number | null;
  remaining: number;
  done: boolean;
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  const adminAuth = await requireAdminSession(context);
  if (!adminAuth.ok) return adminAuth.response;

  let cursor: number | null = null;
  let batch = DEFAULT_BATCH;

  try {
    const raw = await context.request.text();
    if (raw !== '') {
      const body = JSON.parse(raw) as { cursor?: unknown; batch?: unknown };
      if (typeof body.cursor === 'number' && Number.isFinite(body.cursor)) {
        cursor = body.cursor;
      }
      if (
        typeof body.batch === 'number' &&
        Number.isFinite(body.batch) &&
        body.batch >= 1
      ) {
        batch = Math.min(MAX_BATCH, Math.floor(body.batch));
      }
    }
  } catch {
    // Body is optional; an empty / malformed body just means default.
  }

  try {
    const result = await runHistoricalDedupBatch(env, cursor, batch);
    return applyRefreshCookie(
      new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
      adminAuth,
    );
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'historical_dedup_failed',
      detail: String(err).slice(0, 500),
    });
    return applyRefreshCookie(
      new Response(
        JSON.stringify({ ok: false, error: 'historical_dedup_failed' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      ),
      adminAuth,
    );
  }
}

async function runHistoricalDedupBatch(
  env: Env,
  cursor: number | null,
  batch: number,
): Promise<DedupResult> {
  const threshold = readCosineThreshold(env);

  // Walk articles by ascending published_at, starting strictly after
  // the supplied cursor (or from the beginning when null). Only
  // already-embedded articles participate — un-embedded articles need
  // the embed-backfill route first.
  const cursorBind = cursor ?? -1;
  const result = await env.DB
    .prepare(
      `SELECT id, published_at
         FROM articles
        WHERE embedding_status = 'embedded'
          AND published_at > ?1
        ORDER BY published_at ASC
        LIMIT ?2`,
    )
    .bind(cursorBind, batch)
    .all<ArticleRow>();
  const rows = result.results ?? [];

  if (rows.length === 0) {
    return {
      ok: true,
      scanned: 0,
      merged: 0,
      next_cursor: null,
      remaining: 0,
      done: true,
    };
  }

  const removedIds = new Set<string>();
  let merged = 0;

  for (const self of rows) {
    if (removedIds.has(self.id)) continue;

    let queryResult: VectorizeMatches;
    try {
      queryResult = await env.VECTORIZE.queryById(self.id, {
        topK: VECTORIZE_TOPK,
        returnMetadata: 'all',
      });
    } catch (err) {
      log('warn', 'digest.generation', {
        status: 'historical_dedup_query_failed',
        article_id: self.id,
        detail: String(err).slice(0, 500),
      });
      continue;
    }

    const matches = queryResult.matches ?? [];
    for (const match of matches) {
      if (match.id === self.id) continue;
      if (removedIds.has(match.id)) continue;
      if (match.score < threshold) continue;
      const meta = match.metadata as { published_at?: unknown } | undefined;
      const matchPublishedAt =
        typeof meta?.published_at === 'number' ? meta.published_at : null;
      if (matchPublishedAt === null) continue;
      // We're walking oldest-first: any match with strictly NEWER
      // published_at is a candidate to fold into self. Older or
      // equal-time matches are skipped — they were either already
      // processed (so `match.id` would have absorbed self in a prior
      // step) or would orphan equal-time pairs (out of scope).
      if (matchPublishedAt <= self.published_at) continue;

      // Confirm the newer article still exists in D1; Vectorize may
      // hold a vector whose D1 row was retention-deleted in the
      // narrow window since the SELECT above.
      const stillThere = await env.DB
        .prepare(`SELECT 1 AS present FROM articles WHERE id = ?1`)
        .bind(match.id)
        .first<{ present: number }>();
      if (stillThere === null) continue;

      // Run each 6-statement merge as its own D1.batch so the route
      // never approaches D1's per-batch statement cap regardless of
      // the outer `batch` size or topK fan-out (worst case here was
      // 500 outer rows × 5 matches × 6 stmts = 15k in one batch).
      // Each merge is still atomic against itself; partial progress
      // across the outer batch is exactly what we want — the cursor
      // advances per outer row, so a transient mid-loop failure
      // restarts cleanly from the resume point.
      const mergeStatements = mergeAsAltSource(env.DB, self.id, match.id);
      await env.DB.batch(mergeStatements);
      removedIds.add(match.id);
      merged += 1;
    }
  }

  // Page deletes at 100 ids per call to stay under the platform delete-
  // batch ceiling — worst case here is `batch` (≤500) outer rows × topK
  // (5) matches = 2500 ids, well above the single-call limit. Best-effort:
  // a page failure leaves vectors orphan in Vectorize; the daily cleanup
  // pass picks them up when the parent D1 row hits retention.
  if (removedIds.size > 0) {
    await deleteVectorsBatched(
      env.VECTORIZE,
      Array.from(removedIds),
      (err, slice) => {
        log('warn', 'digest.generation', {
          status: 'historical_dedup_vectorize_delete_failed',
          delete_count: slice.length,
          detail: String(err).slice(0, 500),
        });
      },
    );
  }

  // Cursor advances to the LAST scanned article's published_at so the
  // next call resumes immediately after.
  const last = rows[rows.length - 1];
  const nextCursor = last !== undefined ? last.published_at : null;

  // remaining = how many articles past the new cursor still qualify.
  const remainingRow = await env.DB
    .prepare(
      `SELECT COUNT(*) AS c
         FROM articles
        WHERE embedding_status = 'embedded'
          AND published_at > ?1`,
    )
    .bind(nextCursor ?? -1)
    .first<{ c: number }>();
  const remaining = remainingRow?.c ?? 0;

  log('info', 'digest.generation', {
    status: 'historical_dedup_batch_completed',
    scanned: rows.length,
    merged,
    next_cursor: nextCursor,
    remaining,
  });

  return {
    ok: true,
    scanned: rows.length,
    merged,
    next_cursor: nextCursor,
    remaining,
    done: remaining === 0,
  };
}
