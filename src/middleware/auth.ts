// Implements REQ-AUTH-002, REQ-AUTH-008
//
// Session validation middleware for Astro routes.
//
// Auth lives in two cookies:
//   1. `__Host-news_digest_session` — short-lived (5 min) HMAC-SHA256
//      JWT. Carries `sub`, `email`, `ghl`, `sv`, `exp`. Verified on
//      every request.
//   2. `__Host-news_digest_refresh` — long-lived (30 day) opaque
//      random ID. Looked up against the `refresh_tokens` D1 table on
//      access-token expiry.
//
// `loadSession` is the single entry point. It tries the access JWT
// first; if missing or expired, it tries the refresh-token flow
// inline (one D1 lookup, fingerprint check, rotate on success). Both
// new cookies come back through `refreshCookie` / `rotatedRefreshCookie`
// so the caller can attach them via `applyRefreshCookie` before
// returning the response.

import { signSession, verifySession } from '~/lib/session-jwt';
import { readCookie as readCookieCanonical } from '~/lib/crypto';
import {
  REFRESH_TOKEN_COOKIE_NAME,
  ROTATION_GRACE_SECONDS,
  buildRefreshCookie,
  deviceFingerprint,
  findRefreshToken,
  findUnrevokedChild,
  rotateRefreshToken,
  revokeAllForUser,
  type RefreshTokenRow,
} from '~/lib/refresh-tokens';
import { log } from '~/lib/log';
import type { AuthenticatedUser } from '~/lib/types';

export const SESSION_COOKIE_NAME = '__Host-news_digest_session';
const SESSION_TTL_SECONDS = 5 * 60; // 5 min — REQ-AUTH-002 AC 1
const SESSION_COOKIE_ATTRS = `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;

/**
 * Shape of the minimum user record the middleware needs — this exists
 * so the middleware can be tested without pulling in the full
 * AuthenticatedUser type. Runtime users are upcast to the full type.
 */
interface UserRow {
  id: string;
  email: string;
  gh_login: string;
  tz: string;
  digest_hour: number | null;
  digest_minute: number;
  hashtags_json: string | null;
  model_id: string | null;
  email_enabled: number;
  session_version: number;
}

/**
 * Parse a single cookie value out of a Cookie header string. Returns
 * null when the cookie is absent. Case-sensitive per RFC 6265.
 *
 * Re-exported from `~/lib/crypto` (CF-005). New code should import the
 * canonical version directly; this re-export preserves callers that
 * already imported `readCookie` from this module.
 */
export const readCookie = readCookieCanonical;

/**
 * Build the `Set-Cookie` string for a signed session JWT.
 * The `__Host-` prefix requires Secure, Path=/, and no Domain attribute
 * (RFC 6265bis section 4.1.3.5).
 */
export function buildSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; ${SESSION_COOKIE_ATTRS}`;
}

/**
 * Build the `Set-Cookie` string that clears the session cookie.
 * Max-Age=0 and an empty value instruct the browser to drop it.
 */
export function buildClearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Result of {@link loadSession}.
 *
 * `cookiesToSet` is the list of `Set-Cookie` strings the caller must
 * append to the outgoing response. It can carry zero, one, or two
 * entries depending on what the middleware did:
 *   - empty: access JWT was already valid, no cookie churn.
 *   - one: a dead refresh cookie was cleared (reuse / fingerprint /
 *     expired-refresh — already null-returning paths use this).
 *   - two: refresh-token rotation succeeded, both the new access JWT
 *     and the new refresh-token cookie are returned.
 */
export interface LoadSessionResult {
  user: AuthenticatedUser;
  cookiesToSet: string[];
}

async function loadUserById(
  db: D1Database,
  userId: string,
): Promise<UserRow | null> {
  try {
    return await db
      .prepare(
        'SELECT id, email, gh_login, tz, digest_hour, digest_minute, hashtags_json, model_id, email_enabled, session_version FROM users WHERE id = ?1',
      )
      .bind(userId)
      .first<UserRow>();
  } catch {
    return null;
  }
}

function toAuthenticatedUser(row: UserRow): AuthenticatedUser {
  return {
    id: row.id,
    email: row.email,
    gh_login: row.gh_login,
    tz: row.tz,
    digest_hour: row.digest_hour,
    digest_minute: row.digest_minute,
    hashtags_json: row.hashtags_json,
    model_id: row.model_id,
    email_enabled: row.email_enabled,
    session_version: row.session_version,
  };
}

/**
 * Load the session user for {@link request} against {@link db} and
 * {@link jwtSecret}. Returns `null` when no valid session exists
 * (missing cookies, bad signatures, expired refresh, user deleted,
 * session_version mismatch, fingerprint mismatch). Never throws — bad
 * input means no user.
 *
 * Two paths:
 *   1. Access JWT valid → return the user, no cookie churn.
 *   2. Access JWT missing/expired but refresh cookie valid →
 *      a. fingerprint matches → mint new access JWT + rotate refresh
 *         token (REQ-AUTH-008 AC 2)
 *      b. revoked refresh token presented → revoke ALL of the user's
 *         refresh tokens + bump session_version (REQ-AUTH-008 AC 4)
 *      c. fingerprint mismatch or expired → clear refresh cookie
 */
export async function loadSession(
  request: Request,
  db: D1Database,
  jwtSecret: string,
): Promise<LoadSessionResult | null> {
  const cookieHeader = request.headers.get('Cookie');
  const accessToken = readCookie(cookieHeader, SESSION_COOKIE_NAME);
  const refreshValue = readCookie(cookieHeader, REFRESH_TOKEN_COOKIE_NAME);

  // Path 1 — access JWT present & valid.
  if (accessToken !== null) {
    const claims = await verifySession(accessToken, jwtSecret);
    if (claims !== null) {
      const row = await loadUserById(db, claims.sub);
      if (row !== null && row.session_version === claims.sv) {
        return {
          user: toAuthenticatedUser(row),
          cookiesToSet: [],
        };
      }
    }
  }

  // Path 2 — fall through to refresh-token flow.
  if (refreshValue === null) return null;

  const refreshRow = await findRefreshToken(db, refreshValue);
  if (refreshRow === null) {
    // Cookie value not in DB. Could be a stale cookie from a deleted
    // session — clear it.
    return null;
  }

  const nowSec = Math.floor(Date.now() / 1000);

  // REQ-AUTH-008 AC 4 — reuse detection vs. concurrent-rotation
  // tolerance. A revoked token reappearing has two possible causes:
  //   (a) post-rotation theft — attacker stole the cookie and is
  //       replaying it. This is the case AC 4 protects against.
  //   (b) benign concurrent rotation — same client made two parallel
  //       requests against the same expired access JWT, both invoked
  //       refresh, one won the rotation, the other lost. The loser
  //       presents a now-revoked cookie inside the grace window.
  // We distinguish via the grace window: if `revoked_at` is within
  // ROTATION_GRACE_SECONDS, treat as benign and serve a fresh access
  // JWT WITHOUT rotating again (the winner already minted the new
  // refresh row). If outside the window, treat as theft and nuke
  // every refresh row for the user.
  if (refreshRow.revoked_at !== null) {
    const sinceRevoked = nowSec - refreshRow.revoked_at;
    // Negative `sinceRevoked` (revoked_at is in the future — clock
    // skew, replication lag, malicious DB write) MUST NOT pass the
    // grace check; otherwise an attacker who can advance the row's
    // revoked_at into the future gets unbounded grace.
    if (sinceRevoked >= 0 && sinceRevoked <= ROTATION_GRACE_SECONDS) {
      // REQ-AUTH-008 AC 1 — even in the benign-collision branch, the
      // device fingerprint must match. Otherwise an attacker with a
      // freshly-stolen-and-just-rotated cookie could ride the grace
      // window to mint one extra 5-min access JWT.
      const presentFingerprint = await deviceFingerprint(request);
      if (presentFingerprint !== refreshRow.device_fingerprint_hash) {
        await revokeAllForUser(db, refreshRow.user_id, nowSec);
        log('warn', 'auth.refresh.grace_fingerprint_mismatch', {
          user_id: refreshRow.user_id,
          refresh_token_id: refreshRow.id,
        });
        return null;
      }
      const child = await findUnrevokedChild(db, refreshRow.id);
      if (child !== null) {
        const userRow = await loadUserById(db, refreshRow.user_id);
        if (userRow === null) return null;
        const fresh = await signSession(
          {
            sub: userRow.id,
            email: userRow.email,
            ghl: userRow.gh_login,
            sv: userRow.session_version,
          },
          jwtSecret,
        );
        log('info', 'auth.refresh.concurrent_collision', {
          user_id: userRow.id,
          revoked_token_id: refreshRow.id,
          surviving_child_id: child.id,
          since_revoked_seconds: sinceRevoked,
        });
        // Serve the fresh access JWT only — no refresh cookie. The
        // client's stale revoked cookie keeps working for the rest
        // of the grace window; their next refresh after the winner's
        // Set-Cookie lands will pick up the winner's value.
        return {
          user: toAuthenticatedUser(userRow),
          cookiesToSet: [buildSessionCookie(fresh)],
        };
      }
    }
    // Outside grace window OR no surviving child — treat as theft.
    await revokeAllForUser(db, refreshRow.user_id, nowSec);
    log('warn', 'auth.refresh.reuse_detected', {
      user_id: refreshRow.user_id,
      refresh_token_id: refreshRow.id,
      since_revoked_seconds: sinceRevoked,
    });
    return null;
  }

  if (refreshRow.expires_at <= nowSec) {
    log('info', 'auth.refresh.expired', {
      user_id: refreshRow.user_id,
      refresh_token_id: refreshRow.id,
    });
    return null;
  }

  // Device fingerprint check — UA + Cf-IPCountry hashed at issuance.
  const presentFingerprint = await deviceFingerprint(request);
  if (presentFingerprint !== refreshRow.device_fingerprint_hash) {
    // Treat fingerprint mismatch as suspicious. Don't nuke the whole
    // user (that would lock them out across legitimate device-rotation
    // events like a browser-version bump on a different tab) — just
    // revoke this row and force re-login on this device.
    log('warn', 'auth.refresh.fingerprint_mismatch', {
      user_id: refreshRow.user_id,
      refresh_token_id: refreshRow.id,
    });
    return null;
  }

  // All checks passed — rotate.
  const userRow = await loadUserById(db, refreshRow.user_id);
  if (userRow === null) return null;

  let rotated: { value: string; id: string } | null;
  try {
    rotated = await rotateRefreshToken(db, refreshRow, request, nowSec);
  } catch (err) {
    log('error', 'auth.refresh.rotate_failed', {
      user_id: refreshRow.user_id,
      detail: String(err).slice(0, 500),
    });
    return null;
  }

  // Concurrent-rotation collision — another caller rotated this row
  // between our findRefreshToken and rotate calls. The other caller
  // has minted the surviving refresh cookie; we just serve a fresh
  // access JWT (per the grace-window branch above). The client's
  // stale cookie remains valid until the winner's Set-Cookie lands.
  if (rotated === null) {
    const fresh = await signSession(
      {
        sub: userRow.id,
        email: userRow.email,
        ghl: userRow.gh_login,
        sv: userRow.session_version,
      },
      jwtSecret,
    );
    log('info', 'auth.refresh.concurrent_lost_race', {
      user_id: userRow.id,
      refresh_token_id: refreshRow.id,
    });
    return {
      user: toAuthenticatedUser(userRow),
      cookiesToSet: [buildSessionCookie(fresh)],
    };
  }

  const fresh = await signSession(
    {
      sub: userRow.id,
      email: userRow.email,
      ghl: userRow.gh_login,
      sv: userRow.session_version,
    },
    jwtSecret,
  );

  log('info', 'auth.refresh.rotated', {
    user_id: userRow.id,
    refresh_token_id: rotated.id,
    parent_id: refreshRow.id,
  });

  return {
    user: toAuthenticatedUser(userRow),
    cookiesToSet: [
      buildSessionCookie(fresh),
      buildRefreshCookie(rotated.value),
    ],
  };
}

/**
 * Apply any cookies the middleware produced to the outgoing response.
 * Pass the {@link LoadSessionResult} from {@link loadSession} (or its
 * `cookiesToSet` array directly).
 */
export function applyRefreshCookie(
  response: Response,
  result: { cookiesToSet: string[] } | readonly string[] | null,
): Response {
  if (result === null) return response;
  const cookies = Array.isArray(result) ? result : (result as { cookiesToSet: string[] }).cookiesToSet;
  if (cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Extract the active refresh-token row id (if any) from the request,
 *  for the logout path which wants to revoke just that row rather than
 *  bumping session_version on every login site for the user. */
export async function activeRefreshTokenRow(
  request: Request,
  db: D1Database,
): Promise<RefreshTokenRow | null> {
  const refreshValue = readCookie(request.headers.get('Cookie'), REFRESH_TOKEN_COOKIE_NAME);
  if (refreshValue === null) return null;
  return findRefreshToken(db, refreshValue);
}
