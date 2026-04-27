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
  buildClearRefreshCookie,
  buildRefreshCookie,
  deviceFingerprint,
  findRefreshToken,
  findUnrevokedChild,
  rotateRefreshToken,
  revokeAllForUser,
} from '~/lib/refresh-tokens';
import { errorResponse } from '~/lib/errors';
import { log } from '~/lib/log';
import {
  RATE_LIMIT_RULES,
  clientIp,
  enforceRateLimit,
} from '~/lib/rate-limit';
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
 * Result of {@link loadSession}. Always non-null; auth failure is
 * signalled by `user === null`. `cookiesToSet` is the list of
 * `Set-Cookie` strings the caller must append to the outgoing
 * response (use {@link applyRefreshCookie}). Possible shapes:
 *   - `{ user: <row>, cookiesToSet: [] }` — access JWT valid.
 *   - `{ user: <row>, cookiesToSet: [session, refresh] }` — refresh
 *     rotation succeeded, both new cookies returned.
 *   - `{ user: <row>, cookiesToSet: [session] }` — concurrent-rotation
 *     grace branch, fresh access JWT only.
 *   - `{ user: null, cookiesToSet: [clearSession, clearRefresh] }` —
 *     theft / fingerprint mismatch / expired refresh / unknown row;
 *     dead cookies are cleared so the browser stops replaying them.
 *   - `{ user: null, cookiesToSet: [] }` — no cookies present, or
 *     inline-refresh rate limit hit (don't clear; let the client retry).
 */
export interface LoadSessionResult {
  user: AuthenticatedUser | null;
  cookiesToSet: string[];
}

/** Convenience constant — the cookie strings that clear both auth cookies. */
const CLEAR_BOTH_COOKIES: readonly string[] = [
  buildClearSessionCookie(),
  buildClearRefreshCookie(),
];

function unauthenticated(clearCookies: boolean): LoadSessionResult {
  return {
    user: null,
    cookiesToSet: clearCookies ? [...CLEAR_BOTH_COOKIES] : [],
  };
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
 * {@link jwtSecret}. Always returns a {@link LoadSessionResult} —
 * `user === null` signals "not authenticated" and `cookiesToSet` may
 * carry clear-cookie directives that the caller must attach via
 * {@link applyRefreshCookie}. Never throws.
 *
 * Pass {@link kv} to rate-limit the inline refresh-token rotation path.
 * Two tiers: AUTH_REFRESH_IP runs before the DB lookup (anti-spam),
 * AUTH_REFRESH_USER runs after a valid refresh row is found (caps a
 * stolen-cookie attacker holding a real user's refresh value). When
 * {@link kv} is omitted both tiers are skipped — only acceptable for
 * unit tests; production callers must always pass the namespace.
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
  kv?: KVNamespace,
): Promise<LoadSessionResult> {
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
  if (refreshValue === null) {
    // No refresh cookie either. If the access JWT was present-but-bad
    // we still want to clear it so the browser stops sending it.
    return unauthenticated(accessToken !== null);
  }

  // REQ-AUTH-001 AC 9 — Tier 1 (pre-validation): IP-keyed limit caps
  // random-cookie spam without paying a DB lookup per request. The
  // bucket is shared with `POST /api/auth/refresh` (same routeClass)
  // so an attacker can't pivot between the inline and explicit paths.
  if (kv !== undefined) {
    const rate = await enforceRateLimit(
      { KV: kv },
      RATE_LIMIT_RULES.AUTH_REFRESH_IP,
      `ip:${clientIp(request)}`,
    );
    if (!rate.ok) {
      log('warn', 'auth.refresh.rate_limited', {
        ip: clientIp(request),
        bucket: 'ip',
        retry_after_seconds: rate.retryAfter,
      });
      // Don't clear cookies — the user may be legitimate and just
      // bursty; let the next request after the window succeed.
      return unauthenticated(false);
    }
  }

  const refreshRow = await findRefreshToken(db, refreshValue);
  if (refreshRow === null) {
    // Cookie value not in DB. Stale cookie from a deleted session, or
    // a cookie issued before a DB rebuild — clear it.
    return unauthenticated(true);
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
        return unauthenticated(true);
      }
      const child = await findUnrevokedChild(db, refreshRow.id);
      if (child !== null) {
        const userRow = await loadUserById(db, refreshRow.user_id);
        if (userRow === null) return unauthenticated(true);
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
    return unauthenticated(true);
  }

  if (refreshRow.expires_at <= nowSec) {
    log('info', 'auth.refresh.expired', {
      user_id: refreshRow.user_id,
      refresh_token_id: refreshRow.id,
    });
    return unauthenticated(true);
  }

  // Tier 2 (post-validation): user-keyed limit. Catches a stolen
  // cookie distributed across many IPs that the per-IP tier alone
  // would miss. MUST run AFTER the revoked-row branch so an attacker
  // replaying a stolen-and-already-revoked cookie doesn't burn the
  // legitimate user's budget before reuse-detection fires.
  if (kv !== undefined) {
    const rate = await enforceRateLimit(
      { KV: kv },
      RATE_LIMIT_RULES.AUTH_REFRESH_USER,
      `user:${refreshRow.user_id}`,
    );
    if (!rate.ok) {
      log('warn', 'auth.refresh.rate_limited', {
        user_id: refreshRow.user_id,
        bucket: 'user',
        retry_after_seconds: rate.retryAfter,
      });
      return unauthenticated(false);
    }
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
    return unauthenticated(true);
  }

  // All checks passed — rotate.
  const userRow = await loadUserById(db, refreshRow.user_id);
  if (userRow === null) return unauthenticated(true);

  let rotated: { value: string; id: string } | null;
  try {
    rotated = await rotateRefreshToken(db, refreshRow, request, nowSec);
  } catch (err) {
    log('error', 'auth.refresh.rotate_failed', {
      user_id: refreshRow.user_id,
      detail: String(err).slice(0, 500),
    });
    return unauthenticated(true);
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
 * Apply the cookies a session helper produced to the outgoing response.
 * Pass any object exposing `cookiesToSet: readonly string[]` — typically
 * a {@link LoadSessionResult} or {@link PageSessionResult}. `null` is
 * accepted as a no-op for legacy callers that may not have a session.
 *
 * Single-shape signature on purpose: a previous iteration accepted a
 * raw string array too, but that was never used in production and made
 * passing a discriminated-union result a footgun (e.g. {@link
 * RequireSessionResult}'s `ok: false` branch silently lacks
 * `cookiesToSet`).
 */
export function applyRefreshCookie(
  response: Response,
  result: { cookiesToSet: readonly string[] } | null,
): Response {
  if (result === null) return response;
  if (result.cookiesToSet.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const c of result.cookiesToSet) headers.append('Set-Cookie', c);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Subset of `Env` that auth helpers actually need — narrow on purpose so
 *  the helper is testable without constructing the full Env shape. */
export interface AuthEnv {
  DB: D1Database;
  OAUTH_JWT_SECRET: string;
  KV: KVNamespace;
}

/**
 * Result of {@link requireSession}: either an authenticated user with the
 * cookies the caller must attach to its success response, or a pre-built
 * unauthorized {@link Response} (already cookie-cleared) the caller can
 * return verbatim. Mirrors the shape of `requireAdminSession` so route
 * handlers have one consistent gate pattern.
 */
export type RequireSessionResult =
  | { ok: true; user: AuthenticatedUser; cookiesToSet: string[] }
  | { ok: false; response: Response };

/**
 * API-route session gate. Wraps {@link loadSession} and the unauthorized-
 * branch cookie-clearing dance so callers don't have to repeat them.
 * Pass {@link unauthorized} to customise the failure response (e.g. a
 * 303 redirect instead of the default `errorResponse('unauthorized')`).
 *
 * Usage:
 * ```ts
 * const auth = await requireSession(context.request, env);
 * if (!auth.ok) return auth.response;
 * // auth.user.id, auth.cookiesToSet
 * ```
 */
export async function requireSession(
  request: Request,
  env: AuthEnv,
  unauthorized: () => Response = () => errorResponse('unauthorized'),
): Promise<RequireSessionResult> {
  const session = await loadSession(
    request,
    env.DB,
    env.OAUTH_JWT_SECRET,
    env.KV,
  );
  if (session.user === null) {
    return { ok: false, response: applyRefreshCookie(unauthorized(), session) };
  }
  return {
    ok: true,
    user: session.user,
    cookiesToSet: session.cookiesToSet,
  };
}

/** What {@link loadSessionForPage} hands back to the caller. */
export interface PageSessionResult {
  /** Authenticated user, or null when the caller should redirect. */
  user: AuthenticatedUser | null;
  /** Cookies that have already been appended to the page-response
   *  Headers. Returned again so callers that produce an additional
   *  Response (e.g. a settings-gate redirect) can paint the same
   *  Set-Cookie strings onto its headers without re-running auth. */
  cookiesToSet: string[];
}

/**
 * Astro-page session gate. Mutates {@link responseHeaders} (typically
 * `Astro.response.headers`) so refresh-rotation cookies — and clear-
 * cookie directives on the unauthenticated branch — land on the page
 * response without the caller having to loop manually.
 *
 * Usage:
 * ```ts
 * const session = await loadSessionForPage(Astro.request, env, Astro.response.headers);
 * if (session.user === null) return Astro.redirect('/', 303);
 * Astro.locals.user = session.user;
 * // If a settings-gate hands back its own redirect Response:
 * for (const c of session.cookiesToSet) gated.headers.append('Set-Cookie', c);
 * ```
 */
export async function loadSessionForPage(
  request: Request,
  env: AuthEnv,
  responseHeaders: Headers,
): Promise<PageSessionResult> {
  const session = await loadSession(
    request,
    env.DB,
    env.OAUTH_JWT_SECRET,
    env.KV,
  );
  for (const c of session.cookiesToSet) responseHeaders.append('Set-Cookie', c);
  return { user: session.user, cookiesToSet: session.cookiesToSet };
}

