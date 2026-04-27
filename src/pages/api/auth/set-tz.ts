// Implements REQ-SET-007, REQ-AUTH-003
//
// POST /api/auth/set-tz — update the authenticated user's timezone
// after the client-side banner detects a mismatch between the browser's
// current tz and the stored `users.tz` (REQ-SET-007).
//
// Request body: `{ "tz": "<IANA name>" }`. The tz value is validated
// against `Intl.supportedValuesOf('timeZone')` via `isValidTz` so the
// database only ever holds runtime-resolvable zones.
//
// The endpoint is a state-changing POST, so the Origin check
// (REQ-AUTH-003) runs first. Authentication is required — anonymous
// callers get 401 regardless of whether they pass the Origin check.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { log } from '~/lib/log';
import { isValidTz } from '~/lib/tz';
import { loadSession } from '~/middleware/auth';
import { checkOrigin, originOf } from '~/middleware/origin-check';

interface SetTzBody {
  tz?: unknown;
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return errorResponse('app_not_configured');
  }
  const appOrigin = originOf(env.APP_URL);

  const originResult = checkOrigin(context.request, appOrigin);
  if (!originResult.ok) {
    return originResult.response;
  }

  const session = await loadSession(context.request, env.DB, env.OAUTH_JWT_SECRET);
  if (session === null) {
    return errorResponse('unauthorized');
  }

  let body: SetTzBody;
  try {
    body = (await context.request.json()) as SetTzBody;
  } catch {
    return errorResponse('bad_request');
  }

  const tz = body.tz;
  if (typeof tz !== 'string' || tz === '' || !isValidTz(tz)) {
    return errorResponse('invalid_tz');
  }

  try {
    await env.DB.prepare('UPDATE users SET tz = ?1 WHERE id = ?2')
      .bind(tz, session.user.id)
      .run();
  } catch (err) {
    log('error', 'auth.set_tz.failed', {
      user_id: session.user.id,
      error_code: 'internal_error',
      detail: String(err).slice(0, 500),
    });
    return errorResponse('internal_error');
  }

  const headers = new Headers({ 'Content-Type': 'application/json' });
  // Attach the refresh cookie if the session was near-expiry — POST
  // still extends the session like any other authenticated request.
  for (const c of session.cookiesToSet) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify({ ok: true, tz }), { status: 200, headers });
}
