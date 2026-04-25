// Tests for src/pages/api/auth/[provider]/login.ts — REQ-AUTH-001
// (initiate OAuth/OIDC for any configured provider with a
// cryptographically random per-provider state cookie).

import { describe, it, expect, vi } from 'vitest';
import {
  GET,
  POST,
  generateOAuthState,
  buildAuthorizeUrl,
  buildOAuthStateCookie,
  buildClearOAuthStateCookie,
  oauthStateCookieName,
} from '~/pages/api/auth/[provider]/login';
import { PROVIDERS } from '~/lib/oauth-providers';

/** Collect every Set-Cookie value from a Response. Prefers the
 * `getSetCookie()` extension when the runtime exposes it. */
function setCookiesOf(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const raw = h.get('Set-Cookie');
  return raw === null ? [] : [raw];
}

function makeContext(provider: string, env: Partial<Env>): unknown {
  return {
    request: new Request(`https://news-digest.example.com/api/auth/${provider}/login`),
    locals: { runtime: { env: env as Env } },
    url: new URL(`https://news-digest.example.com/api/auth/${provider}/login`),
    params: { provider },
  };
}

function githubEnv(): Partial<Env> {
  return {
    GITHUB_OAUTH_CLIENT_ID: 'gh-client-123',
    GITHUB_OAUTH_CLIENT_SECRET: 'gh-secret-456',
    OAUTH_JWT_SECRET: 'jwt-secret-minimum-length-for-hmac',
    APP_URL: 'https://news-digest.example.com',
  };
}

function googleEnv(): Partial<Env> {
  return {
    GOOGLE_OAUTH_CLIENT_ID: 'google-client-789.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret-abc',
    OAUTH_JWT_SECRET: 'jwt-secret-minimum-length-for-hmac',
    APP_URL: 'https://news-digest.example.com',
  };
}

describe('generateOAuthState', () => {
  it('REQ-AUTH-001: produces a 32-byte value encoded as base64url', () => {
    const state = generateOAuthState();
    expect(state).toHaveLength(43);
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(state).not.toContain('=');
    expect(state).not.toContain('+');
    expect(state).not.toContain('/');
  });

  it('REQ-AUTH-001: produces a distinct value on each call', () => {
    const a = generateOAuthState();
    const b = generateOAuthState();
    const c = generateOAuthState();
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('REQ-AUTH-001: sources entropy from crypto.getRandomValues', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    generateOAuthState();
    expect(spy).toHaveBeenCalled();
    const firstCallArg = spy.mock.calls[0]![0];
    expect(firstCallArg).toBeInstanceOf(Uint8Array);
    expect((firstCallArg as Uint8Array).byteLength).toBe(32);
    spy.mockRestore();
  });
});

describe('buildAuthorizeUrl', () => {
  it('REQ-AUTH-001: GitHub authorize URL — github.com/login/oauth/authorize, scope user:email, allow_signup=true', () => {
    const url = buildAuthorizeUrl(
      PROVIDERS.github,
      'gh-client-123',
      'https://news-digest.example.com/api/auth/github/callback',
      'opaque-state',
    );
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://github.com');
    expect(parsed.pathname).toBe('/login/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('gh-client-123');
    expect(parsed.searchParams.get('scope')).toBe('user:email');
    expect(parsed.searchParams.get('state')).toBe('opaque-state');
    expect(parsed.searchParams.get('allow_signup')).toBe('true');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://news-digest.example.com/api/auth/github/callback',
    );
  });

  it('REQ-AUTH-001: Google authorize URL — accounts.google.com path, OIDC openid scope, response_type=code, prompt=select_account', () => {
    const url = buildAuthorizeUrl(
      PROVIDERS.google,
      'google-client-789',
      'https://news-digest.example.com/api/auth/google/callback',
      'opaque-state',
    );
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://accounts.google.com');
    expect(parsed.pathname).toBe('/o/oauth2/v2/auth');
    expect(parsed.searchParams.get('client_id')).toBe('google-client-789');
    expect(parsed.searchParams.get('scope')).toBe('openid email profile');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('prompt')).toBe('select_account');
    expect(parsed.searchParams.get('state')).toBe('opaque-state');
  });
});

describe('buildOAuthStateCookie / buildClearOAuthStateCookie', () => {
  it('REQ-AUTH-001: per-provider cookie names so concurrent flows do not collide', () => {
    expect(oauthStateCookieName('github')).toBe('news_digest_oauth_state_github');
    expect(oauthStateCookieName('google')).toBe('news_digest_oauth_state_google');
  });

  it('REQ-AUTH-001: state cookie is HttpOnly, Secure, SameSite=Lax, Path=/api/auth/<provider>/, Max-Age=600', () => {
    const c = buildOAuthStateCookie('github', 'xyz');
    expect(c).toContain('news_digest_oauth_state_github=xyz');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/api/auth/github/');
    expect(c).toContain('Max-Age=600');
  });

  it('REQ-AUTH-001: clearing cookie matches Path and uses Max-Age=0', () => {
    const c = buildClearOAuthStateCookie('google');
    expect(c).toContain('news_digest_oauth_state_google=;');
    expect(c).toContain('Path=/api/auth/google/');
    expect(c).toContain('Max-Age=0');
  });
});

describe('GET /api/auth/[provider]/login — GitHub', () => {
  it('REQ-AUTH-001: returns 500 oauth_not_configured when the provider has no creds', async () => {
    const ctx = makeContext('github', {
      OAUTH_JWT_SECRET: 'jwt-secret-minimum-length-for-hmac',
      APP_URL: 'https://news-digest.example.com',
    });
    const res = await GET(ctx as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'oauth_not_configured' });
  });

  it('REQ-AUTH-001: returns 404 for an unknown provider name', async () => {
    const ctx = makeContext('invented-provider', githubEnv());
    const res = await GET(ctx as never);
    expect(res.status).toBe(404);
  });

  it('REQ-AUTH-001: redirects to github.com/login/oauth/authorize with the github client id', async () => {
    const ctx = makeContext('github', githubEnv());
    const res = await GET(ctx as never);
    expect(res.status).toBe(303);
    const url = new URL(res.headers.get('Location')!);
    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('gh-client-123');
    expect(url.searchParams.get('scope')).toBe('user:email');
  });

  it('REQ-AUTH-001: sets the github-scoped state cookie matching the state param', async () => {
    const ctx = makeContext('github', githubEnv());
    const res = await GET(ctx as never);
    const state = new URL(res.headers.get('Location')!).searchParams.get('state');
    expect(state).not.toBeNull();
    const setCookies = setCookiesOf(res);
    const stateCookie = setCookies.find((c) =>
      c.startsWith('news_digest_oauth_state_github='),
    );
    expect(stateCookie).toBeDefined();
    expect(stateCookie).toContain(`news_digest_oauth_state_github=${state}`);
  });

  it('REQ-AUTH-001: redirect URI is the github callback on the APP_URL origin', async () => {
    const ctx = makeContext('github', githubEnv());
    const res = await GET(ctx as never);
    const url = new URL(res.headers.get('Location')!);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://news-digest.example.com/api/auth/github/callback',
    );
  });

  it('REQ-AUTH-001: generates a fresh state on each call', async () => {
    const ctx = makeContext('github', githubEnv());
    const first = await GET(ctx as never);
    const second = await GET(ctx as never);
    const s1 = new URL(first.headers.get('Location')!).searchParams.get('state');
    const s2 = new URL(second.headers.get('Location')!).searchParams.get('state');
    expect(s1).not.toBe(s2);
  });
});

describe('GET /api/auth/[provider]/login — Google', () => {
  it('REQ-AUTH-001: redirects to accounts.google.com authorize endpoint with the google client id', async () => {
    const ctx = makeContext('google', googleEnv());
    const res = await GET(ctx as never);
    expect(res.status).toBe(303);
    const url = new URL(res.headers.get('Location')!);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.pathname).toBe('/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(
      'google-client-789.apps.googleusercontent.com',
    );
    expect(url.searchParams.get('scope')).toBe('openid email profile');
  });

  it('REQ-AUTH-001: sets the google-scoped state cookie (does not collide with github)', async () => {
    const ctx = makeContext('google', googleEnv());
    const res = await GET(ctx as never);
    const setCookies = setCookiesOf(res);
    const googleCookie = setCookies.find((c) =>
      c.startsWith('news_digest_oauth_state_google='),
    );
    expect(googleCookie).toBeDefined();
    // The github cookie must NOT be set by a google login.
    const ghCookie = setCookies.find((c) =>
      c.startsWith('news_digest_oauth_state_github='),
    );
    expect(ghCookie).toBeUndefined();
  });
});

describe('POST /api/auth/[provider]/login', () => {
  it('REQ-AUTH-001: POST is accepted and behaves identically to GET', async () => {
    const ctx = makeContext('github', githubEnv());
    const res = await POST(ctx as never);
    expect(res.status).toBe(303);
    const url = new URL(res.headers.get('Location')!);
    expect(url.origin).toBe('https://github.com');
  });
});
