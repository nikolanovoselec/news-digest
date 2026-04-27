// Tests for src/middleware/auth.ts — REQ-AUTH-002, REQ-AUTH-008.
//
// Covers the access-JWT-only path: valid JWT → user, no cookie churn.
// Refresh-token flow tests live in tests/auth/refresh-tokens.test.ts —
// those need a real D1 because the middleware writes to the
// `refresh_tokens` table on rotation.

import { describe, it, expect, vi } from 'vitest';
import {
  readCookie,
  buildSessionCookie,
  buildClearSessionCookie,
  loadSession,
  applyRefreshCookie,
  SESSION_COOKIE_NAME,
} from '~/middleware/auth';
import { signSession } from '~/lib/session-jwt';

/**
 * Collect every `Set-Cookie` value from a Response's headers. The
 * WHATWG Headers specification exposes `getSetCookie()` — the Workers
 * runtime and undici (Node 20+) both implement it. We prefer that path
 * and fall back to iterating `forEach` only if it's missing.
 */
function setCookiesOf(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') {
    return h.getSetCookie();
  }
  const raw = h.get('Set-Cookie');
  return raw === null ? [] : [raw];
}

const SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';

/** Construct a fake D1 whose first() returns {@link row}, recording the
 * bound parameters. Designed for the access-JWT-only path of
 * loadSession — the refresh-token branch needs a real DB. */
function makeDb(row: unknown): {
  db: D1Database;
  bindSpy: ReturnType<typeof vi.fn>;
  firstSpy: ReturnType<typeof vi.fn>;
} {
  const firstSpy = vi.fn().mockResolvedValue(row);
  const bindSpy = vi.fn().mockReturnValue({ first: firstSpy });
  const prepareSpy = vi.fn().mockReturnValue({ bind: bindSpy });
  const db = { prepare: prepareSpy } as unknown as D1Database;
  return { db, bindSpy, firstSpy };
}

function baseRow(sv: number): Record<string, unknown> {
  return {
    id: '12345',
    email: 'alice@example.com',
    gh_login: 'alice',
    tz: 'Europe/Zurich',
    digest_hour: 8,
    digest_minute: 0,
    hashtags_json: '["#ai"]',
    model_id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    email_enabled: 1,
    session_version: sv,
  };
}

describe('readCookie', () => {
  it('REQ-AUTH-002: returns the value of the named cookie', () => {
    expect(readCookie('foo=bar; baz=qux', 'baz')).toBe('qux');
  });

  it('REQ-AUTH-002: returns null for a missing header', () => {
    expect(readCookie(null, SESSION_COOKIE_NAME)).toBeNull();
  });

  it('REQ-AUTH-002: returns null for an empty header', () => {
    expect(readCookie('', SESSION_COOKIE_NAME)).toBeNull();
  });

  it('REQ-AUTH-002: returns null when the named cookie is absent', () => {
    expect(readCookie('foo=bar', SESSION_COOKIE_NAME)).toBeNull();
  });

  it('REQ-AUTH-002: reads cookies with no spaces between pairs', () => {
    expect(readCookie('a=1;b=2;c=3', 'b')).toBe('2');
  });
});

describe('buildSessionCookie', () => {
  it('REQ-AUTH-002: uses __Host- prefix, HttpOnly, Secure, SameSite=Lax, Path=/, 5min Max-Age', () => {
    const c = buildSessionCookie('the-jwt');
    expect(c).toBe(`__Host-news_digest_session=the-jwt; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300`);
  });
});

describe('buildClearSessionCookie', () => {
  it('REQ-AUTH-002: emits Max-Age=0 with matching attributes', () => {
    const c = buildClearSessionCookie();
    expect(c).toContain('__Host-news_digest_session=;');
    expect(c).toContain('Max-Age=0');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
  });
});

describe('loadSession — access-JWT path', () => {
  it('REQ-AUTH-002: returns null when no session cookie is present', async () => {
    const { db } = makeDb(null);
    const req = new Request('https://example.com/');
    expect(await loadSession(req, db, SECRET)).toBeNull();
  });

  it('REQ-AUTH-002: returns null when the JWT is invalid AND no refresh cookie present', async () => {
    const { db } = makeDb(null);
    const req = new Request('https://example.com/', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=not.a.jwt` },
    });
    expect(await loadSession(req, db, SECRET)).toBeNull();
  });

  it('REQ-AUTH-002: returns null when the user row does not exist', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      SECRET,
    );
    const { db } = makeDb(null);
    const req = new Request('https://example.com/', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    expect(await loadSession(req, db, SECRET)).toBeNull();
  });

  it('REQ-AUTH-002: returns null when session_version mismatches (instant revocation)', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      SECRET,
    );
    // Row now has sv=2 (logout bumped it) — stale token is rejected.
    const { db } = makeDb(baseRow(2));
    const req = new Request('https://example.com/', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    expect(await loadSession(req, db, SECRET)).toBeNull();
  });

  it('REQ-AUTH-002: returns the user with empty cookiesToSet on a valid access JWT', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      SECRET,
      300, // fresh 5-min token
    );
    const { db, bindSpy } = makeDb(baseRow(1));
    const req = new Request('https://example.com/', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    const result = await loadSession(req, db, SECRET);
    expect(result).not.toBeNull();
    expect(result!.user.id).toBe('12345');
    expect(result!.user.email).toBe('alice@example.com');
    expect(result!.user.gh_login).toBe('alice');
    expect(result!.user.session_version).toBe(1);
    // The access-JWT path does NOT touch the refresh cookie — empty array.
    expect(result!.cookiesToSet).toEqual([]);
    expect(bindSpy).toHaveBeenCalledWith('12345');
  });

  it('REQ-AUTH-008: returns null when the D1 user query throws', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      SECRET,
    );
    const firstSpy = vi.fn().mockRejectedValue(new Error('D1 connection lost'));
    const bindSpy = vi.fn().mockReturnValue({ first: firstSpy });
    const prepareSpy = vi.fn().mockReturnValue({ bind: bindSpy });
    const db = { prepare: prepareSpy } as unknown as D1Database;
    const req = new Request('https://example.com/', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    expect(await loadSession(req, db, SECRET)).toBeNull();
  });
});

describe('applyRefreshCookie', () => {
  it('REQ-AUTH-002: returns the original response when no cookies to set', () => {
    const original = new Response('ok', { status: 200 });
    const out = applyRefreshCookie(original, { cookiesToSet: [] });
    expect(out).toBe(original);
  });

  it('REQ-AUTH-002: returns the original response when null is passed', () => {
    const original = new Response('ok', { status: 200 });
    const out = applyRefreshCookie(original, null);
    expect(out).toBe(original);
  });

  it('REQ-AUTH-002: appends Set-Cookie without replacing existing headers', async () => {
    const original = new Response('ok', {
      status: 200,
      headers: { 'X-Custom': 'yes', 'Set-Cookie': 'other=1' },
    });
    const accessCookie = `__Host-news_digest_session=new-jwt; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300`;
    const refreshCookie = `__Host-news_digest_refresh=abc123; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
    const out = applyRefreshCookie(original, {
      cookiesToSet: [accessCookie, refreshCookie],
    });
    expect(out).not.toBe(original);
    expect(await out.text()).toBe('ok');
    expect(out.headers.get('X-Custom')).toBe('yes');
    const joined = setCookiesOf(out).join('\n');
    expect(joined).toContain('other=1');
    expect(joined).toContain('__Host-news_digest_session=new-jwt');
    expect(joined).toContain('__Host-news_digest_refresh=abc123');
  });

  it('REQ-AUTH-008: accepts a bare string array (rotated cookies)', async () => {
    const original = new Response('ok', { status: 200 });
    const out = applyRefreshCookie(original, [
      `${SESSION_COOKIE_NAME}=jwt-x; Max-Age=300`,
    ]);
    const joined = setCookiesOf(out).join('\n');
    expect(joined).toContain(`${SESSION_COOKIE_NAME}=jwt-x`);
  });
});
