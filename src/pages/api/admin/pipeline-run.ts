// Implements REQ-OPS-008
// Implements REQ-AUTH-001
//
// Operator-only kicker for the backend-driven full pipeline run.
// Creates one `pipeline_runs` row and enqueues exactly one
// `pipeline-jobs` queue message; the consumer drives the rest of the
// phases without an open browser tab.
//
// Mode (`full` or `wipe`):
//   - `full` (default): keep existing embeddings, scrape + dedup.
//   - `wipe`: start at reembed_flip - every article's embedding is
//             invalidated and re-computed before scraping resumes.
//
// HTTP methods:
//   - POST  - accepts `{"mode": "full"|"wipe"}` JSON or form body.
//             Retained for curl, dev-bypass scripts, and JSON API
//             callers; the settings.astro browser path does not use
//             POST. Origin check (checkDevEndpointOrigin) gates
//             browser-driven cross-origin POSTs; curl/dev-bypass
//             passes.
//   - GET   - accepts `?mode=full|wipe` query string. Required because
//             Cloudflare Access intercepts requests to /api/admin/*
//             with an SSO redirect; the browser settings.astro JS
//             does a top-level navigation (not fetch) so the SSO
//             chain completes natively.
//
// Three-layer admin auth (CF-001) gates both methods. A
// `Sec-Fetch-Site` check was considered for `mode=wipe` GET as
// defense-in-depth against a cross-origin `<img src=...>` trigger,
// but the post-SSO redirect chain (news.graymatter.ch -> cloudflare
// access.com -> news.graymatter.ch) poisons the header value to
// `cross-site` per the Fetch Metadata spec, which would 403 the
// legitimate post-SSO request. CF Access plus the admin-email gate
// are the actual security boundary; wipe is destructive but
// recoverable (re-embedding rebuilds the index).

import type { APIContext } from 'astro';
import { log } from '~/lib/log';
import {
  requireAdminSession,
  type AdminAuthResult,
} from '~/middleware/admin-auth';
import { applyRefreshCookie } from '~/middleware/auth';
import { checkDevEndpointOrigin, originOf } from '~/middleware/origin-check';
import { generateUlid } from '~/lib/ulid';
import { enforceRateLimit, RATE_LIMIT_RULES } from '~/lib/rate-limit';
import { sanitizeErrorDetail } from '~/lib/error-sanitize';
import type { PipelinePhase } from '~/queue/pipeline-consumer';

type AdminAuthOk = Extract<AdminAuthResult, { ok: true }>;

interface KickResult {
  ok: true;
  pipeline_run_id: string;
  mode: 'full' | 'wipe';
  current_phase: PipelinePhase;
  started_at: number;
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return new Response('Application not configured', { status: 500 });
  }
  const appOrigin = originOf(env.APP_URL);
  const wantsJson = (context.request.headers.get('Accept') ?? '').includes(
    'application/json',
  );

  if (!checkDevEndpointOrigin(context.request, env.APP_URL)) {
    if (wantsJson) {
      return new Response(
        JSON.stringify({ ok: false, error: 'forbidden_origin' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('Forbidden', { status: 403 });
  }

  const adminAuth = await requireAdminSession(context);
  if (!adminAuth.ok) {
    if (wantsJson) return adminAuth.response;
    return new Response(null, {
      status: 303,
      headers: { Location: `${appOrigin}/settings?pipeline=denied` },
    });
  }

  // CF-008
  const rl = await enforceRateLimit(
    env,
    RATE_LIMIT_RULES.ADMIN_PIPELINE_RUN,
    `user:${adminAuth.userId}`,
  );
  if (!rl.ok) {
    if (wantsJson) {
      return new Response('Too Many Requests', {
        status: 429,
        headers: { 'Retry-After': String(rl.retryAfter) },
      });
    }
    return new Response(null, {
      status: 303,
      headers: { Location: `${appOrigin}/settings?pipeline=rate_limited` },
    });
  }

  const mode = await parseModeFromBody(context.request);
  return runKick(env, adminAuth, appOrigin, wantsJson, mode);
}

export async function GET(context: APIContext): Promise<Response> {
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
      headers: { Location: `${appOrigin}/settings?pipeline=denied` },
    });
  }

  const url = new URL(context.request.url);
  const requestedMode: 'full' | 'wipe' =
    url.searchParams.get('mode') === 'wipe' ? 'wipe' : 'full';

  // CF-009: `wipe` re-embeds the entire corpus — destructive enough
  // that we refuse to serve it from a GET. Browser callers must POST
  // the form; idempotent `full` continues to be reachable via GET
  // (the post-SSO redirect chain depends on it).
  if (requestedMode === 'wipe') {
    if (wantsJson) {
      return new Response(
        JSON.stringify({ ok: false, error: 'method_not_allowed' }),
        {
          status: 405,
          headers: { 'Content-Type': 'application/json', Allow: 'POST' },
        },
      );
    }
    return new Response('Use POST for mode=wipe', {
      status: 405,
      headers: { Allow: 'POST' },
    });
  }

  // CF-008
  const rl = await enforceRateLimit(
    env,
    RATE_LIMIT_RULES.ADMIN_PIPELINE_RUN,
    `user:${adminAuth.userId}`,
  );
  if (!rl.ok) {
    if (wantsJson) {
      return new Response('Too Many Requests', {
        status: 429,
        headers: { 'Retry-After': String(rl.retryAfter) },
      });
    }
    return new Response(null, {
      status: 303,
      headers: { Location: `${appOrigin}/settings?pipeline=rate_limited` },
    });
  }

  return runKick(env, adminAuth, appOrigin, wantsJson, requestedMode);
}

// Shared kick path used by both POST and GET. Inserts the audit row,
// enqueues the first phase message, and shapes the response (JSON 202
// for scripts, 303 to /settings for browsers).
async function runKick(
  env: Env,
  adminAuth: AdminAuthOk,
  appOrigin: string,
  wantsJson: boolean,
  mode: 'full' | 'wipe',
): Promise<Response> {
  const initialPhase: PipelinePhase =
    mode === 'wipe' ? 'reembed_flip' : 'scrape_kick';
  const pipelineRunId = generateUlid();
  const now = Math.floor(Date.now() / 1000);

  try {
    await env.DB
      .prepare(
        `INSERT INTO pipeline_runs
           (id, status, mode, current_phase, embed_processed, embed_remaining,
            started_at, updated_at)
         VALUES (?1, 'running', ?2, ?3, 0, 0, ?4, ?4)`,
      )
      .bind(pipelineRunId, mode, initialPhase, now)
      .run();
    await env.PIPELINE_JOBS.send({
      pipeline_run_id: pipelineRunId,
      phase: initialPhase,
    });
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'pipeline_kick_failed',
      pipeline_run_id: pipelineRunId,
      detail: String(err).slice(0, 500),
    });
    try {
      await env.DB
        .prepare(
          `UPDATE pipeline_runs
              SET status = 'failed',
                  updated_at = ?2,
                  error = ?3
            WHERE id = ?1
              AND status = 'running'`,
        )
        .bind(pipelineRunId, now, sanitizeErrorDetail(err))
        .run();
    } catch {
      /* swallow */
    }
    if (wantsJson) {
      return applyRefreshCookie(
        new Response(
          JSON.stringify({ ok: false, error: 'pipeline_kick_failed' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        ),
        adminAuth,
      );
    }
    return applyRefreshCookie(
      new Response(null, {
        status: 303,
        headers: { Location: `${appOrigin}/settings?pipeline=error` },
      }),
      adminAuth,
    );
  }

  log('info', 'digest.generation', {
    status: 'pipeline_kicked',
    pipeline_run_id: pipelineRunId,
    mode,
    initial_phase: initialPhase,
  });

  if (wantsJson) {
    const body: KickResult = {
      ok: true,
      pipeline_run_id: pipelineRunId,
      mode,
      current_phase: initialPhase,
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

  return applyRefreshCookie(
    new Response(null, {
      status: 303,
      headers: {
        Location: `${appOrigin}/settings?pipeline=enqueued&pipeline_run_id=${encodeURIComponent(pipelineRunId)}`,
      },
    }),
    adminAuth,
  );
}

async function parseModeFromBody(request: Request): Promise<'full' | 'wipe'> {
  try {
    const raw = await request.text();
    if (raw === '') return 'full';
    if (raw.startsWith('{')) {
      const body = JSON.parse(raw) as { mode?: unknown };
      if (body.mode === 'wipe') return 'wipe';
      return 'full';
    }
    const params = new URLSearchParams(raw);
    return params.get('mode') === 'wipe' ? 'wipe' : 'full';
  } catch {
    return 'full';
  }
}
