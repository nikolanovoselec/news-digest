// Implements REQ-PIPE-003 AC 9
// Implements REQ-PIPE-009
// Implements REQ-AUTH-001
//
// Operator-only kicker for the historical same-story sweep. POST
// /api/admin/historical-dedup creates a `dedup_runs` audit row,
// enqueues exactly one `dedup-sweep` queue message, and returns
// immediately. The queue consumer
// (`src/queue/dedup-sweep-consumer.ts`) drives the loop: each message
// runs one bounded batch (`runHistoricalDedupBatch`), updates the
// audit row, and re-enqueues a continuation message until the corpus
// tail is reached (`done: true`) or terminal queue retry fires
// (`status: 'failed'`).
//
// Why queue-driven rather than browser-driven (the previous shape):
// the previous design required the `/settings` browser tab to stay
// open and online for the full duration of the sweep — every batch
// was a POST round-trip from the JS loop. Mobile background tab
// throttling, network blips, or an operator simply closing the tab
// silently halted the sweep mid-corpus. Audit log analysis on
// 2026-05-07 showed the pattern: 1,355-article corpus, 100+ batches
// expected, sweep stopped at ~130 articles past the last-visited
// cursor with `remaining=0` reported on the final batch (which is the
// "done with this segment" shape, not "done with corpus"). The
// queue-driven model uncouples the sweep from the operator's tab.
//
// Backwards-compat for scripted callers: a JSON request body
// `{cursor, batch}` still drives a single SYNCHRONOUS batch and
// returns the per-batch JSON shape, so existing tests / scripts /
// dev-bypass curl flows that drove single batches don't break. The
// distinguishing signal is the body: a body with cursor or batch =
// synchronous batch; an empty body = enqueue a fresh background run.
//
// Three-layer admin auth (CF-001) — same gate every other admin route
// uses. CF-015: Origin check is applied to browser-driven calls
// (cookie + cross-site request) so a logged-in admin clicking a
// malicious link cannot trigger pipeline operations with LLM-cost
// consequences. Scripted callers opt out by sending `Authorization:
// Bearer ...` (the dev-bypass curl path uses this header and carries
// no cookie context, so it is not a CSRF surface).

import type { APIContext } from 'astro';
import { log } from '~/lib/log';
import { requireAdminSession } from '~/middleware/admin-auth';
import { applyRefreshCookie } from '~/middleware/auth';
import { checkOrigin, hasBearerAuth, originOf } from '~/middleware/origin-check';
import { generateUlid } from '~/lib/ulid';
import {
  runHistoricalDedupBatch,
  DEFAULT_BATCH,
  MAX_BATCH,
  type DedupCursor,
} from '~/lib/historical-dedup';

interface KickResult {
  ok: true;
  /** ULID of the new dedup_runs row. The settings UI polls
   *  `/api/admin/dedup-status?run_id=…` with this id every 5s while a
   *  sweep is in flight. */
  run_id: string;
  enqueued: true;
  started_at: number;
}

interface SyncBatchResult {
  ok: true;
  scanned: number;
  merged: number;
  remaining: number;
  next_cursor: DedupCursor | null;
  done: boolean;
  elapsed_ms: number;
}

interface ParsedBody {
  cursor: DedupCursor | null;
  batch: number;
  /** True when the request body explicitly opted into the legacy
   *  synchronous single-batch shape (i.e., supplied `cursor` or
   *  `batch`). Empty / form-encoded body → enqueue a fresh run
   *  instead. */
  syncRequested: boolean;
}

export async function POST(context: APIContext): Promise<Response> {
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

  // CF-015: defence-in-depth CSRF guard on the browser-driven path.
  // Skip when the caller presents `Authorization: Bearer ...` — that
  // path is the scripted dev-bypass flow which carries no cookies and
  // is therefore not a CSRF surface. Browser POSTs always carry the
  // session cookie and must present an Origin matching APP_URL.
  if (!hasBearerAuth(context.request)) {
    const originResult = checkOrigin(context.request, appOrigin);
    if (!originResult.ok) return originResult.response;
  }

  const adminAuth = await requireAdminSession(context);
  if (!adminAuth.ok) {
    if (wantsJson) return adminAuth.response;
    return new Response(null, {
      status: 303,
      headers: { Location: `${appOrigin}/settings?dedup=denied` },
    });
  }

  const parsed = await parseBody(context.request);

  if (parsed.syncRequested) {
    return handleSyncBatch(env, adminAuth, parsed, appOrigin, wantsJson);
  }

  return handleEnqueue(env, adminAuth, parsed.batch, appOrigin, wantsJson);
}

/** Backwards-compat path. Runs exactly one synchronous batch and
 *  returns the per-batch JSON shape. Scripted callers (dev-bypass
 *  curl, integration tests) seed the cursor and drive iteration
 *  themselves when they want fine-grained control over the sweep. */
async function handleSyncBatch(
  env: Env,
  adminAuth: { cookiesToSet: readonly string[]; ok: true },
  parsed: ParsedBody,
  appOrigin: string,
  wantsJson: boolean,
): Promise<Response> {
  const startedAt = Date.now();
  let result;
  try {
    result = await runHistoricalDedupBatch(env, parsed.cursor, parsed.batch);
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'historical_dedup_sync_failed',
      detail: String(err).slice(0, 500),
    });
    if (wantsJson) {
      return applyRefreshCookie(
        new Response(
          JSON.stringify({ ok: false, error: 'historical_dedup_failed' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        ),
        adminAuth,
      );
    }
    return applyRefreshCookie(
      new Response(null, {
        status: 303,
        headers: { Location: `${appOrigin}/settings?dedup=error` },
      }),
      adminAuth,
    );
  }

  log('info', 'digest.generation', {
    status: 'historical_dedup_sync_completed',
    scanned: result.scanned,
    merged: result.merged,
    remaining: result.remaining,
    done: result.done,
    elapsed_ms: Date.now() - startedAt,
  });

  if (wantsJson) {
    const body: SyncBatchResult = {
      ok: true,
      scanned: result.scanned,
      merged: result.merged,
      remaining: result.remaining,
      next_cursor: result.done ? null : result.next_cursor,
      done: result.done,
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

  const status = result.done ? 'done' : 'partial';
  const location =
    `${appOrigin}/settings?dedup=${status}` +
    `&scanned=${result.scanned}` +
    `&merged=${result.merged}` +
    `&remaining=${result.remaining}`;
  return applyRefreshCookie(
    new Response(null, {
      status: 303,
      headers: { Location: location },
    }),
    adminAuth,
  );
}

/** Default path. Creates a new audit row and enqueues the first
 *  sweep message; the queue consumer drives the loop without an open
 *  browser tab. */
async function handleEnqueue(
  env: Env,
  adminAuth: { cookiesToSet: readonly string[]; ok: true },
  batch: number,
  appOrigin: string,
  wantsJson: boolean,
): Promise<Response> {
  const runId = generateUlid();
  const now = Math.floor(Date.now() / 1000);

  try {
    await env.DB
      .prepare(
        `INSERT INTO dedup_runs
           (id, status, started_at, updated_at)
         VALUES (?1, 'running', ?2, ?2)`,
      )
      .bind(runId, now)
      .run();

    await env.DEDUP_SWEEP.send({
      run_id: runId,
      cursor: null,
      batch,
    });
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'historical_dedup_kick_failed',
      dedup_run_id: runId,
      detail: String(err).slice(0, 500),
    });
    // Best-effort: flip the audit row to 'failed' if the row was
    // inserted but the enqueue failed, so the operator sees a clean
    // failure state. Swallow secondary errors — primary error is
    // already logged.
    try {
      await env.DB
        .prepare(
          `UPDATE dedup_runs
              SET status = 'failed',
                  updated_at = ?2,
                  error = ?3
            WHERE id = ?1
              AND status = 'running'`,
        )
        .bind(runId, now, String(err).slice(0, 500))
        .run();
    } catch {
      /* swallow */
    }
    if (wantsJson) {
      return applyRefreshCookie(
        new Response(
          JSON.stringify({ ok: false, error: 'historical_dedup_kick_failed' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        ),
        adminAuth,
      );
    }
    return applyRefreshCookie(
      new Response(null, {
        status: 303,
        headers: { Location: `${appOrigin}/settings?dedup=error` },
      }),
      adminAuth,
    );
  }

  log('info', 'digest.generation', {
    status: 'historical_dedup_kicked',
    dedup_run_id: runId,
    batch,
  });

  if (wantsJson) {
    const body: KickResult = {
      ok: true,
      run_id: runId,
      enqueued: true,
      started_at: now,
    };
    return applyRefreshCookie(
      new Response(JSON.stringify(body, null, 2), {
        status: 202,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
      adminAuth,
    );
  }

  // Non-JSON callers (a plain HTML form post) get the legacy 303
  // shape with a `dedup=enqueued` flag and the run_id so the
  // /settings JS can wire status polling on the redirected GET.
  return applyRefreshCookie(
    new Response(null, {
      status: 303,
      headers: {
        Location: `${appOrigin}/settings?dedup=enqueued&run_id=${runId}`,
      },
    }),
    adminAuth,
  );
}

/** Parse the request body. Tolerant of empty / malformed bodies — the
 *  default is "enqueue a fresh run with default batch size". */
async function parseBody(request: Request): Promise<ParsedBody> {
  let cursor: DedupCursor | null = null;
  let batch = DEFAULT_BATCH;
  let syncRequested = false;
  try {
    const raw = await request.text();
    if (raw === '') {
      return { cursor: null, batch: DEFAULT_BATCH, syncRequested: false };
    }
    const body = JSON.parse(raw) as { cursor?: unknown; batch?: unknown };
    if (body.cursor !== undefined) {
      syncRequested = true;
      if (
        typeof body.cursor === 'object' &&
        body.cursor !== null &&
        typeof (body.cursor as { pa?: unknown }).pa === 'number' &&
        Number.isFinite((body.cursor as { pa: number }).pa) &&
        typeof (body.cursor as { id?: unknown }).id === 'string'
      ) {
        const c = body.cursor as { pa: number; id: string };
        cursor = { pa: c.pa, id: c.id };
      } else {
        // Legacy `cursor: <number>` shape (or any other malformed
        // value) — log and treat as null so the sync batch starts at
        // the corpus head instead of silently misreading the cursor.
        log('warn', 'digest.generation', {
          status: 'historical_dedup_invalid_cursor',
          cursor_type: typeof body.cursor,
        });
      }
    }
    if (
      typeof body.batch === 'number' &&
      Number.isFinite(body.batch) &&
      body.batch >= 1
    ) {
      syncRequested = true;
      batch = Math.min(MAX_BATCH, Math.floor(body.batch));
    }
  } catch {
    // Body is optional or non-JSON; an empty / malformed body just
    // means "enqueue a fresh run with default batch size".
  }
  return { cursor, batch, syncRequested };
}
