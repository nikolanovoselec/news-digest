// DEV-ONLY auth bypass. Gated by the `DEV_BYPASS_TOKEN` Worker secret —
// if unset, the endpoint returns 404 and is effectively disabled.
//
// Purpose: scripts/e2e-test.sh can acquire a session for the project
// owner without driving GitHub OAuth, so a full API + page smoke run
// can execute from a headless shell after every deploy.
//
// Security model:
//   - The bypass token lives as a Worker secret, unreachable from the
//     browser and absent from the bundle. Only callers who possess it
//     can mint a session.
//   - The minted session is for the SAME user that would normally exist
//     (the owner), so the blast radius equals "owner is logged in
//     somewhere else". No privilege escalation is possible beyond what
//     the owner already has.
//   - Removing the secret (`npx wrangler secret delete DEV_BYPASS_TOKEN`)
//     disables the endpoint instantly without requiring a redeploy.
//   - The endpoint never accepts a user id from the caller — the target
//     user is derived server-side from `DEV_BYPASS_USER_ID` (or the
//     first row in `users` if that secret is unset).

import type { APIContext } from 'astro';
import { signSession } from '~/lib/session-jwt';
import { buildSessionCookie } from '~/middleware/auth';

interface BypassEnv {
  DEV_BYPASS_TOKEN?: string;
  DEV_BYPASS_USER_ID?: string;
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

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
  if (match === null || !(await timingSafeEqual(match[1] ?? '', bypass))) {
    return new Response(null, { status: 404 });
  }

  // Target user: explicit override via DEV_BYPASS_USER_ID, otherwise the
  // first user row. Caller cannot influence selection.
  let userId = env.DEV_BYPASS_USER_ID;
  if (typeof userId !== 'string' || userId === '') {
    const row = await env.DB
      .prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1')
      .first<{ id: string }>();
    if (row === null) {
      return new Response('no users in db', { status: 404 });
    }
    userId = row.id;
  }

  const user = await env.DB
    .prepare('SELECT session_version FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ session_version: number }>();
  if (user === null) {
    return new Response('user not found', { status: 404 });
  }

  const jwt = await signSession(
    { sub: userId, sv: user.session_version },
    env.OAUTH_JWT_SECRET,
  );

  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.append('Set-Cookie', buildSessionCookie(jwt));
  return new Response(
    JSON.stringify({ ok: true, user_id: userId }),
    { status: 200, headers },
  );
}
