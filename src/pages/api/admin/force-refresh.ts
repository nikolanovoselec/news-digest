// Implements REQ-PIPE-001
// Implements REQ-OPS-005
// Implements REQ-AUTH-001
//
// Operator-only manual kick of the global-feed coordinator (every-4-hours cron).
// Path: POST /api/admin/force-refresh + GET /api/admin/force-refresh.
//
// Accepts POST (from the Settings page button) + GET (for a direct
// URL visit). Starts a fresh scrape_runs row with status='running'
// and sends a single SCRAPE_COORDINATOR queue message — the exact
// same work the `0 * * * *` cron does.
//
// Access control (CF-001 — three layers):
//   1. Cloudflare Access at the zone level (with optional aud check).
//   2. Worker-side session via loadSession.
//   3. Session user email matches env.ADMIN_EMAIL.
// Plus the existing Origin check on POST for CSRF defence-in-depth.

import type { APIContext } from 'astro';
import { log } from '~/lib/log';
import { checkOrigin, originOf } from '~/middleware/origin-check';
import { requireAdminSession } from '~/middleware/admin-auth';
import { applyRefreshCookie } from '~/middleware/auth';
import { kickCoordinator } from '~/lib/kick-coordinator';

function redirectToSettings(origin: string, runId: string, reused: boolean): Response {
  const status = reused ? 'reused' : 'ok';
  // ULIDs in Crockford base32 don't strictly need encoding, but the
  // value originates from D1 and a future code path that allows non-
  // ULID IDs would otherwise admit header injection through the
  // Location header. Mirrors the `tag` encoding in retry.ts.
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${origin}/settings?force_refresh=${status}&run_id=${encodeURIComponent(runId)}`,
    },
  });
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return new Response('Application not configured', { status: 500 });
  }
  const appOrigin = originOf(env.APP_URL);

  const adminAuth = await requireAdminSession(context);
  if (!adminAuth.ok) return adminAuth.response;

  const originResult = checkOrigin(context.request, appOrigin);
  if (!originResult.ok) return originResult.response;

  try {
    const { run_id, reused } = await kickCoordinator(env);
    return applyRefreshCookie(
      redirectToSettings(appOrigin, run_id, reused),
      adminAuth,
    );
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'force_refresh_failed',
      detail: String(err).slice(0, 500),
    });
    return new Response('Failed to dispatch coordinator', { status: 500 });
  }
}

export async function GET(context: APIContext): Promise<Response> {
  // GET path exists for two callers:
  //   1. Browsers landing here via the Cloudflare Access post-auth
  //      callback — Access intercepts the form's POST, bounces through
  //      SSO, and returns the user as a GET to the original URL. They
  //      should never see raw JSON; redirect them back to /settings.
  //   2. Scripts/curl that explicitly want JSON — they opt in by
  //      sending `Accept: application/json`.
  // Three-layer admin auth (CF-001) gates both paths. No Origin check
  // because GET is idempotent in spec — but the underlying coordinator
  // dispatch is not, so we still require admin auth.
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return new Response('Application not configured', { status: 500 });
  }
  const appOrigin = originOf(env.APP_URL);
  const wantsJson = (context.request.headers.get('Accept') ?? '').includes('application/json');

  const adminAuth = await requireAdminSession(context);
  if (!adminAuth.ok) {
    // Browsers landing here via the Cloudflare Access callback should
    // not see a raw 401/403 body — bounce them back to /settings with
    // an explicit deny marker so the operator can see what happened.
    // Scripts that opted into JSON keep the raw status response.
    if (wantsJson) return adminAuth.response;
    return new Response(null, {
      status: 303,
      headers: { Location: `${appOrigin}/settings?force_refresh=denied` },
    });
  }

  try {
    const { run_id, reused } = await kickCoordinator(env);
    if (wantsJson) {
      return applyRefreshCookie(
        new Response(
          JSON.stringify({ ok: true, scrape_run_id: run_id, reused }, null, 2),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          },
        ),
        adminAuth,
      );
    }
    return applyRefreshCookie(
      redirectToSettings(appOrigin, run_id, reused),
      adminAuth,
    );
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'force_refresh_failed',
      detail: String(err).slice(0, 500),
    });
    if (wantsJson) {
      return new Response('Failed to dispatch coordinator', { status: 500 });
    }
    return new Response(null, {
      status: 303,
      headers: { Location: `${appOrigin}/settings?force_refresh=error` },
    });
  }
}
