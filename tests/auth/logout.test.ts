// Tests for src/pages/api/auth/logout.ts — REQ-AUTH-002 (logout bumps
// session_version, clears cookie), REQ-AUTH-003 (POST requires
// matching Origin). Provider-agnostic — same handler logs every user
// out regardless of which provider issued the session.

import { describe, it, expect, vi } from 'vitest';
import { POST } from '~/pages/api/auth/logout';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';
import { signSession } from '~/lib/session-jwt';

/** Collect every Set-Cookie value from a Response. */
function setCookiesOf(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const raw = h.get('Set-Cookie');
  return raw === null ? [] : [raw];
}

const JWT_SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';
const APP_URL = 'https://news-digest.example.com';
const APP_ORIGIN = 'https://news-digest.example.com';

function makeDb(): {
  db: D1Database;
  runCalls: { sql: string; params: unknown[] }[];
} {
  const runCalls: { sql: string; params: unknown[] }[] = [];
  const prepareSpy = vi.fn().mockImplementation((sql: string) => ({
    bind: (...params: unknown[]) => ({
      run: vi.fn().mockImplementation(async () => {
        runCalls.push({ sql, params });
        return { success: true, meta: { changes: 1 } };
      }),
    }),
  }));
  const db = { prepare: prepareSpy } as unknown as D1Database;
  return { db, runCalls };
}

/** In-memory KV stub for the rate-limit helper. The store is exposed so
 *  tests that exercise the limiter can pre-load a counter (or assert
 *  what was written). */
function makeKv(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    get: vi.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
    put: vi.fn().mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
  } as unknown as KVNamespace;
  return { kv, store };
}

function env(db: D1Database, kv?: KVNamespace): Partial<Env> {
  return {
    APP_URL,
    OAUTH_JWT_SECRET: JWT_SECRET,
    DB: db,
    KV: kv ?? makeKv().kv,
  };
}

function makeContext(request: Request, e: Partial<Env>): unknown {
  return {
    request,
    locals: { runtime: { env: e as Env } },
    url: new URL(request.url),
  };
}

async function logoutRequest(
  options: { origin?: string | null; cookie?: string | null } = {},
): Promise<Request> {
  const headers = new Headers();
  if (options.origin !== null && options.origin !== undefined) {
    headers.set('Origin', options.origin);
  }
  if (options.cookie !== null && options.cookie !== undefined) {
    headers.set('Cookie', options.cookie);
  }
  return new Request(`${APP_URL}/api/auth/logout`, {
    method: 'POST',
    headers,
  });
}

describe('POST /api/auth/logout', () => {
  it('REQ-AUTH-003: rejects POST with missing Origin header', async () => {
    const { db } = makeDb();
    const req = await logoutRequest({ origin: null });
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'forbidden_origin' });
  });

  it('REQ-AUTH-003: rejects POST with cross-site Origin', async () => {
    const { db } = makeDb();
    const req = await logoutRequest({ origin: 'https://evil.com' });
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(403);
  });

  it('REQ-AUTH-002: bumps users.session_version for the logged-in user', async () => {
    const token = await signSession(
      { sub: '12345', email: 'alice@example.com', ghl: 'alice', sv: 4 },
      JWT_SECRET,
    );
    const { db, runCalls } = makeDb();
    const req = await logoutRequest({
      origin: APP_ORIGIN,
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
    });
    await POST(makeContext(req, env(db)) as never);
    const update = runCalls.find((c) => c.sql.includes('session_version = session_version + 1'));
    expect(update).toBeDefined();
    expect(update!.params[0]).toBe('12345');
  });

  it('REQ-AUTH-002: clears the session cookie via Max-Age=0', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      JWT_SECRET,
    );
    const { db } = makeDb();
    const req = await logoutRequest({
      origin: APP_ORIGIN,
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
    });
    const res = await POST(makeContext(req, env(db)) as never);
    const clearCookie = setCookiesOf(res).find(
      (c) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && c.includes('Max-Age=0'),
    );
    expect(clearCookie).toBeDefined();
  });

  it('REQ-AUTH-002: redirects to /?logged_out=1', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      JWT_SECRET,
    );
    const { db } = makeDb();
    const req = await logoutRequest({
      origin: APP_ORIGIN,
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
    });
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${APP_ORIGIN}/?logged_out=1`);
  });

  it('REQ-AUTH-002: succeeds even without a valid session cookie (idempotent logout)', async () => {
    const { db, runCalls } = makeDb();
    const req = await logoutRequest({ origin: APP_ORIGIN, cookie: null });
    const res = await POST(makeContext(req, env(db)) as never);
    // No DB update — there's no user to invalidate.
    expect(runCalls.length).toBe(0);
    // But we still clear the cookie and redirect.
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${APP_ORIGIN}/?logged_out=1`);
  });

  it('REQ-AUTH-002: silently ignores an invalid/expired JWT (no DB update, cookie cleared)', async () => {
    const { db, runCalls } = makeDb();
    const req = await logoutRequest({
      origin: APP_ORIGIN,
      cookie: `${SESSION_COOKIE_NAME}=not.a.valid.jwt`,
    });
    const res = await POST(makeContext(req, env(db)) as never);
    expect(runCalls.length).toBe(0);
    expect(res.status).toBe(303);
  });

  it('REQ-AUTH-001 AC 9 / REQ-AUTH-002: returns 429 with Retry-After when AUTH_LOGOUT bucket is exhausted', async () => {
    // AC 9 — bound logout per IP. Practical blast radius is small
    // (logout requires a live cookie), but a low ceiling prevents an
    // attacker from loop-incrementing session_version on a known user.
    // The 5/min/IP rule fires BEFORE any DB lookup, so we don't even
    // need a valid session cookie to trigger it — pre-load the KV
    // counter to the ceiling and assert the next call short-circuits.
    const { db } = makeDb();
    const { kv, store } = makeKv();
    const ip = '203.0.113.42';
    const nowSec = Math.floor(Date.now() / 1000);
    const windowSec = 60;
    const windowIndex = Math.floor(nowSec / windowSec);
    store.set(`ratelimit:auth_logout:ip:${ip}:${windowIndex}`, '5');

    const headers = new Headers({ Origin: APP_ORIGIN, 'CF-Connecting-IP': ip });
    const req = new Request(`${APP_URL}/api/auth/logout`, {
      method: 'POST',
      headers,
    });
    const res = await POST(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).not.toBeNull();
  });
});
