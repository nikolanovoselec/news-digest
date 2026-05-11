// Implements REQ-AUTH-001, REQ-AUTH-002, REQ-AUTH-004, REQ-AUTH-007, REQ-AUTH-008
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
import { escapeHtml } from '~/lib/email-html';
import { signSession } from '~/lib/session-jwt';
import { mapOAuthError, type OAuthErrorCode } from '~/lib/oauth-errors';
import { DEFAULT_HASHTAGS } from '~/lib/default-hashtags';
import { buildSessionCookie } from '~/middleware/auth';
import {
  buildRefreshCookie,
  issueRefreshToken,
} from '~/lib/refresh-tokens';
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
import { readCookie, constantTimeEq } from '~/lib/crypto';
import { enforceRateLimit, rateLimitResponse, clientIp, RATE_LIMIT_RULES } from '~/lib/rate-limit';

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

// CF-028: ExistingUserRow shared via auth-types.ts so the callback and
// the auth middleware stay in sync when the users SELECT changes.
import { type ExistingUserRow } from '~/lib/auth-types';

// `readCookie` is imported from `~/lib/crypto` (CF-005 — was duplicated
// here, in `auth/logout.ts`, and in `middleware/auth.ts`).

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
 * CF-025 — shared helper that logs an auth.callback.failed event, clears
 * the OAuth state cookie, and issues a 303 redirect to the error landing
 * page. Replaces 6 near-identical blocks in the callback handler.
 *
 * @param origin     The request origin (scheme + host) for the redirect target.
 * @param code       The sanitised {@link OAuthErrorCode} to surface in `?error=`.
 * @param clearState The `Set-Cookie` string that clears the state cookie.
 * @param provider   The provider name appended as `?provider=` for UI messaging.
 * @param debugCtx   Fields merged into the log record (never surfaced to users).
 */
function respondError(
  origin: string,
  code: OAuthErrorCode,
  clearState: string,
  provider: string,
  debugCtx: Record<string, unknown>,
): Response {
  log('error', 'auth.callback.failed', {
    provider,
    error_code: code,
    ...debugCtx,
  });
  const headers = new Headers();
  headers.append('Set-Cookie', clearState);
  return errorRedirect(origin, code, headers, 303, provider);
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
  const safeTarget = escapeHtml(target);
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign-in incomplete</title>
<meta http-equiv="refresh" content="0;url=${safeTarget}"></head>
<body><p>Sign-in did not complete. <a href="${safeTarget}">Return to the landing page</a> and try again.</p></body></html>`;
  return new Response(body, { status: 403, headers });
}

// CF-032: htmlAttrEscape removed — replaced by the project's shared
// `escapeHtml` from `~/lib/email-html`, which covers the same five
// special characters and is already used by the email renderer.

// CSRF state byte-equality uses `constantTimeEq` from `~/lib/crypto`
// (CF-011 — previously used `verifyHmacSignature` against the cookie
// value, but the cookie is set by the worker itself, so plain constant-
// time byte equality is the right primitive). `verifyHmacSignature` is
// still the correct helper when comparing against an HMAC-signed input
// (dev-bypass tokens in dev/login.ts and dev/trigger-scrape.ts).

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

/**
 * CF-011 — step-pipeline result type. Each numbered step in the GET
 * handler either yields a {@link NextState} that the next step consumes
 * (`kind: 'next'`) or short-circuits the request with an early
 * `Response` (`kind: 'respond'`). The handler chains step results with
 * a single `if (result.kind === 'respond') return result.response;` line
 * between calls.
 */
type StepResult<T> =
  | { kind: 'next'; value: T }
  | { kind: 'respond'; response: Response };

/** Per-step state carried forward through the pipeline. Each step adds
 *  the field(s) it produces; later steps consume earlier fields. */
interface CallbackEnv {
  env: Env;
  provider: ProviderConfig;
  creds: { clientId: string; clientSecret: string };
  origin: string;
  clearState: string;
}

interface ResolvedState extends CallbackEnv {
  url: URL;
}

interface ProfileState extends ResolvedState {
  profile: {
    providerUserId: string;
    email: string;
    displayName: string;
  };
  nowSec: number;
}

interface UserResolvedState extends ProfileState {
  userId: string;
  row: ExistingUserRow | null;
}

interface UpsertedState extends UserResolvedState {
  sessionVersion: number;
  firstRun: boolean;
}

/**
 * Step 1 — provider lookup + config check + rate limit. Pulls the
 * provider config and credentials, validates env vars, and applies
 * AUTH_CALLBACK rate limiting. Short-circuits with 404, the
 * `oauth_not_configured` 4xx, or a 429.
 */
async function step1ResolveProviderAndRateLimit(
  context: APIContext,
): Promise<StepResult<CallbackEnv>> {
  const env = context.locals.runtime.env;
  const providerName = (context.params.provider ?? '') as string;
  const provider = providerByName(providerName);
  if (provider === null) {
    return { kind: 'respond', response: new Response('not found', { status: 404 }) };
  }

  const creds = providerCredentials(env, provider.name);
  if (
    creds === null ||
    typeof env.OAUTH_JWT_SECRET !== 'string' ||
    env.OAUTH_JWT_SECRET === '' ||
    typeof env.APP_URL !== 'string' ||
    env.APP_URL === ''
  ) {
    return { kind: 'respond', response: errorResponse('oauth_not_configured') };
  }

  // CF-028 — application-layer rate limit on the OAuth callback so a
  // misconfigured Access rule or `*.workers.dev` exposure cannot be
  // abused as a free OAuth token-exchange call.
  const rateResult = await enforceRateLimit(
    env,
    RATE_LIMIT_RULES.AUTH_CALLBACK,
    `ip:${clientIp(context.request)}`,
  );
  if (!rateResult.ok) {
    return { kind: 'respond', response: rateLimitResponse(rateResult.retryAfter) };
  }

  return {
    kind: 'next',
    value: {
      env,
      provider,
      creds,
      origin: originOf(env.APP_URL),
      clearState: buildClearOAuthStateCookie(provider.name),
    },
  };
}

/**
 * Step 2 — provider-returned error (user clicked "Cancel", etc.) short-
 * circuits with a 303 to the landing page; otherwise produces the URL
 * for the next step. The state cookie is cleared on the error path.
 */
function step2HandleProviderError(
  context: APIContext,
  state: CallbackEnv,
): StepResult<ResolvedState> {
  const url = new URL(context.request.url);
  const providerError = url.searchParams.get('error');
  if (providerError !== null && providerError !== '') {
    const code = mapOAuthError(providerError);
    const headers = new Headers();
    headers.append('Set-Cookie', state.clearState);
    return {
      kind: 'respond',
      response: errorRedirect(state.origin, code, headers, 303, state.provider.name),
    };
  }
  return { kind: 'next', value: { ...state, url } };
}

/**
 * Step 3 — CSRF state match against the per-provider cookie (REQ-AUTH-001
 * AC 3). Uses constant-time byte equality. On mismatch returns a 403
 * with the state cookie cleared.
 */
function step3VerifyCsrfState(
  context: APIContext,
  state: ResolvedState,
): StepResult<ResolvedState> {
  const stateCookieName = oauthStateCookieName(state.provider.name);
  const queryState = state.url.searchParams.get('state');
  const cookieHeader = context.request.headers.get('Cookie');
  const cookieState = readCookie(cookieHeader, stateCookieName);
  const statesMatch =
    queryState !== null &&
    queryState !== '' &&
    cookieState !== null &&
    cookieState !== '' &&
    constantTimeEq(cookieState, queryState);
  if (!statesMatch) {
    log('warn', 'auth.callback.invalid_state', {
      provider: state.provider.name,
      query_state_present: queryState !== null && queryState !== '',
      cookie_state_present: cookieState !== null && cookieState !== '',
      cookie_header_present: cookieHeader !== null,
      // Log a count rather than the actual cookie names — anyone with
      // log access otherwise learns the exact auth-cookie inventory
      // they'd need to forge a session.
      cookie_count: cookieHeader !== null
        ? cookieHeader.split(';').filter((p) => p.trim() !== '').length
        : 0,
      states_match: false,
    });
    const headers = new Headers();
    headers.append('Set-Cookie', state.clearState);
    return {
      kind: 'respond',
      response: invalidStateResponse(state.origin, headers),
    };
  }
  return { kind: 'next', value: state };
}

/**
 * Step 4 — token exchange + profile fetch. Validates the `code` query
 * param, runs the provider's `exchangeCode` adapter, then its
 * `fetchProfile` adapter. Short-circuits with `oauth_error` (cookie
 * cleared) on any failure, or `no_verified_email` if the provider
 * refused to release a verified email.
 */
async function step4ExchangeCodeAndFetchProfile(
  state: ResolvedState,
): Promise<StepResult<ProfileState>> {
  const code = state.url.searchParams.get('code');
  if (code === null || code === '') {
    const headers = new Headers();
    headers.append('Set-Cookie', state.clearState);
    return {
      kind: 'respond',
      response: errorRedirect(state.origin, 'oauth_error', headers, 303, state.provider.name),
    };
  }

  const redirectUri = `${state.origin}/api/auth/${state.provider.name}/callback`;
  let tokenData: TokenResponse;
  try {
    tokenData = await exchangeCode(
      state.provider,
      state.creds.clientId,
      state.creds.clientSecret,
      code,
      redirectUri,
    );
    if (typeof tokenData.access_token !== 'string' || tokenData.access_token === '') {
      return {
        kind: 'respond',
        response: respondError(state.origin, 'oauth_error', state.clearState, state.provider.name, {
          detail: String(
            `token_exchange: ${tokenData.error ?? 'unknown'} ${tokenData.error_description ?? ''}`,
          ).slice(0, 500),
        }),
      };
    }
  } catch (err) {
    return {
      kind: 'respond',
      response: respondError(state.origin, 'oauth_error', state.clearState, state.provider.name, {
        detail: String(err).slice(0, 500),
      }),
    };
  }

  let profile;
  try {
    profile = await state.provider.fetchProfile({
      accessToken: tokenData.access_token,
      idToken:
        typeof tokenData.id_token === 'string' && tokenData.id_token !== ''
          ? tokenData.id_token
          : null,
      clientId: state.creds.clientId,
    });
  } catch (err) {
    return {
      kind: 'respond',
      response: respondError(state.origin, 'oauth_error', state.clearState, state.provider.name, {
        detail: String(err).slice(0, 500),
      }),
    };
  }

  if (profile.email === null) {
    const headers = new Headers();
    headers.append('Set-Cookie', state.clearState);
    return {
      kind: 'respond',
      response: errorRedirect(state.origin, 'no_verified_email', headers, 303, state.provider.name),
    };
  }

  return {
    kind: 'next',
    value: {
      ...state,
      profile: {
        providerUserId: profile.providerUserId,
        email: profile.email,
        displayName: profile.displayName,
      },
      nowSec: Math.floor(Date.now() / 1000),
    },
  };
}

/**
 * Step 5 — resolve `userId` via auth_links (REQ-AUTH-007). Three paths:
 *  A. (provider, sub) already linked → reuse the linked user_id.
 *  B. Not linked but a `users` row with the same verified email exists
 *     → link the new (provider, sub) to that existing user_id.
 *  C. Neither matches → fresh-user fallback id `<provider>:<sub>` (or
 *     bare numeric for GitHub legacy).
 *
 * On a DB error returns `oauth_error` with the state cookie cleared.
 */
async function step5ResolveUserId(
  state: ProfileState,
): Promise<StepResult<UserResolvedState>> {
  interface AuthLinkRow {
    user_id: string;
  }
  interface UserByEmailRow {
    id: string;
  }

  const fallbackUserId = userIdFor(state.provider, state.profile.providerUserId);
  let userId: string;
  let row: ExistingUserRow | null;
  try {
    const linked = await state.env.DB
      .prepare('SELECT user_id FROM auth_links WHERE provider = ?1 AND provider_sub = ?2')
      .bind(state.provider.name, state.profile.providerUserId)
      .first<AuthLinkRow>();

    if (linked !== null) {
      // Path A: link known. Use the user_id it points at.
      userId = linked.user_id;
    } else {
      // Path B: no link yet. Check whether another provider already
      // claimed this email — if so, attach the new alias rather than
      // forking a new user.
      // Exclude both sentinel rows: __system__ (REQ-DISC-003 self-healing
      // queue) and __e2e__ (the synthetic e2e-test sandbox). A real OAuth
      // user whose verified email collides with either sentinel must
      // never be merged into a sandbox row.
      const byEmail = await state.env.DB
        .prepare(
          "SELECT id FROM users WHERE email = ?1 AND id NOT IN ('__system__', '__e2e__') ORDER BY created_at ASC LIMIT 1",
        )
        .bind(state.profile.email)
        .first<UserByEmailRow>();

      if (byEmail !== null) {
        userId = byEmail.id;
        await state.env.DB
          .prepare(
            'INSERT OR IGNORE INTO auth_links (provider, provider_sub, user_id, linked_at) VALUES (?1, ?2, ?3, ?4)',
          )
          .bind(state.provider.name, state.profile.providerUserId, userId, state.nowSec)
          .run();
        log('info', 'auth.login', {
          provider: state.provider.name,
          user_id: userId,
          status: 'linked_to_existing_email',
        });
      } else {
        // Path C: brand-new user.
        userId = fallbackUserId;
      }
    }

    row = await state.env.DB
      .prepare(
        'SELECT id, tz, session_version, digest_hour, hashtags_json FROM users WHERE id = ?1',
      )
      .bind(userId)
      .first<ExistingUserRow>();
  } catch (err) {
    return {
      kind: 'respond',
      response: respondError(state.origin, 'oauth_error', state.clearState, state.provider.name, {
        user_id: fallbackUserId,
        detail: String(err).slice(0, 500),
      }),
    };
  }

  return { kind: 'next', value: { ...state, userId, row } };
}

/**
 * Step 6 — insert (new user) or update (existing user) the users row
 * and pair a fresh auth_links alias for first-time logins. Returns the
 * `sessionVersion` to mint into the JWT and a `firstRun` flag the final
 * step uses for logging. DB errors return `oauth_error` with the state
 * cookie cleared.
 */
async function step6UpsertUserRow(
  state: UserResolvedState,
): Promise<StepResult<UpsertedState>> {
  let sessionVersion: number;
  let firstRun: boolean;
  try {
    if (state.row === null) {
      // Schema field `gh_login` is reused for the provider's display
      // name (e.g., GitHub login or Google account name). Renaming the
      // column would be a larger migration; semantic re-use is the
      // pragmatic choice for now and is documented in
      // documentation/architecture.md.
      const defaultHashtagsJson = JSON.stringify(Array.from(DEFAULT_HASHTAGS));
      // REQ-SET-007 — seed `tz` as empty so the silent auto-correct can
      // distinguish "never explicitly set" (silent path may overwrite)
      // from "user picked this" (silent path must respect). DEFAULT_TZ
      // (`'UTC'`) is the UI fallback used by /settings when reading an
      // empty stored value, NOT the seed value.
      await state.env.DB.prepare(
        'INSERT INTO users (id, email, gh_login, tz, digest_hour, digest_minute, email_enabled, session_version, created_at, hashtags_json) VALUES (?1, ?2, ?3, ?4, 8, 0, 1, 1, ?5, ?6)',
      )
        .bind(state.userId, state.profile.email, state.profile.displayName, '', state.nowSec, defaultHashtagsJson)
        .run();
      // Pair the new users row with its first auth_links alias so
      // subsequent logins resolve via path A.
      await state.env.DB.prepare(
        'INSERT OR IGNORE INTO auth_links (provider, provider_sub, user_id, linked_at) VALUES (?1, ?2, ?3, ?4)',
      )
        .bind(state.provider.name, state.profile.providerUserId, state.userId, state.nowSec)
        .run();
      sessionVersion = 1;
      firstRun = true;
    } else {
      await state.env.DB.prepare(
        'UPDATE users SET email = ?1, gh_login = ?2 WHERE id = ?3',
      )
        .bind(state.profile.email, state.profile.displayName, state.userId)
        .run();
      sessionVersion = state.row.session_version;
      firstRun =
        state.row.digest_hour === null &&
        (state.row.hashtags_json === null || state.row.hashtags_json === '');
    }
  } catch (err) {
    return {
      kind: 'respond',
      response: respondError(state.origin, 'oauth_error', state.clearState, state.provider.name, {
        user_id: state.userId,
        detail: String(err).slice(0, 500),
      }),
    };
  }
  return { kind: 'next', value: { ...state, sessionVersion, firstRun } };
}

/**
 * Step 7 — mint the session JWT, issue a refresh token row, and emit
 * the final 303 redirect to /digest with all three Set-Cookie strings
 * (state-clear, access JWT, refresh value). Refresh-token issuance is
 * best-effort — a failure logs `auth.callback.failed` but still serves
 * the 5-min access JWT so the user is not locked out.
 */
async function step7MintTokensAndRedirect(
  context: APIContext,
  state: UpsertedState,
): Promise<Response> {
  // The `ghl` claim name is preserved for backward compatibility
  // (existing tokens use it; rotating the claim name would invalidate
  // every active session). Its value carries the provider's
  // displayName for non-GitHub providers — semantic re-use, like the
  // `gh_login` column.
  const jwt = await signSession(
    {
      sub: state.userId,
      email: state.profile.email,
      ghl: state.profile.displayName,
      sv: state.sessionVersion,
    },
    state.env.OAUTH_JWT_SECRET,
  );

  log('info', 'auth.login', {
    provider: state.provider.name,
    user_id: state.userId,
    new_user: state.firstRun,
    status: 'success',
  });

  // REQ-AUTH-008 AC 1 — issue refresh token for this device.
  let refreshCookieValue: string;
  try {
    const issued = await issueRefreshToken(state.env.DB, state.userId, context.request, state.nowSec);
    refreshCookieValue = issued.value;
  } catch (err) {
    log('error', 'auth.callback.failed', {
      provider: state.provider.name,
      user_id: state.userId,
      error_code: 'refresh_token_issue_failed',
      detail: String(err).slice(0, 500),
    });
    // Continue without a refresh token — the user still gets the 5-min
    // access JWT, just no long-lived session. They'll be re-prompted
    // for OAuth on next visit. Failing the whole login here would lock
    // the user out entirely; partial degrade is the better choice.
    refreshCookieValue = '';
  }

  const headers = new Headers();
  headers.append('Set-Cookie', state.clearState);
  headers.append('Set-Cookie', buildSessionCookie(jwt));
  if (refreshCookieValue !== '') {
    headers.append('Set-Cookie', buildRefreshCookie(refreshCookieValue));
  }
  headers.set('Location', `${state.origin}/digest`);
  return new Response(null, { status: 303, headers });
}

export async function GET(context: APIContext): Promise<Response> {
  const r1 = await step1ResolveProviderAndRateLimit(context);
  if (r1.kind === 'respond') return r1.response;

  const r2 = step2HandleProviderError(context, r1.value);
  if (r2.kind === 'respond') return r2.response;

  const r3 = step3VerifyCsrfState(context, r2.value);
  if (r3.kind === 'respond') return r3.response;

  const r4 = await step4ExchangeCodeAndFetchProfile(r3.value);
  if (r4.kind === 'respond') return r4.response;

  const r5 = await step5ResolveUserId(r4.value);
  if (r5.kind === 'respond') return r5.response;

  const r6 = await step6UpsertUserRow(r5.value);
  if (r6.kind === 'respond') return r6.response;

  return step7MintTokensAndRedirect(context, r6.value);
}
