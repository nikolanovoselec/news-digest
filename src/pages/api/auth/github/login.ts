// Implements REQ-AUTH-001
//
// GET /api/auth/github/login — initiate the GitHub OAuth authorization
// code flow. Generates a cryptographically random `state` value (32
// random bytes, base64url) and stores it in a short-lived cookie that
// the callback compares against the query param. Redirects to GitHub's
// authorize endpoint with `scope=user:email` (AC 2).
//
// The state cookie is scoped to /api/auth/github/ to keep it off every
// other route. It is deliberately NOT `__Host-` prefixed — it does not
// hold an identity claim, and the Path= attribute the prefix forbids is
// the whole point of keeping the cookie narrow. 10-minute Max-Age is
// long enough for the user to complete GitHub's consent screen.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { originOf } from '~/middleware/origin-check';

export const OAUTH_STATE_COOKIE_NAME = 'news_digest_oauth_state';
const OAUTH_STATE_TTL_SECONDS = 600; // 10 minutes
const OAUTH_STATE_PATH = '/api/auth/github/';
const OAUTH_STATE_COOKIE_ATTRS = `HttpOnly; Secure; SameSite=Lax; Path=${OAUTH_STATE_PATH}; Max-Age=${OAUTH_STATE_TTL_SECONDS}`;

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
export function buildOAuthStateCookie(state: string): string {
  return `${OAUTH_STATE_COOKIE_NAME}=${state}; ${OAUTH_STATE_COOKIE_ATTRS}`;
}

/**
 * Build the clear-cookie header for the OAuth state cookie. The Path
 * must match the set path or the browser will not evict the cookie.
 */
export function buildClearOAuthStateCookie(): string {
  return `${OAUTH_STATE_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=${OAUTH_STATE_PATH}; Max-Age=0`;
}

/**
 * Construct the GitHub authorize URL with the given client id, redirect
 * URI, and opaque state. Kept out of the handler so tests can assert
 * the composed URL deterministically.
 */
export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'user:email',
    state,
    allow_signup: 'true',
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * Shared handler used by both POST (the canonical path, triggered by a
 * form submission from the landing page) and GET (kept for
 * backwards-compatibility and test tooling). Issues a fresh state cookie
 * and redirects the browser to GitHub's authorize endpoint.
 */
async function startOAuth(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  const clientId = env.OAUTH_CLIENT_ID;
  const appUrl = env.APP_URL;
  if (
    typeof clientId !== 'string' ||
    clientId === '' ||
    typeof env.OAUTH_CLIENT_SECRET !== 'string' ||
    env.OAUTH_CLIENT_SECRET === '' ||
    typeof env.OAUTH_JWT_SECRET !== 'string' ||
    env.OAUTH_JWT_SECRET === '' ||
    typeof appUrl !== 'string' ||
    appUrl === ''
  ) {
    return errorResponse('oauth_not_configured');
  }

  const origin = originOf(appUrl);
  const state = generateOAuthState();
  const redirectUri = `${origin}/api/auth/github/callback`;
  const authorizeUrl = buildAuthorizeUrl(clientId, redirectUri, state);

  const headers = new Headers();
  headers.append('Set-Cookie', buildOAuthStateCookie(state));
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
 * matches what GitHub returns in the callback query.
 *
 * Per REQ-AUTH-003 AC 4 this endpoint is exempt from the Origin check:
 * it does not act on an authenticated session — its only effect is
 * setting a short-lived opaque state cookie and returning a 303 redirect
 * to GitHub. Login-CSRF is mitigated by GitHub's consent screen, which
 * an attacker cannot bypass.
 */
export const POST = startOAuth;

/**
 * GET is retained for direct URL access (bookmarks, typed URLs, tests)
 * and is exempt from the Origin check per REQ-AUTH-003 AC 3. Prefetch-
 * induced state regeneration is a real risk on this path; the landing
 * page uses POST to sidestep it entirely.
 */
export const GET = startOAuth;
