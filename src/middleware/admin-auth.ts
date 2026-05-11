// Implements REQ-AUTH-001
//
// Admin gate for `/api/admin/*` (CF-001). Each admin route calls
// {@link requireAdminSession} as its first action.
//
// Baseline (always enforced):
//   Layer A — Worker-side session. The user must be signed in via OAuth.
//   Layer B — `ADMIN_EMAIL` match. The signed-in user's email must equal
//             `env.ADMIN_EMAIL`. This limits admin actions to a single
//             operator account; more granular policy (multiple admins,
//             per-action permissions) is future work.
//
// Optional perimeter (Cloudflare Access — additive security on top):
//   Layer 0 — When `env.CF_ACCESS_AUD` is set, the helper enforces both
//             `Cf-Access-Jwt-Assertion` header presence AND that the JWT's
//             `aud` claim matches `env.CF_ACCESS_AUD`. The signature is
//             not re-verified (Cloudflare already verified it before
//             forwarding); the aud check defends against a forged header
//             on a request that didn't actually traverse Access.
//
//   When `CF_ACCESS_AUD` is unset, Layer 0 is skipped entirely. This is
//   the deliberate semantics for environments without Access bound (e.g.
//   integration): ADMIN_EMAIL gating is sufficient by itself, and CF
//   Access is opt-in additive perimeter.

import type { APIContext } from 'astro';
import type { AuthenticatedUser } from '~/lib/types';
import { applyRefreshCookie, loadSession } from '~/middleware/auth';
import { log } from '~/lib/log';
import { base64UrlDecode } from '~/lib/crypto';

/** Successful admin auth result. `cookiesToSet` is forwarded to the
 *  caller so they can attach the access + refresh cookies to their
 *  outgoing response — admin routes participate in the access/refresh
 *  flow just like every other authenticated endpoint.
 *
 *  CF-030: the full {@link AuthenticatedUser} is exposed alongside the
 *  bare userId/email so admin routes that need other user fields
 *  (hashtags_json, daily_digest_email_consent, …) can read them from
 *  this result instead of calling `requireSession` a second time.
 *  Calling loadSession twice doubled the auth_refresh rate-limit
 *  drain per request and opened a token-rotation race window. */
export type AdminAuthResult =
  | {
      ok: true;
      userId: string;
      email: string;
      user: AuthenticatedUser;
      cookiesToSet: string[];
    }
  | { ok: false; response: Response };

interface AccessJwtClaims {
  aud?: string | string[];
  email?: string;
  sub?: string;
  exp?: number;
}

function isAccessJwtClaims(p: unknown): p is AccessJwtClaims {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  if (
    o['aud'] !== undefined &&
    typeof o['aud'] !== 'string' &&
    !Array.isArray(o['aud'])
  ) {
    return false;
  }
  if (o['email'] !== undefined && typeof o['email'] !== 'string') return false;
  if (o['sub'] !== undefined && typeof o['sub'] !== 'string') return false;
  if (o['exp'] !== undefined && typeof o['exp'] !== 'number') return false;
  return true;
}

function decodeAccessJwt(jwt: string): AccessJwtClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1] ?? '';
  if (payload === '') return null;
  let decoded: Uint8Array;
  try {
    decoded = base64UrlDecode(payload);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return null;
  }
  if (!isAccessJwtClaims(parsed)) return null;
  // CF-007-R: reject access tokens whose `exp` is in the past or
  // missing. Cloudflare Access stamps `exp` on every issued JWT; a
  // missing field means the token shape is non-standard (synthetic or
  // tampered) and a past `exp` means a replay attempt with an
  // expired credential. Either way the JWT must be treated as invalid.
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof parsed.exp !== 'number' || parsed.exp < nowSec) return null;
  return parsed;
}

function audMatches(
  claimAud: string | string[] | undefined,
  expected: string,
): boolean {
  if (typeof claimAud === 'string') return claimAud === expected;
  if (Array.isArray(claimAud)) return claimAud.includes(expected);
  return false;
}

/**
 * Run the admin gate. Layers A (session) and B (ADMIN_EMAIL) always
 * enforce; Layer 0 (CF Access JWT + aud match) enforces only when
 * `env.CF_ACCESS_AUD` is configured. Returns `{ ok: true, ... }` only
 * when every enforced layer passes; otherwise returns a pre-built
 * `Response` the caller should return verbatim.
 */
export async function requireAdminSession(
  context: APIContext,
): Promise<AdminAuthResult> {
  const env = context.locals.runtime.env;

  // Optional perimeter (Layer 0): only enforced when CF_ACCESS_AUD is
  // configured. Without it, CF Access is treated as additive security
  // that an operator can bind in front of the worker but is not
  // mandatory — Layers A+B (session + ADMIN_EMAIL) gate admin alone.
  const expectedAud =
    typeof env.CF_ACCESS_AUD === 'string' && env.CF_ACCESS_AUD !== ''
      ? env.CF_ACCESS_AUD
      : null;
  if (expectedAud !== null) {
    const accessJwt = context.request.headers.get('Cf-Access-Jwt-Assertion');
    if (accessJwt === null || accessJwt === '') {
      log('warn', 'admin.auth.denied', { reason: 'missing_access_jwt' });
      return {
        ok: false,
        response: new Response('Unauthorized', { status: 401 }),
      };
    }
    const claims = decodeAccessJwt(accessJwt);
    if (claims === null || !audMatches(claims.aud, expectedAud)) {
      log('warn', 'admin.auth.denied', { reason: 'access_aud_mismatch' });
      return {
        ok: false,
        response: new Response('Unauthorized', { status: 401 }),
      };
    }
  }

  // Layer A: Worker-side session.
  const session = await loadSession(
    context.request,
    env.DB,
    env.OAUTH_JWT_SECRET,
    env.KV,
  );
  if (session.user === null) {
    log('warn', 'admin.auth.denied', { reason: 'no_session' });
    return {
      ok: false,
      response: applyRefreshCookie(
        new Response('Unauthorized', { status: 401 }),
        session,
      ),
    };
  }
  const sessionUser = session.user;

  // Layer B: ADMIN_EMAIL match. Configured email is required; a deploy
  // that forgot to set it locks /api/admin/* down rather than opening
  // it up.
  if (typeof env.ADMIN_EMAIL !== 'string' || env.ADMIN_EMAIL === '') {
    log('warn', 'admin.auth.denied', {
      reason: 'admin_email_not_configured',
      user_id: sessionUser.id,
    });
    return {
      ok: false,
      response: applyRefreshCookie(
        new Response('Forbidden', { status: 403 }),
        session,
      ),
    };
  }
  if (
    sessionUser.email.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()
  ) {
    log('warn', 'admin.auth.denied', {
      reason: 'not_admin',
      user_id: sessionUser.id,
    });
    return {
      ok: false,
      response: applyRefreshCookie(
        new Response('Forbidden', { status: 403 }),
        session,
      ),
    };
  }

  return {
    ok: true,
    userId: sessionUser.id,
    email: sessionUser.email,
    user: sessionUser,
    cookiesToSet: session.cookiesToSet,
  };
}
