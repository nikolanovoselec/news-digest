// Implements REQ-AUTH-002, REQ-AUTH-008
//
// POST /api/auth/refresh — explicit refresh endpoint.
//
// In normal operation the middleware does inline refresh on every
// authenticated request, so this endpoint is rarely needed. It exists
// for two cases:
//   1. The XHR-from-an-expired-page case: a long-running tab loses its
//      access JWT but still has a refresh cookie. A client-side fetch
//      to a state-changing API would 401 on the refresh-needed path
//      because middleware can't safely auto-refresh on the same POST
//      request that mutates state. Calling /api/auth/refresh first
//      mints a new access JWT; the original POST then succeeds.
//   2. Test surface: integration tests want a deterministic place to
//      exercise the refresh-token rotation flow.
//
// On success: 204 No Content with both Set-Cookie headers.
// On failure: 401 Unauthorized + clearing both cookies.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { loadSession, applyRefreshCookie, buildClearSessionCookie } from '~/middleware/auth';
import { buildClearRefreshCookie } from '~/lib/refresh-tokens';
import { checkOrigin, originOf } from '~/middleware/origin-check';

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return errorResponse('app_not_configured');
  }
  const appOrigin = originOf(env.APP_URL);

  // POST → enforce Origin per REQ-AUTH-003. The refresh-token cookie
  // alone is not sufficient if the request came from a foreign origin.
  const originResult = checkOrigin(context.request, appOrigin);
  if (!originResult.ok) {
    return originResult.response;
  }

  const session = await loadSession(context.request, env.DB, env.OAUTH_JWT_SECRET);
  if (session === null) {
    // Refresh failed — clear both cookies so the browser stops sending
    // a now-dead refresh value on every request.
    const headers = new Headers();
    headers.append('Set-Cookie', buildClearSessionCookie());
    headers.append('Set-Cookie', buildClearRefreshCookie());
    return new Response(JSON.stringify({ ok: false, code: 'unauthorized' }), {
      status: 401,
      headers: {
        ...Object.fromEntries(headers),
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  }

  // Force-mint fresh cookies even when loadSession's primary path was
  // valid — the explicit refresh endpoint always rotates so callers
  // can rely on a fresh window.
  return applyRefreshCookie(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }),
    session,
  );
}
