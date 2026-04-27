// Implements REQ-AUTH-002, REQ-AUTH-003
//
// POST /api/auth/logout — bump `users.session_version` for the
// currently authenticated user, then clear the session cookie and
// redirect to `/?logged_out=1`. Provider-agnostic: a session minted
// by any sign-in provider is revoked the same way (the session JWT
// holds the canonical user id; logout doesn't care which provider
// issued it).
//
// Bumping session_version is what delivers instant revocation of every
// outstanding JWT previously issued to this user (REQ-AUTH-002 AC 3):
// every token on the wire (across devices, tabs, etc.) still verifies
// cryptographically but fails the `sv` check in auth middleware.
//
// We only accept POST so CSRF from an <img> or <a> tag cannot sign a
// user out. The Origin check (REQ-AUTH-003) is applied before any DB
// mutation.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { log } from '~/lib/log';
import { verifySession } from '~/lib/session-jwt';
import { SESSION_COOKIE_NAME, buildClearSessionCookie } from '~/middleware/auth';
import { checkOrigin, originOf } from '~/middleware/origin-check';
import { readCookie } from '~/lib/crypto';

// `readCookie` is imported from `~/lib/crypto` (CF-005 — was duplicated
// here, in `auth/[provider]/callback.ts`, and in `middleware/auth.ts`).

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

  // Identify the user from the JWT (by subject) — we don't rely on
  // auth middleware here because logout must succeed even if the row's
  // session_version has already been bumped by another tab.
  const token = readCookie(context.request.headers.get('Cookie'), SESSION_COOKIE_NAME);
  const jwtSecret = env.OAUTH_JWT_SECRET;
  let loggedOutUserId: string | null = null;
  if (token !== null && typeof jwtSecret === 'string' && jwtSecret !== '') {
    const claims = await verifySession(token, jwtSecret);
    if (claims !== null) {
      loggedOutUserId = claims.sub;
      try {
        await env.DB.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?1')
          .bind(claims.sub)
          .run();
      } catch (err) {
        // A row lookup failure (race with account deletion) is not a
        // user-facing error — the cookie still gets cleared below.
        log('error', 'auth.callback.failed', {
          user_id: claims.sub,
          error_code: 'logout_sv_bump_failed',
          detail: String(err).slice(0, 500),
        });
      }
    }
  }

  if (loggedOutUserId !== null) {
    log('info', 'auth.logout', { user_id: loggedOutUserId });
  }

  const headers = new Headers();
  headers.append('Set-Cookie', buildClearSessionCookie());
  headers.set('Location', `${appOrigin}/?logged_out=1`);
  return new Response(null, { status: 303, headers });
}
