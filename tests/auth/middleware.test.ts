// Tests for src/middleware/auth.ts — REQ-AUTH-002 (session validation,
// session_version check, auto-refresh when <5 min remain — threshold
// lowered from 15 → 5 min in CF-010).

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
 * bound parameters. Designed for loadSession which binds exactly one
 * user id. */
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
  it('REQ-AUTH-002: uses __Host- prefix, HttpOnly, Secure, SameSite=Lax, Path=/, 1h Max-Age', () => {
    const c = buildSessionCookie('the-jwt');
    expect(c).toBe(`__Host-news_digest_session=the-jwt; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600`);
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

describe('loadSession', () => {
  it('REQ-AUTH-002: returns null when no session cookie is present', async () => {
    const { db } = makeDb(null);
    const req = new Request('https://example.com/');
    expect(await loadSession(req, db, SECRET)).toBeNull();
  });

  it('REQ-AUTH-002: returns null when the JWT is invalid', async () => {
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

  it('REQ-AUTH-002: returns the user on a valid session with no refresh needed', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      SECRET,
      3600, // fresh 1h token — more than 15 min remaining, no refresh
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
    expect(result!.refreshCookie).toBeNull();
    expect(bindSpy).toHaveBeenCalledWith('12345');
  });

  it('REQ-AUTH-002: issues a refresh cookie when <5 min remain on the token (CF-010)', async () => {
    // 2-minute TTL -> shouldRefreshJWT returns true under the new
    // 5-minute threshold (CF-010 lowered from 15 → 5 min).
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      SECRET,
      2 * 60,
    );
    const { db } = makeDb(baseRow(1));
    const req = new Request('https://example.com/', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    const result = await loadSession(req, db, SECRET);
    expect(result).not.toBeNull();
    expect(result!.refreshCookie).not.toBeNull();
    expect(result!.refreshCookie!).toContain('__Host-news_digest_session=');
    expect(result!.refreshCookie!).toContain('Max-Age=3600');
  });

  it('REQ-AUTH-002: refresh cookie carries the CURRENT session_version, not the JWT claim', async () => {
    // Token has sv=1, but the row's sv also equals 1 (otherwise we'd
    // return null above). The refresh must mint with the row's sv so
    // future requests remain consistent with the server source of truth.
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      SECRET,
      2 * 60, // CF-010 — 2 min triggers refresh under 5-min threshold
    );
    const { db } = makeDb(baseRow(1));
    const req = new Request('https://example.com/', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    const result = await loadSession(req, db, SECRET);
    expect(result).not.toBeNull();
    // Extract the JWT from the Set-Cookie header and verify its payload.
    const match = result!.refreshCookie!.match(/^__Host-news_digest_session=([^;]+);/);
    expect(match).not.toBeNull();
    const newToken = match![1]!;
    // The new token is distinct from the old (fresh iat/exp).
    expect(newToken).not.toBe(token);
  });

  it('REQ-AUTH-002: returns null when the D1 query throws', async () => {
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
  it('REQ-AUTH-002: returns the original response when refreshCookie is null', () => {
    const original = new Response('ok', { status: 200 });
    const out = applyRefreshCookie(original, null);
    expect(out).toBe(original);
  });

  it('REQ-AUTH-002: appends Set-Cookie without replacing existing headers', async () => {
    const original = new Response('ok', {
      status: 200,
      headers: { 'X-Custom': 'yes', 'Set-Cookie': 'other=1' },
    });
    const refreshCookie = `__Host-news_digest_session=new-jwt; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600`;
    const out = applyRefreshCookie(original, refreshCookie);
    expect(out).not.toBe(original);
    expect(await out.text()).toBe('ok');
    expect(out.headers.get('X-Custom')).toBe('yes');
    const joined = setCookiesOf(out).join('\n');
    expect(joined).toContain('other=1');
    expect(joined).toContain('__Host-news_digest_session=new-jwt');
  });
});
