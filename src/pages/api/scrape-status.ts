// Implements REQ-PIPE-006
//
// Lightweight status endpoint for the dashboard countdown + the
// settings Force Refresh progress line. Reads the most recent row
// from `scrape_runs` (one SELECT on an indexed column) and derives
// chunks_remaining from D1 (one indexed COUNT on
// `scrape_chunk_completions`). That's it - no LLM, no article read,
// no cost. CF-007 (Cycle 1 review): the legacy KV counter was a stale
// dual-write that diverged from D1 (the source of truth per AD7); both
// writers and the KV reader were removed.
//
// Response:
//   { running: false }                                    - idle
//   { running: true, id, started_at, chunks_remaining,    - busy
//     chunks_total, articles_ingested }
//
// Callers:
//   - src/pages/digest.astro countdown: swap "Next update in Xm"
//     for "Update in progress" when running=true.
//   - src/pages/settings.astro Force Refresh section: poll every
//     5s while the form was just submitted; show articles_ingested
//     + chunks_remaining so the user sees live progress.

import type { APIContext } from 'astro';
import { applyRefreshCookie, requireSession } from '~/middleware/auth';
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
  const auth = await requireSession(context.request, env);
  if (!auth.ok) return auth.response;

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
      auth,
    );
  }

  // chunks_remaining derived from D1 (CF-007): chunk_count is the
  // total the coordinator fanned out; subtract the completed-chunk row
  // count for this run. Null on either side falls through to null so
  // the UI can still display a message without a denominator while a
  // brand-new run is still being primed.
  let chunksRemaining: number | null = null;
  if (typeof row.chunk_count === 'number' && row.chunk_count > 0) {
    try {
      const completed = await env.DB
        .prepare(
          `SELECT COUNT(*) AS n FROM scrape_chunk_completions WHERE scrape_run_id = ?1`,
        )
        .bind(row.id)
        .first<{ n: number }>();
      const completedCount = completed?.n ?? 0;
      const remaining = row.chunk_count - completedCount;
      chunksRemaining = remaining < 0 ? 0 : remaining;
    } catch {
      chunksRemaining = null;
    }
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
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          // CF-027: poll endpoint hit every 5s while a refresh is in
          // flight. 2s edge cache + 5s SWR collapses the burst from N
          // users into one origin hit per 7s window without hurting the
          // visible progress UX.
          'Cache-Control': 'public, max-age=2, stale-while-revalidate=5',
        },
      },
    ),
    auth,
  );
}
