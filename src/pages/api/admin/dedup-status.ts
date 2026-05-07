// Implements REQ-PIPE-003 AC 9
// Implements REQ-OPS-008
// Implements REQ-AUTH-001
//
// Operator-only polling endpoint for the queue-driven historical
// same-story sweep. GET /api/admin/dedup-status?run_id=<ulid> returns
// a snapshot of the named `dedup_runs` audit row so the /settings
// surface can paint live progress while the queue consumer chains
// across batches in the background. The settings JS hits this every
// 5 seconds while a sweep is in flight; the queue consumer updates
// the underlying row after each batch.
//
// Three-layer admin auth (CF-001) — same gate every other admin
// route uses. No Origin check on GET (read-only).

import type { APIContext } from 'astro';
import { log } from '~/lib/log';
import { requireAdminSession } from '~/middleware/admin-auth';
import { applyRefreshCookie } from '~/middleware/auth';

interface RunRow {
  id: string;
  status: string;
  scanned: number;
  merged: number;
  batch_count: number;
  last_cursor_pa: number | null;
  last_cursor_id: string | null;
  remaining: number;
  error: string | null;
  started_at: number;
  updated_at: number;
}

interface StatusSuccess {
  ok: true;
  run_id: string;
  status: 'running' | 'done' | 'failed';
  scanned: number;
  merged: number;
  batch_count: number;
  remaining: number;
  /** Composite cursor of the last completed batch; null when no
   *  batch has run yet (sweep is queued but not yet picked up by
   *  the consumer). */
  last_cursor: { pa: number; id: string } | null;
  /** True iff status === 'done'. Mirrors the per-batch shape so the
   *  settings JS doesn't have to special-case status strings. */
  done: boolean;
  /** True iff status === 'failed'. */
  failed: boolean;
  error: string | null;
  started_at: number;
  updated_at: number;
}

interface StatusError {
  ok: false;
  error: string;
}

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  const adminAuth = await requireAdminSession(context);
  if (!adminAuth.ok) return adminAuth.response;

  const runId = context.url.searchParams.get('run_id');
  if (runId === null || runId === '') {
    return jsonResponse({ ok: false, error: 'missing_run_id' }, 400, adminAuth);
  }

  let row: RunRow | null = null;
  try {
    row = await env.DB
      .prepare(
        `SELECT id, status, scanned, merged, batch_count,
                last_cursor_pa, last_cursor_id, remaining,
                error, started_at, updated_at
           FROM dedup_runs
          WHERE id = ?1`,
      )
      .bind(runId)
      .first<RunRow>();
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'dedup_status_select_failed',
      dedup_run_id: runId,
      detail: String(err).slice(0, 500),
    });
    return jsonResponse(
      { ok: false, error: 'dedup_status_select_failed' },
      500,
      adminAuth,
    );
  }

  if (row === null) {
    return jsonResponse({ ok: false, error: 'run_not_found' }, 404, adminAuth);
  }

  // Validate the persisted status string. The column is plain TEXT
  // (no SQLite check constraint) so a divergent writer could in
  // principle store anything; reject unknown values defensively
  // rather than letting them propagate to the UI.
  const status = row.status;
  if (status !== 'running' && status !== 'done' && status !== 'failed') {
    log('error', 'digest.generation', {
      status: 'dedup_status_invalid_status',
      dedup_run_id: runId,
      stored_status: status,
    });
    return jsonResponse(
      { ok: false, error: 'invalid_stored_status' },
      500,
      adminAuth,
    );
  }

  const lastCursor =
    row.last_cursor_pa !== null && row.last_cursor_id !== null
      ? { pa: row.last_cursor_pa, id: row.last_cursor_id }
      : null;

  const result: StatusSuccess = {
    ok: true,
    run_id: row.id,
    status,
    scanned: row.scanned,
    merged: row.merged,
    batch_count: row.batch_count,
    remaining: row.remaining,
    last_cursor: lastCursor,
    done: status === 'done',
    failed: status === 'failed',
    error: row.error,
    started_at: row.started_at,
    updated_at: row.updated_at,
  };
  return jsonResponse(result, 200, adminAuth);
}

function jsonResponse(
  body: StatusSuccess | StatusError,
  status: number,
  adminAuth: { cookiesToSet: readonly string[] },
): Response {
  return applyRefreshCookie(
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }),
    adminAuth,
  );
}
