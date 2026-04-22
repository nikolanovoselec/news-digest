// Implements REQ-AUTH-001, REQ-AUTH-002, REQ-AUTH-004
//
// GET /api/auth/github/callback — finish the GitHub OAuth code flow.
//
// 1. If GitHub returned ?error=, map to our sanitized code (REQ-AUTH-004)
//    and redirect to the landing page.
// 2. Validate the opaque `state` query param against the state cookie
//    (AC 3 — CSRF defense for the OAuth handshake itself).
// 3. Exchange the authorization code for a user access token.
// 4. Fetch the user's numeric id, login, and verified primary email.
//    If no verified+primary email, redirect with ?error=no_verified_email
//    (REQ-AUTH-001 AC 4, REQ-AUTH-004 AC 2).
// 5. Upsert the row in `users` keyed by the GitHub numeric id as TEXT.
// 6. Sign a fresh session JWT (sv=1 on create, or the row's current sv
//    on re-login — never reset existing sv to 1 or we would re-validate
//    logged-out tokens).
// 7. Redirect to /settings?first_run=1 (new user) or /digest (returning).

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { log } from '~/lib/log';
import { signSession } from '~/lib/session-jwt';
import { mapOAuthError, type OAuthErrorCode } from '~/lib/oauth-errors';
import { DEFAULT_TZ } from '~/lib/tz';
import { buildSessionCookie } from '~/middleware/auth';
import {
  OAUTH_STATE_COOKIE_NAME,
  buildClearOAuthStateCookie,
} from './login';
import { originOf } from '~/middleware/origin-check';

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}
interface GitHubUser {
  id: number;
  login: string;
}
interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/**
 * Shape of the existing users row we consult on re-login. We only need
 * the identity + session_version + onboarding-state columns.
 */
interface ExistingUserRow {
  id: string;
  tz: string;
  session_version: number;
  digest_hour: number | null;
  hashtags_json: string | null;
}

/** Read a cookie value from a Cookie header; returns null when absent. */
function readCookie(cookieHeader: string | null, name: string): string | null {
  if (cookieHeader === null || cookieHeader === '') return null;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    if (pair.slice(0, idx).trim() === name) {
      return pair.slice(idx + 1).trim();
    }
  }
  return null;
}

/**
 * Build an HTTP 303 redirect to `/?error=<code>` on the landing page.
 * Cookies attached by the caller (e.g., clearing the state cookie) are
 * preserved via the Headers argument.
 */
function errorRedirect(
  origin: string,
  code: OAuthErrorCode,
  extraHeaders: Headers = new Headers(),
  status = 303,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Location', `${origin}/?error=${encodeURIComponent(code)}`);
  return new Response(null, { status, headers });
}

/**
 * Build a 403 response for state mismatch — the user agent should not
 * follow a redirect in this case because the CSRF invariant already
 * failed once; 403 forces the user to re-initiate.
 */
function invalidStateResponse(origin: string, extraHeaders: Headers): Response {
  const headers = new Headers(extraHeaders);
  const target = `${origin}/?error=invalid_state`;
  headers.set('Location', target);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  // REQ-AUTH-004 AC 3 — HTTP 403 with invalid_state. Browsers do not
  // auto-follow Location headers on 4xx responses, so we also emit a
  // tiny HTML body with a meta-refresh so the user lands on the friendly
  // error page instead of the Cloudflare generic 403. The 403 status is
  // preserved: the CSRF failure remains visible in server logs and to
  // any programmatic caller, and the browser does not treat this as a
  // successful redirect.
  const safeTarget = htmlAttrEscape(target);
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign-in incomplete</title>
<meta http-equiv="refresh" content="0;url=${safeTarget}"></head>
<body><p>Sign-in did not complete. <a href="${safeTarget}">Return to the landing page</a> and try again.</p></body></html>`;
  return new Response(body, { status: 403, headers });
}

/**
 * Escape a string for safe interpolation inside an HTML attribute value.
 * The origin used here is derived from the APP_URL env secret so it is
 * currently trusted, but defense-in-depth: if any caller in the future
 * forwards user input through this helper, an unencoded `"` would break
 * out of the attribute and allow XSS.
 */
function htmlAttrEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Constant-time string comparison for the OAuth state match. The pair
 * of values is opaque (base64url), so byte-by-byte equality over equal-
 * length arrays is sufficient — we XOR-accumulate into a single int so
 * no early return leaks a prefix match.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (
    typeof env.OAUTH_CLIENT_ID !== 'string' ||
    env.OAUTH_CLIENT_ID === '' ||
    typeof env.OAUTH_CLIENT_SECRET !== 'string' ||
    env.OAUTH_CLIENT_SECRET === '' ||
    typeof env.OAUTH_JWT_SECRET !== 'string' ||
    env.OAUTH_JWT_SECRET === '' ||
    typeof env.APP_URL !== 'string' ||
    env.APP_URL === ''
  ) {
    return errorResponse('oauth_not_configured');
  }

  const origin = originOf(env.APP_URL);
  const url = new URL(context.request.url);

  // Always clear the state cookie — whether the handshake succeeds or
  // fails, it is single-use by construction.
  const clearState = buildClearOAuthStateCookie();

  // 1. GitHub-returned error (user clicked "Cancel", etc.) — AC 1 of
  // REQ-AUTH-004. `access_denied` passes through; anything else
  // collapses to `oauth_error`.
  const ghError = url.searchParams.get('error');
  if (ghError !== null && ghError !== '') {
    const code = mapOAuthError(ghError);
    const headers = new Headers();
    headers.append('Set-Cookie', clearState);
    return errorRedirect(origin, code, headers);
  }

  // 2. CSRF state match.
  const queryState = url.searchParams.get('state');
  const cookieHeader = context.request.headers.get('Cookie');
  const cookieState = readCookie(cookieHeader, OAUTH_STATE_COOKIE_NAME);
  if (
    queryState === null ||
    queryState === '' ||
    cookieState === null ||
    cookieState === '' ||
    !timingSafeEqual(queryState, cookieState)
  ) {
    // Log the mismatch signal — no full values, just fingerprints, so an
    // operator can tell a missing-cookie case apart from a mismatched-value
    // case without any PII in the log stream. Diagnostic only.
    log('warn', 'auth.callback.invalid_state', {
      query_state_present: queryState !== null && queryState !== '',
      cookie_state_present: cookieState !== null && cookieState !== '',
      cookie_header_present: cookieHeader !== null,
      cookie_names: cookieHeader !== null
        ? cookieHeader
            .split(';')
            .map((p) => p.split('=')[0]?.trim() ?? '')
            .filter((n) => n !== '')
        : [],
      states_match:
        queryState !== null &&
        cookieState !== null &&
        timingSafeEqual(queryState, cookieState),
    });
    const headers = new Headers();
    headers.append('Set-Cookie', clearState);
    return invalidStateResponse(origin, headers);
  }

  const code = url.searchParams.get('code');
  if (code === null || code === '') {
    const headers = new Headers();
    headers.append('Set-Cookie', clearState);
    return errorRedirect(origin, 'oauth_error', headers);
  }

  // 3. Exchange code for access token.
  let accessToken: string;
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'news-digest',
      },
      body: JSON.stringify({
        client_id: env.OAUTH_CLIENT_ID,
        client_secret: env.OAUTH_CLIENT_SECRET,
        code,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) {
      throw new Error(`token_exchange_http_${tokenRes.status}`);
    }
    const tokenData = (await tokenRes.json()) as GitHubTokenResponse;
    if (typeof tokenData.access_token !== 'string' || tokenData.access_token === '') {
      // GitHub surfaces token-exchange errors in the 200 response body.
      // The raw `error` field is logged server-side via the structured
      // logger; the browser only sees the sanitized code.
      log('error', 'auth.callback.failed', {
        error_code: 'oauth_error',
        detail: String(
          `token_exchange: ${tokenData.error ?? 'unknown'} ${tokenData.error_description ?? ''}`,
        ).slice(0, 500),
      });
      const headers = new Headers();
      headers.append('Set-Cookie', clearState);
      return errorRedirect(origin, 'oauth_error', headers);
    }
    accessToken = tokenData.access_token;
  } catch (err) {
    log('error', 'auth.callback.failed', {
      error_code: 'oauth_error',
      detail: String(err).slice(0, 500),
    });
    const headers = new Headers();
    headers.append('Set-Cookie', clearState);
    return errorRedirect(origin, 'oauth_error', headers);
  }

  // 4. Fetch profile + emails in parallel.
  let ghUser: GitHubUser;
  let email: string | null;
  try {
    const commonHeaders = {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'news-digest',
      Accept: 'application/vnd.github+json',
    } as const;
    const [userRes, emailsRes] = await Promise.all([
      fetch('https://api.github.com/user', {
        headers: commonHeaders,
        signal: AbortSignal.timeout(10_000),
      }),
      fetch('https://api.github.com/user/emails', {
        headers: commonHeaders,
        signal: AbortSignal.timeout(10_000),
      }),
    ]);
    if (!userRes.ok) throw new Error(`github_user_http_${userRes.status}`);
    if (!emailsRes.ok) throw new Error(`github_emails_http_${emailsRes.status}`);
    ghUser = (await userRes.json()) as GitHubUser;
    const emails = (await emailsRes.json()) as GitHubEmail[];
    const primary = emails.find((e) => e.primary === true && e.verified === true);
    email = primary === undefined ? null : primary.email.toLowerCase().trim();
  } catch (err) {
    log('error', 'auth.callback.failed', {
      error_code: 'oauth_error',
      detail: String(err).slice(0, 500),
    });
    const headers = new Headers();
    headers.append('Set-Cookie', clearState);
    return errorRedirect(origin, 'oauth_error', headers);
  }

  // AC 4 of REQ-AUTH-001 — reject without a primary+verified email.
  if (email === null) {
    const headers = new Headers();
    headers.append('Set-Cookie', clearState);
    return errorRedirect(origin, 'no_verified_email', headers);
  }

  // 5. Upsert users row keyed by GitHub numeric id as TEXT.
  const userId = String(ghUser.id);
  const ghLogin = ghUser.login;
  const nowSec = Math.floor(Date.now() / 1000);

  let row: ExistingUserRow | null;
  try {
    row = await env.DB.prepare(
      'SELECT id, tz, session_version, digest_hour, hashtags_json FROM users WHERE id = ?1',
    )
      .bind(userId)
      .first<ExistingUserRow>();
  } catch (err) {
    log('error', 'auth.callback.failed', {
      user_id: userId,
      error_code: 'oauth_error',
      detail: String(err).slice(0, 500),
    });
    const headers = new Headers();
    headers.append('Set-Cookie', clearState);
    return errorRedirect(origin, 'oauth_error', headers);
  }

  let sessionVersion: number;
  let firstRun: boolean;
  try {
    if (row === null) {
      // New user — insert with defaults. digest_hour stays NULL until
      // the settings page saves it; the cron dispatcher keys off
      // `digest_hour IS NOT NULL` to decide whether the user has opted
      // into scheduled generation.
      await env.DB.prepare(
        'INSERT INTO users (id, email, gh_login, tz, digest_minute, email_enabled, session_version, created_at) VALUES (?1, ?2, ?3, ?4, 0, 1, 1, ?5)',
      )
        .bind(userId, email, ghLogin, DEFAULT_TZ, nowSec)
        .run();
      sessionVersion = 1;
      firstRun = true;
    } else {
      // Returning user — update mutable fields (email, gh_login may
      // change upstream), keep session_version as-is so existing tokens
      // stay valid where appropriate.
      await env.DB.prepare(
        'UPDATE users SET email = ?1, gh_login = ?2 WHERE id = ?3',
      )
        .bind(email, ghLogin, userId)
        .run();
      sessionVersion = row.session_version;
      firstRun =
        row.digest_hour === null &&
        (row.hashtags_json === null || row.hashtags_json === '');
    }
  } catch (err) {
    log('error', 'auth.callback.failed', {
      user_id: userId,
      error_code: 'oauth_error',
      detail: String(err).slice(0, 500),
    });
    const headers = new Headers();
    headers.append('Set-Cookie', clearState);
    return errorRedirect(origin, 'oauth_error', headers);
  }

  // 6. Mint session JWT.
  const jwt = await signSession(
    {
      sub: userId,
      email,
      ghl: ghLogin,
      sv: sessionVersion,
    },
    env.OAUTH_JWT_SECRET,
  );

  log('info', 'auth.login', {
    user_id: userId,
    new_user: firstRun,
    status: 'success',
  });

  // 7. Redirect based on onboarding state.
  const destination = firstRun ? '/settings?first_run=1' : '/digest';
  const headers = new Headers();
  headers.append('Set-Cookie', clearState);
  headers.append('Set-Cookie', buildSessionCookie(jwt));
  headers.set('Location', `${origin}${destination}`);
  return new Response(null, { status: 303, headers });
}
