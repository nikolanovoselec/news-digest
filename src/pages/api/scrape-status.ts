// Implements REQ-PIPE-006
//
// Lightweight status endpoint for the dashboard countdown + the
// settings Force Refresh progress line. Reads the most recent row
// from `scrape_runs` (one SELECT on an indexed column) plus the
// chunks_remaining KV counter for that run (one KV get). That's it —
// no LLM, no article read, no cost.
//
// Response:
//   { running: false }                                    — idle
//   { running: true, id, started_at, chunks_remaining,    — busy
//     chunks_total, articles_ingested }
//
// Callers:
//   - src/pages/digest.astro countdown: swap "Next update in Xm"
//     for "Update in progress" when running=true.
//   - src/pages/settings.astro Force Refresh section: poll every
//     5s while the form was just submitted; show articles_ingested
//     + chunks_remaining so the user sees live progress.

import type { APIContext } from 'astro';
import { applyRefreshCookie, loadSession } from '~/middleware/auth';
import { errorResponse } from '~/lib/errors';

interface ScrapeRunRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  chunk_count: number | null;
  articles_ingested: number | null;
}

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.OAUTH_JWT_SECRET !== 'string' || env.OAUTH_JWT_SECRET === '') {
    return errorResponse('app_not_configured');
  }
  const session = await loadSession(
    context.request,
    env.DB,
    env.OAUTH_JWT_SECRET,
  );
  if (session === null) return errorResponse('unauthorized');

  // Optional ?run_id=… pins the lookup to a specific run rather than
  // the most-recent row. Useful when the dashboard countdown polls
  // immediately after a Force Refresh and a new run has not quite
  // become "most recent" yet.
  const requestedRunId = new URL(context.request.url).searchParams.get('run_id');
  let row: ScrapeRunRow | null = null;
  try {
    if (requestedRunId !== null && requestedRunId !== '') {
      row = await env.DB
        .prepare(
          `SELECT id, started_at, finished_at, status, chunk_count, articles_ingested
             FROM scrape_runs WHERE id = ?1`,
        )
        .bind(requestedRunId)
        .first<ScrapeRunRow>();
    } else {
      row = await env.DB
        .prepare(
          `SELECT id, started_at, finished_at, status, chunk_count, articles_ingested
             FROM scrape_runs ORDER BY started_at DESC LIMIT 1`,
        )
        .first<ScrapeRunRow>();
    }
  } catch {
    row = null;
  }

  if (row === null || row.status !== 'running') {
    return applyRefreshCookie(
      new Response(JSON.stringify({ running: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
      session.refreshCookie,
    );
  }

  // KV counter decrements per completed chunk. chunk_count on the
  // scrape_runs row is the total the coordinator fanned out; if the
  // coordinator didn't (yet) write it, fall back to a sentinel so
  // the UI can still display a message without a denominator.
  let chunksRemaining: number | null = null;
  try {
    const raw = await env.KV.get(
      `scrape_run:${row.id}:chunks_remaining`,
      'text',
    );
    if (raw !== null) chunksRemaining = Number.parseInt(raw, 10);
    if (Number.isNaN(chunksRemaining)) chunksRemaining = null;
  } catch {
    chunksRemaining = null;
  }

  return applyRefreshCookie(
    new Response(
      JSON.stringify({
        running: true,
        id: row.id,
        started_at: row.started_at,
        chunks_remaining: chunksRemaining,
        chunks_total:
          typeof row.chunk_count === 'number' && row.chunk_count > 0
            ? row.chunk_count
            : null,
        articles_ingested: row.articles_ingested ?? 0,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      },
    ),
    session.refreshCookie,
  );
}
