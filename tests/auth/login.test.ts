// Tests for src/pages/api/auth/github/login.ts — REQ-AUTH-001 (initiate
// GitHub OAuth with a cryptographically random state cookie).

import { describe, it, expect, vi } from 'vitest';
import {
  GET,
  POST,
  generateOAuthState,
  buildAuthorizeUrl,
  buildOAuthStateCookie,
  buildClearOAuthStateCookie,
  OAUTH_STATE_COOKIE_NAME,
} from '~/pages/api/auth/github/login';

/** Collect every Set-Cookie value from a Response. Prefers the
 * `getSetCookie()` extension when the runtime exposes it. */
function setCookiesOf(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const raw = h.get('Set-Cookie');
  return raw === null ? [] : [raw];
}

function makeContext(env: Partial<Env>): unknown {
  return {
    request: new Request('https://news-digest.example.com/api/auth/github/login'),
    locals: { runtime: { env: env as Env } },
    url: new URL('https://news-digest.example.com/api/auth/github/login'),
  };
}

function fullEnv(): Partial<Env> {
  return {
    OAUTH_CLIENT_ID: 'client123',
    OAUTH_CLIENT_SECRET: 'secret456',
    OAUTH_JWT_SECRET: 'jwt-secret-minimum-length-for-hmac',
    APP_URL: 'https://news-digest.example.com',
  };
}

describe('generateOAuthState', () => {
  it('REQ-AUTH-001: produces a 32-byte value encoded as base64url', () => {
    const state = generateOAuthState();
    // 32 bytes as base64url = 43 chars (no padding).
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
  it('REQ-AUTH-001: constructs the GitHub authorize URL with scope=user:email and state', () => {
    const url = buildAuthorizeUrl(
      'client123',
      'https://news-digest.example.com/api/auth/github/callback',
      'opaque-state',
    );
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://github.com');
    expect(parsed.pathname).toBe('/login/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('client123');
    expect(parsed.searchParams.get('scope')).toBe('user:email');
    expect(parsed.searchParams.get('state')).toBe('opaque-state');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://news-digest.example.com/api/auth/github/callback',
    );
  });
});

describe('buildOAuthStateCookie / buildClearOAuthStateCookie', () => {
  it('REQ-AUTH-001: state cookie is HttpOnly, Secure, SameSite=Lax, Path=/api/auth/github/, Max-Age=600', () => {
    const c = buildOAuthStateCookie('xyz');
    expect(c).toContain(`${OAUTH_STATE_COOKIE_NAME}=xyz`);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/api/auth/github/');
    expect(c).toContain('Max-Age=600');
  });

  it('REQ-AUTH-001: clearing cookie matches Path and uses Max-Age=0', () => {
    const c = buildClearOAuthStateCookie();
    expect(c).toContain(`${OAUTH_STATE_COOKIE_NAME}=;`);
    expect(c).toContain('Path=/api/auth/github/');
    expect(c).toContain('Max-Age=0');
  });
});

describe('GET /api/auth/github/login', () => {
  it('REQ-AUTH-001: returns 500 when OAuth env vars are missing', async () => {
    const ctx = makeContext({ APP_URL: 'https://news-digest.example.com' });
    const res = await GET(ctx as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'oauth_not_configured' });
  });

  it('REQ-AUTH-001: redirects to github.com/login/oauth/authorize with scope=user:email', async () => {
    const ctx = makeContext(fullEnv());
    const res = await GET(ctx as never);
    expect(res.status).toBe(303);
    const location = res.headers.get('Location');
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('user:email');
    expect(url.searchParams.get('client_id')).toBe('client123');
  });

  it('REQ-AUTH-001: sets a state cookie matching the state query param', async () => {
    const ctx = makeContext(fullEnv());
    const res = await GET(ctx as never);
    const location = new URL(res.headers.get('Location')!);
    const state = location.searchParams.get('state');
    expect(state).not.toBeNull();
    expect(state!).toHaveLength(43);

    const setCookies = setCookiesOf(res);
    const stateCookie = setCookies.find((c) => c.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`));
    expect(stateCookie).toBeDefined();
    expect(stateCookie).toContain(`${OAUTH_STATE_COOKIE_NAME}=${state}`);
    expect(stateCookie).toContain('HttpOnly');
    expect(stateCookie).toContain('Secure');
  });

  it('REQ-AUTH-001: redirect URI points at the callback on the configured APP_URL origin', async () => {
    const ctx = makeContext({
      ...fullEnv(),
      APP_URL: 'https://news-digest.example.com/some/path',
    });
    const res = await GET(ctx as never);
    const url = new URL(res.headers.get('Location')!);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://news-digest.example.com/api/auth/github/callback',
    );
  });

  it('REQ-AUTH-001: generates a fresh state on each call (no reuse)', async () => {
    const ctx = makeContext(fullEnv());
    const first = await GET(ctx as never);
    const second = await GET(ctx as never);
    const s1 = new URL(first.headers.get('Location')!).searchParams.get('state');
    const s2 = new URL(second.headers.get('Location')!).searchParams.get('state');
    expect(s1).not.toBe(s2);
  });
});

describe('POST /api/auth/github/login', () => {
  it('REQ-AUTH-001: POST is accepted (landing form path) and behaves identically to GET', async () => {
    // POST is the canonical entry point used by the landing form — avoids
    // mobile-browser prefetch of a GET anchor regenerating the state cookie
    // in a race with GitHub's callback.
    const ctx = makeContext(fullEnv());
    const res = await POST(ctx as never);
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('Location')!);
    expect(location.origin).toBe('https://github.com');
    expect(location.searchParams.get('scope')).toBe('user:email');
    const setCookies = setCookiesOf(res);
    const stateCookie = setCookies.find((c) => c.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`));
    expect(stateCookie).toBeDefined();
  });
});
