// Implements REQ-AUTH-001
//
// GET/POST /api/auth/<provider>/login — initiate the OAuth/OIDC
// authorization-code flow for any configured provider. The dynamic
// `[provider]` segment maps to entries in `~/lib/oauth-providers`;
// unknown names 404 before any cookie or redirect is issued.
//
// Generates a cryptographically random `state` value (32 random bytes,
// base64url) stored in a per-provider state cookie. The cookie is
// scoped to the provider's callback path so callbacks for different
// providers can run in flight concurrently without colliding on a
// single shared cookie.
//
// 10-minute Max-Age is long enough for the user to complete the
// provider's consent screen, short enough that an abandoned flow
// cannot be resurrected later. The cookie is HttpOnly + Secure +
// SameSite=Lax — it carries no identity claim so does not need
// `__Host-` prefix.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { originOf } from '~/middleware/origin-check';
import {
  providerByName,
  providerCredentials,
  type ProviderConfig,
  type ProviderName,
} from '~/lib/oauth-providers';

/** Build the state-cookie name for a given provider. Per-provider
 *  scoping (vs a single shared `oauth_state` cookie) lets a user open
 *  two providers' consent screens in parallel without one stomping on
 *  the other's CSRF nonce. */
export function oauthStateCookieName(provider: ProviderName): string {
  return `news_digest_oauth_state_${provider}`;
}

const OAUTH_STATE_TTL_SECONDS = 600; // 10 minutes

function oauthStatePath(provider: ProviderName): string {
  return `/api/auth/${provider}/`;
}

/**
 * Generate 32 random bytes and encode them as base64url. The entropy
 * is drawn from the Web Crypto API (`crypto.getRandomValues`), which on
 * Workers is backed by the Cloudflare runtime's CSPRNG.
 */
export function generateOAuthState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Build the `Set-Cookie` header value for the short-lived OAuth state
 * cookie. Exported for reuse in the callback (which clears it on
 * consumption).
 */
export function buildOAuthStateCookie(provider: ProviderName, state: string): string {
  const path = oauthStatePath(provider);
  const attrs = `HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=${OAUTH_STATE_TTL_SECONDS}`;
  return `${oauthStateCookieName(provider)}=${state}; ${attrs}`;
}

/**
 * Build the clear-cookie header for the OAuth state cookie. The Path
 * must match the set path or the browser will not evict the cookie.
 */
export function buildClearOAuthStateCookie(provider: ProviderName): string {
  const path = oauthStatePath(provider);
  return `${oauthStateCookieName(provider)}=; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=0`;
}

/**
 * Construct a provider's authorize URL with the given client id,
 * redirect URI, and opaque state. Provider-specific extras are added
 * here:
 *   - GitHub gets `allow_signup=true` so the user can complete sign-up
 *     inside the consent screen if they don't have an account yet.
 *   - Google gets `prompt=select_account` so a browser logged into
 *     multiple Google accounts surfaces the picker rather than silently
 *     using the most-recent one, plus `response_type=code` (Google
 *     requires it explicitly even though it's the OAuth default).
 */
export function buildAuthorizeUrl(
  provider: ProviderConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: provider.scope,
    state,
  });
  if (provider.name === 'github') {
    params.set('allow_signup', 'true');
  } else if (provider.name === 'google') {
    params.set('response_type', 'code');
    params.set('prompt', 'select_account');
    params.set('access_type', 'online');
  }
  return `${provider.authorizeUrl}?${params.toString()}`;
}

/**
 * Shared handler used by both POST (the canonical path, triggered by a
 * form submission from the landing page) and GET (kept for
 * backwards-compatibility and test tooling). Issues a fresh state cookie
 * and redirects the browser to the provider's authorize endpoint.
 *
 * Unknown provider names → 404. Configured-but-no-creds providers →
 * `oauth_not_configured`. The configured-providers landing page should
 * never trigger that branch in practice but it guards against a
 * misconfigured fork pointing at a partially-configured provider.
 */
async function startOAuth(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  const providerName = (context.params.provider ?? '') as string;
  const provider = providerByName(providerName);
  if (provider === null) {
    return new Response('not found', { status: 404 });
  }

  const creds = providerCredentials(env, provider.name);
  const appUrl = env.APP_URL;
  if (
    creds === null ||
    typeof env.OAUTH_JWT_SECRET !== 'string' ||
    env.OAUTH_JWT_SECRET === '' ||
    typeof appUrl !== 'string' ||
    appUrl === ''
  ) {
    return errorResponse('oauth_not_configured');
  }

  const origin = originOf(appUrl);
  const state = generateOAuthState();
  const redirectUri = `${origin}/api/auth/${provider.name}/callback`;
  const authorizeUrl = buildAuthorizeUrl(provider, creds.clientId, redirectUri, state);

  const headers = new Headers();
  headers.append('Set-Cookie', buildOAuthStateCookie(provider.name, state));
  headers.set('Location', authorizeUrl);
  // 303 See Other — the browser follows with a GET regardless of the
  // original method, which matches the OAuth redirect contract.
  return new Response(null, { status: 303, headers });
}

/**
 * POST is the canonical entry point. The landing page submits a
 * same-origin form to this endpoint, which avoids the mobile-browser
 * prefetch race where prefetch of a GET link regenerates the state
 * cookie multiple times and leaves a cookie value that no longer
 * matches what the provider returns in the callback query.
 *
 * Per REQ-AUTH-003 AC 4 this endpoint is exempt from the Origin check:
 * it does not act on an authenticated session — its only effect is
 * setting a short-lived opaque state cookie and returning a 303
 * redirect to the provider. Login-CSRF is mitigated by the provider's
 * consent screen, which an attacker cannot bypass.
 */
export const POST = startOAuth;

/**
 * GET is retained for direct URL access (bookmarks, typed URLs, tests)
 * and is exempt from the Origin check per REQ-AUTH-003 AC 3. Prefetch-
 * induced state regeneration is a real risk on this path; the landing
 * page uses POST to sidestep it entirely.
 */
export const GET = startOAuth;
