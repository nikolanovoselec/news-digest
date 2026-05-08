// Implements REQ-OPS-008
// Implements REQ-AUTH-001
//
// Operator-only polling endpoint for the backend-driven full pipeline
// run. GET /api/admin/pipeline-status?id=<ulid> (or no id → most
// recent row). Returns the pipeline_runs row plus nested snapshots of
// the scrape_runs + dedup_runs the pipeline kicked, so the settings
// surface can paint live progress without driving the orchestration.
//
// Closing the tab and re-opening /settings later recovers full
// progress display because the audit row is the source of truth — the
// queue consumer (`pipeline-consumer.ts`) is the only writer.
//
// Three-layer admin auth (CF-001). No Origin check (read-only GET).

import type { APIContext } from 'astro';
import { log } from '~/lib/log';
import { requireAdminSession } from '~/middleware/admin-auth';
import { applyRefreshCookie } from '~/middleware/auth';

interface PipelineRunRow {
  id: string;
  status: string;
  mode: string;
  current_phase: string;
  scrape_run_id: string | null;
  dedup_run_id: string | null;
  embed_processed: number;
  embed_remaining: number;
  error: string | null;
  started_at: number;
  updated_at: number;
}

interface ScrapeRow {
  id: string;
  status: string;
  articles_ingested: number;
  articles_deduped: number;
  finalize_recorded: number;
  started_at: number;
  finished_at: number | null;
}

interface DedupRow {
  id: string;
  status: string;
  scanned: number;
  merged: number;
  remaining: number;
  started_at: number;
  updated_at: number;
}

interface StatusSuccess {
  ok: true;
  pipeline_run_id: string;
  status: 'running' | 'done' | 'failed';
  mode: 'full' | 'wipe';
  current_phase: string;
  embed_processed: number;
  embed_remaining: number;
  error: string | null;
  started_at: number;
  updated_at: number;
  scrape: ScrapeRow | null;
  dedup: DedupRow | null;
  done: boolean;
  failed: boolean;
}

interface StatusError {
  ok: false;
  error: string;
}

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  const adminAuth = await requireAdminSession(context);
  if (!adminAuth.ok) return adminAuth.response;

  const id = context.url.searchParams.get('id');

  let row: PipelineRunRow | null = null;
  try {
    if (id !== null && id !== '') {
      row = await env.DB
        .prepare(
          `SELECT id, status, mode, current_phase, scrape_run_id, dedup_run_id,
                  embed_processed, embed_remaining, error, started_at, updated_at
             FROM pipeline_runs WHERE id = ?1`,
        )
        .bind(id)
        .first<PipelineRunRow>();
    } else {
      row = await env.DB
        .prepare(
          `SELECT id, status, mode, current_phase, scrape_run_id, dedup_run_id,
                  embed_processed, embed_remaining, error, started_at, updated_at
             FROM pipeline_runs
            ORDER BY started_at DESC
            LIMIT 1`,
        )
        .first<PipelineRunRow>();
    }
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'pipeline_status_select_failed',
      pipeline_run_id: id,
      detail: String(err).slice(0, 500),
    });
    return jsonResponse(
      { ok: false, error: 'pipeline_status_select_failed' },
      500,
      adminAuth,
    );
  }

  if (row === null) {
    return jsonResponse({ ok: false, error: 'run_not_found' }, 404, adminAuth);
  }

  const status = row.status;
  if (status !== 'running' && status !== 'done' && status !== 'failed') {
    return jsonResponse(
      { ok: false, error: 'invalid_stored_status' },
      500,
      adminAuth,
    );
  }
  const mode = row.mode;
  if (mode !== 'full' && mode !== 'wipe') {
    return jsonResponse(
      { ok: false, error: 'invalid_stored_mode' },
      500,
      adminAuth,
    );
  }

  // Best-effort lookups: a missing scrape/dedup row just renders as
  // null rather than failing the poll.
  let scrape: ScrapeRow | null = null;
  if (row.scrape_run_id !== null) {
    scrape = await env.DB
      .prepare(
        `SELECT id, status, articles_ingested, articles_deduped,
                finalize_recorded, started_at, finished_at
           FROM scrape_runs WHERE id = ?1`,
      )
      .bind(row.scrape_run_id)
      .first<ScrapeRow>();
  }
  let dedup: DedupRow | null = null;
  if (row.dedup_run_id !== null) {
    dedup = await env.DB
      .prepare(
        `SELECT id, status, scanned, merged, remaining, started_at, updated_at
           FROM dedup_runs WHERE id = ?1`,
      )
      .bind(row.dedup_run_id)
      .first<DedupRow>();
  }

  const result: StatusSuccess = {
    ok: true,
    pipeline_run_id: row.id,
    status,
    mode,
    current_phase: row.current_phase,
    embed_processed: row.embed_processed,
    embed_remaining: row.embed_remaining,
    error: row.error,
    started_at: row.started_at,
    updated_at: row.updated_at,
    scrape,
    dedup,
    done: status === 'done',
    failed: status === 'failed',
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
