// Implements REQ-AUTH-002
//
// Session validation middleware for Astro routes. Reads the
// `__Host-news_digest_session` cookie, verifies the JWT via
// src/lib/session-jwt, checks `sv` against users.session_version, and
// auto-refreshes the cookie when less than 5 minutes remain (AC 4 —
// threshold lowered from 15 → 5 min in CF-010).
//
// The middleware is intentionally framework-agnostic: it operates on
// Request/Response and mutates a generic locals bag (`{ user?: ... }`).
// Astro routes consume the populated `locals.user`; API route handlers
// can call the exported helpers directly.

import { signSession, verifySession, shouldRefreshJWT } from '~/lib/session-jwt';
import { readCookie as readCookieCanonical } from '~/lib/crypto';
import type { AuthenticatedUser } from '~/lib/types';

export const SESSION_COOKIE_NAME = '__Host-news_digest_session';
const SESSION_TTL_SECONDS = 3600; // 1h — REQ-AUTH-002 AC 1
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
 * Load the session user for {@link request} against {@link db} and
 * {@link jwtSecret}. Returns `null` when no valid session exists (missing
 * cookie, bad signature, expired, user deleted, session_version
 * mismatch). Never throws — bad input means no user.
 *
 * On near-expiry (less than 5 minutes remain) the returned object
 * includes a `refreshCookie` string that the caller MUST attach to the
 * outgoing response as a `Set-Cookie` header. This is how REQ-AUTH-002
 * AC 4 silent-refresh is implemented: the middleware doesn't own the
 * response object, but it produces the header value.
 */
export async function loadSession(
  request: Request,
  db: D1Database,
  jwtSecret: string,
): Promise<{ user: AuthenticatedUser; refreshCookie: string | null } | null> {
  const token = readCookie(request.headers.get('Cookie'), SESSION_COOKIE_NAME);
  if (token === null) return null;

  const claims = await verifySession(token, jwtSecret);
  if (claims === null) return null;

  // AC 2 — session_version must match the current row. A mismatch means
  // logout or account deletion happened on another session. Returning
  // null here triggers the logged-out UX without any cookie churn on the
  // caller (the browser still holds a cryptographically valid but stale
  // token; it expires on its own within the hour).
  let row: UserRow | null;
  try {
    row = await db
      .prepare(
        'SELECT id, email, gh_login, tz, digest_hour, digest_minute, hashtags_json, model_id, email_enabled, session_version FROM users WHERE id = ?1',
      )
      .bind(claims.sub)
      .first<UserRow>();
  } catch {
    return null;
  }
  if (row === null) return null;
  if (row.session_version !== claims.sv) return null;

  // AC 4 — re-issue when less than 5 minutes remain on the active
  // token. We sign a fresh JWT with the SAME sv (the row sv we just
  // loaded is authoritative) so a logout in flight still wins.
  let refreshCookie: string | null = null;
  if (shouldRefreshJWT(claims)) {
    const fresh = await signSession(
      {
        sub: row.id,
        email: row.email,
        ghl: row.gh_login,
        sv: row.session_version,
      },
      jwtSecret,
    );
    refreshCookie = buildSessionCookie(fresh);
  }

  const user: AuthenticatedUser = {
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
  return { user, refreshCookie };
}

/**
 * Apply a refresh cookie to the outgoing response headers, if present.
 * Callers pass the `refreshCookie` string from {@link loadSession} and
 * the Response they are about to return; on near-expiry the header is
 * appended (not replaced), preserving any Set-Cookie the handler itself
 * wrote.
 */
export function applyRefreshCookie(response: Response, refreshCookie: string | null): Response {
  if (refreshCookie === null) return response;
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', refreshCookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
