// DEV-ONLY auth bypass. Gated by the `DEV_BYPASS_TOKEN` Worker secret —
// if unset, the endpoint returns 404 and is effectively disabled.
//
// Purpose: scripts/e2e-test.sh can acquire a session for the synthetic
// `__e2e__` user (provisioned by migrations/0006_e2e_user.sql) without
// driving GitHub OAuth, so a full API + page smoke run can execute from
// a headless shell after every deploy without touching the operator's
// real account.
//
// Security model:
//   - The bypass token lives as a Worker secret, unreachable from the
//     browser and absent from the bundle. Only callers who possess it
//     can mint a session.
//   - The minted session targets the synthetic `__e2e__` row by default
//     so e2e mutations (tag writes, stars, scrape triggers) stay
//     sandboxed. `DEV_BYPASS_USER_ID` lets an operator override this
//     for unusual cases (e.g. impersonating a specific account on
//     staging) but the default is always the sandbox row.
//   - Removing the secret (`npx wrangler secret delete DEV_BYPASS_TOKEN`)
//     disables the endpoint instantly without requiring a redeploy.
//   - The endpoint never accepts a user id from the caller — the target
//     user is derived server-side from `DEV_BYPASS_USER_ID` (when set)
//     or the synthetic `__e2e__` row (when unset).

import type { APIContext } from 'astro';
import { signSession } from '~/lib/session-jwt';
import { buildSessionCookie } from '~/middleware/auth';
import { E2E_USER_ID } from '~/lib/system-user';
import { timingSafeEqualHmac } from '~/lib/crypto';
import {
  buildRefreshCookie,
  issueRefreshToken,
} from '~/lib/refresh-tokens';

interface BypassEnv {
  DEV_BYPASS_TOKEN?: string;
  DEV_BYPASS_USER_ID?: string;
}

// `timingSafeEqualHmac` is imported from `~/lib/crypto` (CF-005 — was
// open-coded as a JS XOR loop here and in dev/trigger-scrape.ts).

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env as typeof context.locals.runtime.env &
    BypassEnv;

  const bypass = env.DEV_BYPASS_TOKEN;
  if (typeof bypass !== 'string' || bypass === '') {
    return new Response(null, { status: 404 });
  }
  if (typeof env.OAUTH_JWT_SECRET !== 'string' || env.OAUTH_JWT_SECRET === '') {
    return new Response('oauth_jwt_secret not set', { status: 500 });
  }

  const auth = context.request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (
    match === null ||
    !(await timingSafeEqualHmac(match[1] ?? '', bypass, env.OAUTH_JWT_SECRET))
  ) {
    return new Response(null, { status: 404 });
  }

  // Target user: default to the synthetic `__e2e__` row provisioned by
  // migrations/0006_e2e_user.sql so e2e mutations never leak into the
  // operator's real account. `DEV_BYPASS_USER_ID` overrides this for
  // unusual cases (impersonating a specific account on staging). The
  // caller never influences selection — the value is server-side only.
  let userId = env.DEV_BYPASS_USER_ID;
  if (typeof userId !== 'string' || userId === '') {
    userId = E2E_USER_ID;
  }

  // SessionClaims requires email + ghl (verifySession → isSessionClaims
  // rejects tokens missing them), so we pull the full identity triple.
  const user = await env.DB
    .prepare('SELECT session_version, email, gh_login FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ session_version: number; email: string; gh_login: string }>();
  if (user === null) {
    return new Response('user not found', { status: 404 });
  }

  const jwt = await signSession(
    {
      sub: userId,
      email: user.email,
      ghl: user.gh_login,
      sv: user.session_version,
    },
    env.OAUTH_JWT_SECRET,
  );

  // Issue a refresh-token row too so e2e tests can exercise the
  // long-lived session contract (REQ-AUTH-008). Failures here are
  // non-fatal — the access JWT alone is enough for a single e2e run.
  let refreshValue: string | null = null;
  try {
    const issued = await issueRefreshToken(env.DB, userId, context.request);
    refreshValue = issued.value;
  } catch {
    refreshValue = null;
  }

  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.append('Set-Cookie', buildSessionCookie(jwt));
  if (refreshValue !== null) {
    headers.append('Set-Cookie', buildRefreshCookie(refreshValue));
  }
  return new Response(
    JSON.stringify({ ok: true, user_id: userId }),
    { status: 200, headers },
  );
}
