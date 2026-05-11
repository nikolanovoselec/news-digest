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
import {
  enforceRateLimit,
  rateLimitResponse,
  RATE_LIMIT_RULES,
} from '~/lib/rate-limit';
import { isValidTz } from '~/lib/tz';
import { requireSession } from '~/middleware/auth';
import { checkOrigin, originOf } from '~/middleware/origin-check';
import { SetTzBodySchema } from '~/lib/schemas/set-tz';

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

  const auth = await requireSession(context.request, env);
  if (!auth.ok) return auth.response;

  const rl = await enforceRateLimit(
    env,
    RATE_LIMIT_RULES.SET_TZ,
    `user:${auth.user.id}`,
  );
  if (!rl.ok) return rateLimitResponse(rl.retryAfter);

  // CF-013: parse + shape-validate via Zod. The `invalid_tz` error
  // code (covering "not a string", "empty string", and "not a valid
  // IANA zone") is preserved by keeping `tz` as `unknown` in the
  // schema; Zod's job here is to reject non-object bodies and
  // unknown extra fields.
  let rawBody: unknown;
  try {
    rawBody = await context.request.json();
  } catch {
    return errorResponse('bad_request');
  }
  const parsed = SetTzBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse('bad_request');
  }

  const tz = parsed.data.tz;
  if (typeof tz !== 'string' || tz === '' || !isValidTz(tz)) {
    return errorResponse('invalid_tz');
  }

  try {
    await env.DB.prepare('UPDATE users SET tz = ?1 WHERE id = ?2')
      .bind(tz, auth.user.id)
      .run();
  } catch (err) {
    log('error', 'auth.set_tz.failed', {
      user_id: auth.user.id,
      error_code: 'internal_error',
      detail: String(err).slice(0, 500),
    });
    return errorResponse('internal_error');
  }

  const headers = new Headers({ 'Content-Type': 'application/json' });
  // Attach the refresh cookie if the session was near-expiry — POST
  // still extends the session like any other authenticated request.
  for (const c of auth.cookiesToSet) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify({ ok: true, tz }), { status: 200, headers });
}
