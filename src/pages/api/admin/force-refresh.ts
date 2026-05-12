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
import { checkOrigin, hasBearerAuth, originOf } from '~/middleware/origin-check';
import { requireAdminSession } from '~/middleware/admin-auth';
import { applyRefreshCookie } from '~/middleware/auth';
import { kickCoordinator } from '~/lib/kick-coordinator';
import { enforceRateLimit, RATE_LIMIT_RULES } from '~/lib/rate-limit';

/** CF-008 — Build a 429 response body shared between POST + GET paths. */
function rateLimited(retryAfter: number): Response {
  return new Response('Too Many Requests', {
    status: 429,
    headers: { 'Retry-After': String(retryAfter) },
  });
}

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

  const adminAuth = await requireAdminSession(context);
  if (!adminAuth.ok) return adminAuth.response;

  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return new Response('Application not configured', { status: 500 });
  }
  const appOrigin = originOf(env.APP_URL);

  const rl = await enforceRateLimit(
    env,
    RATE_LIMIT_RULES.ADMIN_FORCE_REFRESH,
    `user:${adminAuth.userId}`,
  );
  if (!rl.ok) return rateLimited(rl.retryAfter);

  // CF-015: defence-in-depth CSRF guard. Scripted callers presenting
  // `Authorization: Bearer ...` carry no cookies and are not a CSRF
  // surface, so they bypass the Origin check.
  if (!hasBearerAuth(context.request)) {
    const originResult = checkOrigin(context.request, appOrigin);
    if (!originResult.ok) return originResult.response;
  }

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
  const wantsJson = (context.request.headers.get('Accept') ?? '').includes('application/json');

  const adminAuth = await requireAdminSession(context);
  if (!adminAuth.ok) {
    // Browsers landing here via the Cloudflare Access callback should
    // not see a raw 401/403 body — bounce them back to /settings with
    // an explicit deny marker so the operator can see what happened.
    // Scripts that opted into JSON keep the raw status response.
    if (wantsJson) return adminAuth.response;
    // Need APP_URL to build the redirect. If unset, fall back to the
    // raw auth response (acceptable: misconfigured deployment).
    if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
      return adminAuth.response;
    }
    const denyOrigin = originOf(env.APP_URL);
    return new Response(null, {
      status: 303,
      headers: { Location: `${denyOrigin}/settings?force_refresh=denied` },
    });
  }

  // CF-011: post-auth APP_URL check (no pre-auth config leak).
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return new Response('Application not configured', { status: 500 });
  }
  const appOrigin = originOf(env.APP_URL);

  // CF-011: Sec-Fetch-Site defense-in-depth. AD38 designates the GET
  // path as the post-SSO callback target, so `none` (top-level
  // navigation) must remain allowed. `same-origin` is the legitimate
  // first-party fetch case. Anything else is a cross-site initiator;
  // CF Access perimeter + admin session would still gate the actual
  // dispatch, but this closes the residual same-browser-CSRF gap.
  const secFetchSite = context.request.headers.get('Sec-Fetch-Site');
  if (
    secFetchSite !== null &&
    secFetchSite !== 'same-origin' &&
    secFetchSite !== 'none'
  ) {
    log('warn', 'admin.auth.denied', {
      status: 'force-refresh:sec-fetch-site:rejected',
      sec_fetch_site: secFetchSite.slice(0, 32),
    });
    return new Response('Cross-site request denied', { status: 403 });
  }

  const rl = await enforceRateLimit(
    env,
    RATE_LIMIT_RULES.ADMIN_FORCE_REFRESH,
    `user:${adminAuth.userId}`,
  );
  if (!rl.ok) {
    if (wantsJson) return rateLimited(rl.retryAfter);
    return new Response(null, {
      status: 303,
      headers: { Location: `${appOrigin}/settings?force_refresh=rate_limited` },
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
