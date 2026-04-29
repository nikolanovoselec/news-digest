// Implements REQ-AUTH-001
//
// Three-layer admin gate for `/api/admin/*` (CF-001). Each admin route
// calls {@link requireAdminSession} as its first action.
//
// Layer 1 — `Cf-Access-Jwt-Assertion` header presence.
//   Cloudflare Access stamps this header on every request that passes
//   its zone-level rule. A request without it is either coming via
//   `*.workers.dev` (no Access binding) or via a misconfigured zone.
//   Reject in both cases.
//
// Layer 2 — Worker-side session.
//   The user must be signed in. Bare presence of the Access JWT is
//   not enough — Access only proves the request crossed the perimeter,
//   not who's on the other end of the keyboard.
//
// Layer 3 — `ADMIN_EMAIL` match.
//   The signed-in user's email must equal `env.ADMIN_EMAIL`. This
//   limits admin actions to a single operator account; more granular
//   policy (multiple admins, per-action permissions) is future work.
//
// Optional layer — `CF_ACCESS_AUD` audience match.
//   When `env.CF_ACCESS_AUD` is set, the helper additionally decodes the
//   Access JWT payload (without verifying the signature — Cloudflare
//   already verified it before forwarding) and asserts the `aud` claim
//   matches. Defends against an attacker forging the header on a route
//   that didn't actually traverse Access.

import type { APIContext } from 'astro';
import { applyRefreshCookie, loadSession } from '~/middleware/auth';
import { log } from '~/lib/log';
import { base64UrlDecode } from '~/lib/crypto';

/** Successful admin auth result. `cookiesToSet` is forwarded to the
 *  caller so they can attach the access + refresh cookies to their
 *  outgoing response — admin routes participate in the access/refresh
 *  flow just like every other authenticated endpoint. */
export type AdminAuthResult =
  | { ok: true; userId: string; email: string; cookiesToSet: string[] }
  | { ok: false; response: Response };

interface AccessJwtClaims {
  aud?: string | string[];
  email?: string;
  sub?: string;
  exp?: number;
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
  if (typeof parsed !== 'object' || parsed === null) return null;
  return parsed as AccessJwtClaims;
}

function audMatches(
  claimAud: string | string[] | undefined,
  expected: string,
): boolean {
  if (typeof claimAud === 'string') return claimAud === expected;
  if (Array.isArray(claimAud)) return claimAud.includes(expected);
  return false;
}

// Per-isolate memo so the AUD-unset warning fires once per Worker
// instance, not on every admin probe. Logs are best-effort
// observability; emitting on every request would flood Logpush during
// brute-force probes against an Access-bound deploy that forgot to
// set CF_ACCESS_AUD.
let audWarningEmitted = false;

/**
 * Run the three-layer admin gate. Returns `{ ok: true, ... }` only when
 * all enforced layers pass; otherwise returns a pre-built `Response`
 * the caller should return verbatim.
 */
export async function requireAdminSession(
  context: APIContext,
): Promise<AdminAuthResult> {
  const env = context.locals.runtime.env;

  // Layer 1: Cloudflare Access header presence.
  const accessJwt = context.request.headers.get('Cf-Access-Jwt-Assertion');
  if (accessJwt === null || accessJwt === '') {
    log('warn', 'admin.auth.denied', { reason: 'missing_access_jwt' });
    return {
      ok: false,
      response: new Response('Unauthorized', { status: 401 }),
    };
  }

  // Layer 1b (optional): aud claim match.
  if (typeof env.CF_ACCESS_AUD === 'string' && env.CF_ACCESS_AUD !== '') {
    const claims = decodeAccessJwt(accessJwt);
    if (claims === null || !audMatches(claims.aud, env.CF_ACCESS_AUD)) {
      log('warn', 'admin.auth.denied', { reason: 'access_aud_mismatch' });
      return {
        ok: false,
        response: new Response('Unauthorized', { status: 401 }),
      };
    }
  } else {
    // CF_ACCESS_AUD is unset — Layer 1 is checking header presence
    // only. Forks without Access bound run with admin unreachable
    // (Layer 1 always rejects). The risky configuration is a
    // production deploy where Access IS bound to the custom domain
    // but the *.workers.dev subdomain remains live AND CF_ACCESS_AUD
    // is unset — an attacker can forge any JWT-shaped header on
    // workers.dev and pass Layer 1. Layers 2+3 still gate, but the
    // perimeter check is missing. Surfacing the warn log lets the
    // operator catch this misconfiguration via tail/Logpush.
    //
    // Emit once per Worker isolate (not per request). Workers cycle
    // isolates every ~30 minutes under load, which is the right
    // cadence for an operator alert without flooding Logpush.
    if (!audWarningEmitted) {
      audWarningEmitted = true;
      log('warn', 'admin.auth.aud_unset_warning', {
        detail:
          'Cf-Access-Jwt-Assertion present but CF_ACCESS_AUD is unset; ' +
          'set CF_ACCESS_AUD or disable the *.workers.dev subdomain.',
      });
    }
  }

  // Layer 2: Worker-side session.
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

  // Layer 3: ADMIN_EMAIL match. Configured email is required; a deploy
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
    cookiesToSet: session.cookiesToSet,
  };
}
