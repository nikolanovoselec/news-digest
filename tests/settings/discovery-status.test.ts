// Tests for src/pages/api/discovery/status.ts — REQ-SET-006 adjacent.
// The endpoint returns the authenticated user's pending discovery tags.

import { describe, it, expect, vi } from 'vitest';
import { GET } from '~/pages/api/discovery/status';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';
import { signSession } from '~/lib/session-jwt';

const JWT_SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';
const APP_URL = 'https://news-digest.example.com';

interface UserRow {
  id: string;
  email: string;
  gh_login: string;
  tz: string;
  digest_hour: number | null;
  digest_minute: number;
  hashtags_json: string | null;
  model_id: string | null;
  email_enabled: number;
  session_version: number;
}

function baseRow(): UserRow {
  return {
    id: '12345',
    email: 'alice@example.com',
    gh_login: 'alice',
    tz: 'Europe/Zurich',
    digest_hour: 8,
    digest_minute: 0,
    hashtags_json: '["ai"]',
    model_id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    email_enabled: 1,
    session_version: 1,
  };
}

/**
 * D1 stub:
 *   - SELECT id, email, gh_login, ... -> {@link authRow} (for
 *     auth-middleware loadSession)
 *   - SELECT tag FROM pending_discoveries -> {@link pending}
 * Captures the bound user_id so tests can assert scoping.
 */
function makeDb(
  authRow: UserRow | null,
  pending: string[],
): { db: D1Database; bindings: unknown[][] } {
  const bindings: unknown[][] = [];
  const prepareSpy = vi.fn().mockImplementation((sql: string) => {
    const stmt = {
      _sql: sql,
      _params: [] as unknown[],
      bind(...params: unknown[]) {
        stmt._params = params;
        bindings.push(params);
        return stmt;
      },
      first: vi.fn().mockImplementation(async () => {
        if (sql.startsWith('SELECT id, email, gh_login')) return authRow;
        return null;
      }),
      all: vi.fn().mockImplementation(async () => {
        if (sql.startsWith('SELECT tag FROM pending_discoveries')) {
          return { results: pending.map((tag) => ({ tag })) };
        }
        return { results: [] };
      }),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
    };
    return stmt;
  });
  const db = { prepare: prepareSpy } as unknown as D1Database;
  return { db, bindings };
}

// In-memory KV stub so the rate-limit fail-open path doesn't throw on
// `env.KV.get(...)`. CF-019 added enforceRateLimit(env, RULES.DISCOVERY_STATUS, ...);
// without this stub the limiter swallows a TypeError and silently
// fail-opens in every test, masking regressions in the wiring.
function makeKvStub(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  } as unknown as KVNamespace;
}

function env(db: D1Database): Partial<Env> {
  return {
    APP_URL,
    OAUTH_JWT_SECRET: JWT_SECRET,
    DB: db,
    KV: makeKvStub(),
  };
}

function makeContext(request: Request, e: Partial<Env>): unknown {
  return {
    request,
    locals: { runtime: { env: e as Env } },
    url: new URL(request.url),
  };
}

async function discoveryStatusRequest(
  token: string | null,
): Promise<Request> {
  const headers = new Headers();
  if (token !== null) {
    headers.set('Cookie', `${SESSION_COOKIE_NAME}=${token}`);
  }
  return new Request(`${APP_URL}/api/discovery/status`, {
    method: 'GET',
    headers,
  });
}

describe('GET /api/discovery/status', () => {
  it('REQ-SET-006: returns 401 when no session is present', async () => {
    const { db } = makeDb(null, []);
    const req = await discoveryStatusRequest(null);
    const res = await GET(makeContext(req, env(db)) as never);
    expect(res.status).toBe(401);
  });

  it('REQ-SET-006: returns empty pending list when no rows exist', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      JWT_SECRET,
    );
    const { db } = makeDb(baseRow(), []);
    const req = await discoveryStatusRequest(token);
    const res = await GET(makeContext(req, env(db)) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending: string[] };
    expect(body.pending).toEqual([]);
  });

  it('REQ-SET-006: returns tags from pending_discoveries table', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      JWT_SECRET,
    );
    const { db } = makeDb(baseRow(), ['llm', 'mcp']);
    const req = await discoveryStatusRequest(token);
    const res = await GET(makeContext(req, env(db)) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending: string[] };
    expect(body.pending).toEqual(['llm', 'mcp']);
  });

  it('REQ-SET-006: query is scoped to the session user id', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      JWT_SECRET,
    );
    const { db, bindings } = makeDb(baseRow(), ['llm']);
    const req = await discoveryStatusRequest(token);
    await GET(makeContext(req, env(db)) as never);
    // Second bind() call is the pending_discoveries lookup (first is the
    // auth-middleware user lookup). Both must bind user_id=12345.
    expect(bindings.length).toBeGreaterThanOrEqual(2);
    const pendingBinding = bindings[1]!;
    expect(pendingBinding[0]).toBe('12345');
  });

  it('REQ-SET-006 AC 5: returns 429 with Retry-After when DISCOVERY_STATUS bucket is exhausted', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      JWT_SECRET,
    );
    const { db } = makeDb(baseRow(), []);

    // Pre-seed the KV bucket at the cap (120) so the very next request is
    // over-limit. The key mirrors the formula in src/lib/rate-limit.ts:
    //   `ratelimit:${routeClass}:${identity}:${windowIndex}`
    // where windowIndex = Math.floor(nowSec / windowSec).
    // Computing it here at test-run time guarantees it matches what the
    // handler will derive when it runs milliseconds later.
    const windowIndex = Math.floor(Date.now() / 1000 / 60); // windowSec=60
    const exhaustedKey = `ratelimit:discovery_status:user:12345:${windowIndex}`;
    const store = new Map<string, string>([[exhaustedKey, '120']]); // at the limit
    const kvStub = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    } as unknown as KVNamespace;

    const e: Partial<Env> = { APP_URL, OAUTH_JWT_SECRET: JWT_SECRET, DB: db, KV: kvStub };
    const req = await discoveryStatusRequest(token);
    const res = await GET(makeContext(req, e) as never);

    expect(res.status).toBe(429);
    const retryAfter = res.headers.get('Retry-After');
    expect(retryAfter).not.toBeNull();
    expect(Number.parseInt(retryAfter!, 10)).toBeGreaterThan(0);
  });
});
