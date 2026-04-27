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
// Always force-rotates the refresh row on success — callers that hit
// this endpoint specifically want a fresh window regardless of how
// much time was left on the access JWT.
//
// On success: 200 OK with both Set-Cookie headers (new access JWT +
// rotated refresh cookie).
// On failure: 401 Unauthorized + clearing both cookies.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { signSession } from '~/lib/session-jwt';
import {
  buildSessionCookie,
  buildClearSessionCookie,
} from '~/middleware/auth';
import {
  REFRESH_TOKEN_COOKIE_NAME,
  ROTATION_GRACE_SECONDS,
  buildRefreshCookie,
  buildClearRefreshCookie,
  deviceFingerprint,
  findRefreshToken,
  findUnrevokedChild,
  rotateRefreshToken,
  revokeAllForUser,
} from '~/lib/refresh-tokens';
import { readCookie } from '~/lib/crypto';
import { checkOrigin, originOf } from '~/middleware/origin-check';
import {
  enforceRateLimit,
  rateLimitResponse,
  clientIp,
  RATE_LIMIT_RULES,
} from '~/lib/rate-limit';
import { log } from '~/lib/log';

interface UserMinRow {
  id: string;
  email: string;
  gh_login: string;
  session_version: number;
}

function unauthorizedResponse(): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  headers.append('Set-Cookie', buildClearSessionCookie());
  headers.append('Set-Cookie', buildClearRefreshCookie());
  return new Response(JSON.stringify({ ok: false, code: 'unauthorized' }), {
    status: 401,
    headers,
  });
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return errorResponse('app_not_configured');
  }
  if (typeof env.OAUTH_JWT_SECRET !== 'string' || env.OAUTH_JWT_SECRET === '') {
    return errorResponse('oauth_not_configured');
  }
  const appOrigin = originOf(env.APP_URL);

  // POST → enforce Origin per REQ-AUTH-003. The refresh-token cookie
  // alone is not sufficient if the request came from a foreign origin.
  const originResult = checkOrigin(context.request, appOrigin);
  if (!originResult.ok) {
    return originResult.response;
  }

  // REQ-AUTH-008 — Tier 1 (pre-validation): IP-keyed rate limit. Caps
  // random-cookie spam and bounds DOS without paying for a DB lookup
  // per request. Shared bucket with the inline middleware refresh path
  // so attackers can't pivot between the two.
  const ipRate = await enforceRateLimit(
    env,
    RATE_LIMIT_RULES.AUTH_REFRESH_IP,
    `ip:${clientIp(context.request)}`,
  );
  if (!ipRate.ok) {
    log('warn', 'auth.refresh.rate_limited', {
      ip: clientIp(context.request),
      bucket: 'ip',
      via: 'explicit_refresh',
      retry_after_seconds: ipRate.retryAfter,
    });
    return rateLimitResponse(ipRate.retryAfter);
  }

  const refreshValue = readCookie(
    context.request.headers.get('Cookie'),
    REFRESH_TOKEN_COOKIE_NAME,
  );
  if (refreshValue === null) {
    return unauthorizedResponse();
  }

  const row = await findRefreshToken(env.DB, refreshValue);
  if (row === null) {
    return unauthorizedResponse();
  }

  const nowSec = Math.floor(Date.now() / 1000);

  // REQ-AUTH-008 AC 4 — reuse detection with grace-window tolerance.
  if (row.revoked_at !== null) {
    const sinceRevoked = nowSec - row.revoked_at;
    // Negative `sinceRevoked` (clock skew / replication lag) must not
    // open the grace window indefinitely.
    if (sinceRevoked >= 0 && sinceRevoked <= ROTATION_GRACE_SECONDS) {
      // REQ-AUTH-008 AC 1 — fingerprint check applies in the grace
      // branch too, otherwise a stolen cookie within the rotation
      // window mints one free access JWT off any device.
      const presentFp = await deviceFingerprint(context.request);
      if (presentFp !== row.device_fingerprint_hash) {
        await revokeAllForUser(env.DB, row.user_id, nowSec);
        log('warn', 'auth.refresh.grace_fingerprint_mismatch', {
          user_id: row.user_id,
          refresh_token_id: row.id,
          via: 'explicit_refresh',
        });
        return unauthorizedResponse();
      }
      // Concurrent-rotation collision — serve a fresh access JWT
      // off the surviving child without rotating again.
      const child = await findUnrevokedChild(env.DB, row.id);
      if (child !== null) {
        // Tier-2 user limit gates the JWT mint. Without it, an
        // attacker with a freshly-stolen-and-just-rotated cookie that
        // passes the fingerprint check could mint up to 60 access
        // JWTs in the 30 s grace window (bounded only by the per-IP
        // tier). The 10/min/user cap collapses that to 10 mints
        // before reuse-detection inevitably fires the next request.
        const userRate = await enforceRateLimit(
          env,
          RATE_LIMIT_RULES.AUTH_REFRESH_USER,
          `user:${row.user_id}`,
        );
        if (!userRate.ok) {
          log('warn', 'auth.refresh.rate_limited', {
            user_id: row.user_id,
            bucket: 'user',
            path: 'grace_collision',
            via: 'explicit_refresh',
            retry_after_seconds: userRate.retryAfter,
          });
          return rateLimitResponse(userRate.retryAfter);
        }
        const user = await env.DB
          .prepare(
            'SELECT id, email, gh_login, session_version FROM users WHERE id = ?1',
          )
          .bind(row.user_id)
          .first<UserMinRow>();
        if (user === null) return unauthorizedResponse();
        const fresh = await signSession(
          { sub: user.id, email: user.email, ghl: user.gh_login, sv: user.session_version },
          env.OAUTH_JWT_SECRET,
        );
        const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
        headers.append('Set-Cookie', buildSessionCookie(fresh));
        return new Response(JSON.stringify({ ok: true, rotated: false }), {
          status: 200,
          headers,
        });
      }
    }
    // Theft — revoke everything for the user.
    await revokeAllForUser(env.DB, row.user_id, nowSec);
    log('warn', 'auth.refresh.reuse_detected', {
      user_id: row.user_id,
      refresh_token_id: row.id,
      since_revoked_seconds: sinceRevoked,
      via: 'explicit_refresh',
    });
    return unauthorizedResponse();
  }

  if (row.expires_at <= nowSec) {
    return unauthorizedResponse();
  }

  // Tier 2 (post-validation): user-keyed limit. Catches a stolen
  // cookie distributed across many IPs that bypasses the per-IP tier.
  // MUST run AFTER the revoked-row branch so an attacker replaying a
  // stolen-and-already-revoked cookie doesn't burn the legitimate
  // user's budget before reuse-detection fires.
  const userRate = await enforceRateLimit(
    env,
    RATE_LIMIT_RULES.AUTH_REFRESH_USER,
    `user:${row.user_id}`,
  );
  if (!userRate.ok) {
    log('warn', 'auth.refresh.rate_limited', {
      user_id: row.user_id,
      bucket: 'user',
      path: 'rotation',
      via: 'explicit_refresh',
      retry_after_seconds: userRate.retryAfter,
    });
    return rateLimitResponse(userRate.retryAfter);
  }

  // Device fingerprint check.
  const present = await deviceFingerprint(context.request);
  if (present !== row.device_fingerprint_hash) {
    log('warn', 'auth.refresh.fingerprint_mismatch', {
      user_id: row.user_id,
      refresh_token_id: row.id,
      via: 'explicit_refresh',
    });
    return unauthorizedResponse();
  }

  const user = await env.DB
    .prepare(
      'SELECT id, email, gh_login, session_version FROM users WHERE id = ?1',
    )
    .bind(row.user_id)
    .first<UserMinRow>();
  if (user === null) return unauthorizedResponse();

  let rotated: { value: string; id: string } | null;
  try {
    rotated = await rotateRefreshToken(env.DB, row, context.request, nowSec);
  } catch (err) {
    log('error', 'auth.refresh.rotate_failed', {
      user_id: row.user_id,
      detail: String(err).slice(0, 500),
    });
    return unauthorizedResponse();
  }

  const fresh = await signSession(
    { sub: user.id, email: user.email, ghl: user.gh_login, sv: user.session_version },
    env.OAUTH_JWT_SECRET,
  );

  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  headers.append('Set-Cookie', buildSessionCookie(fresh));

  if (rotated === null) {
    // Concurrent caller rotated between findRefreshToken and rotate.
    // Serve fresh access JWT only; client's stale cookie is good for
    // the rest of the grace window.
    return new Response(JSON.stringify({ ok: true, rotated: false }), {
      status: 200,
      headers,
    });
  }

  headers.append('Set-Cookie', buildRefreshCookie(rotated.value));
  log('info', 'auth.refresh.rotated', {
    user_id: user.id,
    refresh_token_id: rotated.id,
    parent_id: row.id,
    via: 'explicit_refresh',
  });
  return new Response(JSON.stringify({ ok: true, rotated: true }), {
    status: 200,
    headers,
  });
}
