// Implements REQ-AUTH-001, REQ-AUTH-002, REQ-AUTH-004
//
// GET /api/auth/<provider>/callback — finish the OAuth/OIDC code flow
// for any configured provider. The dynamic `[provider]` segment maps
// to entries in `~/lib/oauth-providers`; unknown names 404 before any
// further work.
//
// 1. If the provider returned ?error=, map to a sanitized code
//    (REQ-AUTH-004) and redirect to the landing page.
// 2. Validate the opaque `state` query param against the per-provider
//    state cookie (AC 3 — CSRF defense for the OAuth handshake).
// 3. Exchange the authorization code for an access token (and id_token
//    when the provider issues one).
// 4. Run the provider's `fetchProfile` adapter to extract a stable
//    user identifier and verified email. If the provider refuses to
//    release a verified email, surface `no_verified_email` with the
//    provider name appended.
// 5. Upsert the row in `users` keyed by the canonical `users.id`
//    (`<provider>:<sub>` for non-GitHub providers; bare numeric id
//    for GitHub for legacy compatibility).
// 6. Sign a fresh session JWT (sv=1 on create, or the row's current
//    sv on re-login — never reset existing sv to 1 or we would
//    re-validate logged-out tokens).
// 7. Redirect to /digest for everyone — new users land with complete
//    onboarding defaults at insert time.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { log } from '~/lib/log';
import { signSession } from '~/lib/session-jwt';
import { mapOAuthError, type OAuthErrorCode } from '~/lib/oauth-errors';
import { DEFAULT_TZ } from '~/lib/tz';
import { DEFAULT_HASHTAGS } from '~/lib/default-hashtags';
import { buildSessionCookie } from '~/middleware/auth';
import { originOf } from '~/middleware/origin-check';
import {
  providerByName,
  providerCredentials,
  userIdFor,
  type ProviderConfig,
} from '~/lib/oauth-providers';
import {
  oauthStateCookieName,
  buildClearOAuthStateCookie,
} from './login';

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

/** Shape of the existing users row we consult on re-login. */
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

/** Build an HTTP 303 redirect to `/?error=<code>` on the landing page. */
function errorRedirect(
  origin: string,
  code: OAuthErrorCode,
  extraHeaders: Headers = new Headers(),
  status = 303,
  provider?: string,
): Response {
  const headers = new Headers(extraHeaders);
  const target =
    provider === undefined
      ? `${origin}/?error=${encodeURIComponent(code)}`
      : `${origin}/?error=${encodeURIComponent(code)}&provider=${encodeURIComponent(provider)}`;
  headers.set('Location', target);
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
  const safeTarget = htmlAttrEscape(target);
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign-in incomplete</title>
<meta http-equiv="refresh" content="0;url=${safeTarget}"></head>
<body><p>Sign-in did not complete. <a href="${safeTarget}">Return to the landing page</a> and try again.</p></body></html>`;
  return new Response(body, { status: 403, headers });
}

function htmlAttrEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Constant-time string comparison for the OAuth state match. Opaque
 * base64url values, byte-by-byte equality over equal-length arrays.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Exchange an authorization code for the provider's token response.
 *
 * GitHub uses JSON request body + JSON response; Google requires
 * form-urlencoded request body. Both return JSON. The token endpoint
 * is read from the provider config so adding a new OAuth2-shaped
 * provider is one entry in PROVIDERS.
 */
async function exchangeCode(
  provider: ProviderConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  if (provider.name === 'google') {
    // Google requires application/x-www-form-urlencoded.
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    const res = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`token_exchange_http_${res.status}`);
    }
    return (await res.json()) as TokenResponse;
  }
  // GitHub accepts JSON.
  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'news-digest',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`token_exchange_http_${res.status}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  const providerName = (context.params.provider ?? '') as string;
  const provider = providerByName(providerName);
  if (provider === null) {
    return new Response('not found', { status: 404 });
  }

  const creds = providerCredentials(env, provider.name);
  if (
    creds === null ||
    typeof env.OAUTH_JWT_SECRET !== 'string' ||
    env.OAUTH_JWT_SECRET === '' ||
    typeof env.APP_URL !== 'string' ||
    env.APP_URL === ''
  ) {
    return errorResponse('oauth_not_configured');
  }

  const origin = originOf(env.APP_URL);
  const url = new URL(context.request.url);
  const stateCookieName = oauthStateCookieName(provider.name);
  const clearState = buildClearOAuthStateCookie(provider.name);

  // 1. Provider-returned error (user clicked "Cancel", etc.).
  const providerError = url.searchParams.get('error');
  if (providerError !== null && providerError !== '') {
    const code = mapOAuthError(providerError);
    const headers = new Headers();
    headers.append('Set-Cookie', clearState);
    return errorRedirect(origin, code, headers, 303, provider.name);
  }

  // 2. CSRF state match against the per-provider cookie.
  const queryState = url.searchParams.get('state');
  const cookieHeader = context.request.headers.get('Cookie');
  const cookieState = readCookie(cookieHeader, stateCookieName);
  if (
    queryState === null ||
    queryState === '' ||
    cookieState === null ||
    cookieState === '' ||
    !timingSafeEqual(queryState, cookieState)
  ) {
    log('warn', 'auth.callback.invalid_state', {
      provider: provider.name,
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
    return errorRedirect(origin, 'oauth_error', headers, 303, provider.name);
  }

  // 3. Token exchange.
  const redirectUri = `${origin}/api/auth/${provider.name}/callback`;
  let tokenData: TokenResponse;
  try {
    tokenData = await exchangeCode(
      provider,
      creds.clientId,
      creds.clientSecret,
      code,
      redirectUri,
    );
    if (typeof tokenData.access_token !== 'string' || tokenData.access_token === '') {
      log('error', 'auth.callback.failed', {
        provider: provider.name,
        error_code: 'oauth_error',
        detail: String(
          `token_exchange: ${tokenData.error ?? 'unknown'} ${tokenData.error_description ?? ''}`,
        ).slice(0, 500),
      });
      const headers = new Headers();
      headers.append('Set-Cookie', clearState);
      return errorRedirect(origin, 'oauth_error', headers, 303, provider.name);
    }
  } catch (err) {
    log('error', 'auth.callback.failed', {
      provider: provider.name,
      error_code: 'oauth_error',
      detail: String(err).slice(0, 500),
    });
    const headers = new Headers();
    headers.append('Set-Cookie', clearState);
    return errorRedirect(origin, 'oauth_error', headers, 303, provider.name);
  }

  // 4. Provider-specific profile fetch.
  let profile;
  try {
    profile = await provider.fetchProfile({
      accessToken: tokenData.access_token,
      idToken:
        typeof tokenData.id_token === 'string' && tokenData.id_token !== ''
          ? tokenData.id_token
          : null,
    });
  } catch (err) {
    log('error', 'auth.callback.failed', {
      provider: provider.name,
      error_code: 'oauth_error',
      detail: String(err).slice(0, 500),
    });
    const headers = new Headers();
    headers.append('Set-Cookie', clearState);
    return errorRedirect(origin, 'oauth_error', headers, 303, provider.name);
  }

  if (profile.email === null) {
    const headers = new Headers();
    headers.append('Set-Cookie', clearState);
    return errorRedirect(origin, 'no_verified_email', headers, 303, provider.name);
  }

  // 5. Upsert users row keyed by the canonical id form.
  const userId = userIdFor(provider, profile.providerUserId);
  const displayName = profile.displayName;
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
      provider: provider.name,
      user_id: userId,
      error_code: 'oauth_error',
      detail: String(err).slice(0, 500),
    });
    const headers = new Headers();
    headers.append('Set-Cookie', clearState);
    return errorRedirect(origin, 'oauth_error', headers, 303, provider.name);
  }

  let sessionVersion: number;
  let firstRun: boolean;
  try {
    if (row === null) {
      // Schema field `gh_login` is reused for the provider's display
      // name (e.g., GitHub login or Google account name). Renaming the
      // column would be a larger migration; semantic re-use is the
      // pragmatic choice for now and is documented in
      // documentation/architecture.md.
      const defaultHashtagsJson = JSON.stringify(Array.from(DEFAULT_HASHTAGS));
      await env.DB.prepare(
        'INSERT INTO users (id, email, gh_login, tz, digest_hour, digest_minute, email_enabled, session_version, created_at, hashtags_json) VALUES (?1, ?2, ?3, ?4, 8, 0, 1, 1, ?5, ?6)',
      )
        .bind(userId, profile.email, displayName, DEFAULT_TZ, nowSec, defaultHashtagsJson)
        .run();
      sessionVersion = 1;
      firstRun = true;
    } else {
      await env.DB.prepare(
        'UPDATE users SET email = ?1, gh_login = ?2 WHERE id = ?3',
      )
        .bind(profile.email, displayName, userId)
        .run();
      sessionVersion = row.session_version;
      firstRun =
        row.digest_hour === null &&
        (row.hashtags_json === null || row.hashtags_json === '');
    }
  } catch (err) {
    log('error', 'auth.callback.failed', {
      provider: provider.name,
      user_id: userId,
      error_code: 'oauth_error',
      detail: String(err).slice(0, 500),
    });
    const headers = new Headers();
    headers.append('Set-Cookie', clearState);
    return errorRedirect(origin, 'oauth_error', headers, 303, provider.name);
  }

  // 6. Mint session JWT. The `ghl` claim name is preserved for backward
  // compatibility (existing tokens use it; rotating the claim name would
  // invalidate every active session). Its value carries the provider's
  // displayName for non-GitHub providers — semantic re-use, like the
  // `gh_login` column.
  const jwt = await signSession(
    {
      sub: userId,
      email: profile.email,
      ghl: displayName,
      sv: sessionVersion,
    },
    env.OAUTH_JWT_SECRET,
  );

  log('info', 'auth.login', {
    provider: provider.name,
    user_id: userId,
    new_user: firstRun,
    status: 'success',
  });

  // 7. Redirect.
  const headers = new Headers();
  headers.append('Set-Cookie', clearState);
  headers.append('Set-Cookie', buildSessionCookie(jwt));
  headers.set('Location', `${origin}/digest`);
  return new Response(null, { status: 303, headers });
}
