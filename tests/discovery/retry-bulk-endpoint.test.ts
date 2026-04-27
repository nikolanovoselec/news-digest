// Tests for src/pages/api/admin/discovery/retry-bulk.ts —
// REQ-DISC-004 AC 1/3/4 (bulk variant) + REQ-AUTH-003 (Origin gate).
//
// Behaviour pinned:
//   - Origin and session gates fire BEFORE any KV/D1 work.
//   - Only tags whose `sources:{tag}` parses to {feeds: []} are re-queued.
//     Brand-new tags (no entry yet) are ignored.
//   - For every stuck tag the endpoint deletes both KV keys
//     (`sources:{tag}` and `discovery_failures:{tag}`) and INSERTs a
//     pending_discoveries row. Insert is a single D1 batch.
//   - Empty stuck-set is a 303 success with count=0 (no-op redirect),
//     not an error.
//   - Response is always 303 → /settings?rediscover=ok&count=N.
//
// Cloudflare Access gating happens at the zone level and is NOT tested
// here — the worker code never runs against a real Access JWT in tests.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST, GET } from '~/pages/api/admin/discovery/retry-bulk';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';
import { signSession } from '~/lib/session-jwt';

const JWT_SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';
const APP_URL = 'https://news-digest.example.com';
const APP_ORIGIN = 'https://news-digest.example.com';

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

function userWith(hashtagsJson: string | null): UserRow {
  return {
    id: '12345',
    email: 'alice@example.com',
    gh_login: 'alice',
    tz: 'UTC',
    digest_hour: 8,
    digest_minute: 0,
    hashtags_json: hashtagsJson,
    model_id: '@cf/openai/gpt-oss-120b',
    email_enabled: 1,
    session_version: 1,
  };
}

interface SqlBinding {
  sql: string;
  params: unknown[];
}

/** D1 stub that records every prepared statement bind() call so the
 *  test can assert what was inserted and via which API path
 *  (`run` vs `batch`). The user lookup returns the row from `userWith`. */
function makeDb(user: UserRow): {
  db: D1Database;
  bindings: SqlBinding[];
  batches: Array<SqlBinding[]>;
} {
  const bindings: SqlBinding[] = [];
  const batches: Array<SqlBinding[]> = [];
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const stmt = {
      _sql: sql,
      _params: [] as unknown[],
      bind(...params: unknown[]) {
        // Each bind returns a NEW statement object so a single
        // prepared statement can be reused across multiple batch rows
        // with different params (matches D1's real API).
        return {
          _sql: sql,
          _params: params,
          first: vi.fn().mockResolvedValue(sql.includes('FROM users') ? user : null),
          run: vi.fn().mockImplementation(async () => {
            bindings.push({ sql, params });
            return { success: true, meta: { changes: 1 } };
          }),
        };
      },
      first: vi.fn().mockResolvedValue(sql.includes('FROM users') ? user : null),
    };
    return stmt;
  });
  const batch = vi
    .fn()
    .mockImplementation(async (statements: Array<{ _sql: string; _params: unknown[] }>) => {
      const captured = statements.map((s) => ({ sql: s._sql, params: s._params }));
      batches.push(captured);
      // Mirror into the per-statement record too so tests can assert
      // either way.
      for (const c of captured) bindings.push(c);
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    });
  const db = { prepare, batch } as unknown as D1Database;
  return { db, bindings, batches };
}

interface KvHandles {
  kv: KVNamespace;
  store: Map<string, string>;
  deletes: string[];
}

function makeKv(initial: Record<string, string> = {}): KvHandles {
  const store = new Map<string, string>(Object.entries(initial));
  const deletes: string[] = [];
  const kv = {
    get: vi.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
    put: vi.fn().mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      deletes.push(key);
      store.delete(key);
    }),
  } as unknown as KVNamespace;
  return { kv, store, deletes };
}

function envWith(db: D1Database, kv: KVNamespace): Partial<Env> {
  return {
    APP_URL,
    OAUTH_JWT_SECRET: JWT_SECRET,
    DB: db,
    KV: kv,
    // CF-001 — retry-bulk now requires admin gate.
    ADMIN_EMAIL: 'alice@example.com',
  };
}

function makeContext(request: Request, e: Partial<Env>): unknown {
  return {
    request,
    locals: { runtime: { env: e as Env } },
    url: new URL(request.url),
  };
}

async function validSessionCookie(): Promise<string> {
  const token = await signSession(
    { sub: '12345', email: 'alice@example.com', ghl: 'alice', sv: 1 },
    JWT_SECRET,
  );
  return `${SESSION_COOKIE_NAME}=${token}`;
}

async function bulkRequest(options: {
  origin?: string | null;
  cookie?: string | null;
  accessJwt?: string | null;
}): Promise<Request> {
  const headers = new Headers({
    'Content-Type': 'application/x-www-form-urlencoded',
  });
  if (options.origin !== null && options.origin !== undefined) {
    headers.set('Origin', options.origin);
  }
  if (options.cookie !== null && options.cookie !== undefined) {
    headers.set('Cookie', options.cookie);
  }
  // CF-001 — admin gate requires this header. Default to a placeholder.
  const access = options.accessJwt === undefined ? 'placeholder.jwt.sig' : options.accessJwt;
  if (access !== null) {
    headers.set('Cf-Access-Jwt-Assertion', access);
  }
  return new Request(`${APP_URL}/api/admin/discovery/retry-bulk`, {
    method: 'POST',
    headers,
  });
}

describe('POST /api/admin/discovery/retry-bulk — REQ-DISC-004', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('REQ-AUTH-003: rejects missing Origin header before touching D1 or KV', async () => {
    const { db, bindings } = makeDb(userWith('["ai"]'));
    const { kv, deletes } = makeKv();
    const req = await bulkRequest({ origin: null, cookie: await validSessionCookie() });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(403);
    expect(bindings).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });

  it('REQ-DISC-004: returns 401 without a session', async () => {
    const { db } = makeDb(userWith('["ai"]'));
    const { kv } = makeKv();
    const req = await bulkRequest({ origin: APP_ORIGIN });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(401);
  });

  it('REQ-DISC-004: redirects with count=0 when no tag is stuck (no-op success)', async () => {
    const cookie = await validSessionCookie();
    const { db, bindings } = makeDb(userWith('["ai", "go"]'));
    // Both tags have populated feed lists → not stuck.
    const { kv, deletes } = makeKv({
      'sources:ai': JSON.stringify({
        feeds: [{ name: 'A', url: 'https://a.example/rss', kind: 'rss' }],
        discovered_at: Date.now(),
      }),
      'sources:go': JSON.stringify({
        feeds: [{ name: 'B', url: 'https://b.example/rss', kind: 'rss' }],
        discovered_at: Date.now(),
      }),
    });
    const req = await bulkRequest({ origin: APP_ORIGIN, cookie });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/settings?rediscover=ok&count=0');
    // No insert, no delete — the no-op path must not touch D1 or KV.
    expect(bindings).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });

  it('REQ-DISC-004: re-queues every stuck tag in one D1 batch and clears both KV keys per tag', async () => {
    const cookie = await validSessionCookie();
    const { db, batches } = makeDb(
      userWith('["ai", "go", "ikea", "tesla"]'),
    );
    // ai = populated (not stuck); go + ikea + tesla = empty feeds (stuck).
    const { kv, deletes } = makeKv({
      'sources:ai': JSON.stringify({
        feeds: [{ name: 'A', url: 'https://a.example/rss', kind: 'rss' }],
        discovered_at: Date.now(),
      }),
      'sources:go': JSON.stringify({ feeds: [], discovered_at: Date.now() }),
      'sources:ikea': JSON.stringify({ feeds: [], discovered_at: Date.now() }),
      'sources:tesla': JSON.stringify({ feeds: [], discovered_at: Date.now() }),
      'discovery_failures:ikea': '2',
    });
    const req = await bulkRequest({ origin: APP_ORIGIN, cookie });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/settings?rediscover=ok&count=3');

    // KV deletes: 2 keys × 3 stuck tags = 6 deletes total.
    const expectedDeletes = [
      'sources:go',
      'sources:ikea',
      'sources:tesla',
      'discovery_failures:go',
      'discovery_failures:ikea',
      'discovery_failures:tesla',
    ];
    for (const key of expectedDeletes) {
      expect(deletes).toContain(key);
    }
    // The healthy tag must NOT have its keys touched.
    expect(deletes).not.toContain('sources:ai');

    // D1 batch: exactly one batch call with three INSERT OR IGNORE rows.
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch).toHaveLength(3);
    for (const row of batch) {
      expect(row.sql).toContain('INSERT OR IGNORE INTO pending_discoveries');
      expect(row.params[0]).toBe('12345'); // user_id
      expect(typeof row.params[2]).toBe('number'); // unix-second timestamp
    }
    const insertedTags = batch.map((r) => r.params[1]).sort();
    expect(insertedTags).toEqual(['go', 'ikea', 'tesla']);
  });

  it('REQ-DISC-004: ignores tags with no `sources:{tag}` entry yet (still discovering, not stuck)', async () => {
    const cookie = await validSessionCookie();
    const { db, bindings } = makeDb(userWith('["new-tag"]'));
    // Empty KV — the tag has never been written to.
    const { kv } = makeKv();
    const req = await bulkRequest({ origin: APP_ORIGIN, cookie });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/settings?rediscover=ok&count=0');
    expect(bindings).toHaveLength(0);
  });

  it('REQ-DISC-004: returns 303 count=0 when the user has no hashtags at all', async () => {
    const cookie = await validSessionCookie();
    const { db, bindings } = makeDb(userWith(null));
    const { kv } = makeKv();
    const req = await bulkRequest({ origin: APP_ORIGIN, cookie });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/settings?rediscover=ok&count=0');
    expect(bindings).toHaveLength(0);
  });

  it('REQ-DISC-004: tolerates corrupt JSON in `sources:{tag}` by treating it as not-stuck (no false re-queue)', async () => {
    const cookie = await validSessionCookie();
    const { db, bindings } = makeDb(userWith('["x"]'));
    const { kv } = makeKv({ 'sources:x': '{not-valid-json' });
    const req = await bulkRequest({ origin: APP_ORIGIN, cookie });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/settings?rediscover=ok&count=0');
    expect(bindings).toHaveLength(0);
  });

  it('REQ-DISC-004: a stored value with `feeds` set to a non-array is NOT considered stuck', async () => {
    // Defence against a corrupt write that landed `feeds: null` or
    // `feeds: "string"`. The discovery cron is responsible for healing
    // those; the bulk endpoint should not.
    const cookie = await validSessionCookie();
    const { db, bindings } = makeDb(userWith('["x", "y"]'));
    const { kv } = makeKv({
      'sources:x': JSON.stringify({ feeds: null, discovered_at: Date.now() }),
      'sources:y': JSON.stringify({ feeds: 'oops', discovered_at: Date.now() }),
    });
    const req = await bulkRequest({ origin: APP_ORIGIN, cookie });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/settings?rediscover=ok&count=0');
    expect(bindings).toHaveLength(0);
  });
});

// REQ-DISC-004 AC 4 — GET handler exists for the Cloudflare Access
// post-auth callback path, where Access intercepts the form's POST,
// bounces through SSO, and returns the user as a GET to the original
// URL. Without GET handling the user lands on a 404. Browsers always
// see a 303 redirect to /settings; scripts that opt into JSON via the
// Accept header get a JSON body instead.

async function bulkGetRequest(options: {
  cookie?: string | null;
  accept?: string | null;
}): Promise<Request> {
  const headers = new Headers();
  if (options.cookie !== null && options.cookie !== undefined) {
    headers.set('Cookie', options.cookie);
  }
  if (options.accept !== null && options.accept !== undefined) {
    headers.set('Accept', options.accept);
  }
  return new Request(`${APP_URL}/api/admin/discovery/retry-bulk`, {
    method: 'GET',
    headers,
  });
}

describe('GET /api/admin/discovery/retry-bulk — REQ-DISC-004 AC 4 (Access post-auth callback)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('REQ-DISC-004: GET browser path 303-redirects to /settings with count=N (no 404)', async () => {
    const cookie = await validSessionCookie();
    const { db } = makeDb(userWith('["ai", "go"]'));
    const { kv } = makeKv({
      'sources:ai': JSON.stringify({
        feeds: [{ name: 'A', url: 'https://a.example/rss', kind: 'rss' }],
        discovered_at: Date.now(),
      }),
      'sources:go': JSON.stringify({ feeds: [], discovered_at: Date.now() }),
    });
    const req = await bulkGetRequest({ cookie });
    const res = await GET(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${APP_ORIGIN}/settings?rediscover=ok&count=1`);
  });

  it('REQ-DISC-004: GET with Accept: application/json returns a JSON body', async () => {
    const cookie = await validSessionCookie();
    const { db } = makeDb(userWith('["go"]'));
    const { kv } = makeKv({
      'sources:go': JSON.stringify({ feeds: [], discovered_at: Date.now() }),
    });
    const req = await bulkGetRequest({ cookie, accept: 'application/json' });
    const res = await GET(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = await res.json();
    expect(body).toEqual({ ok: true, count: 1 });
  });

  it('REQ-DISC-004: GET browser path without a session redirects to /settings (no raw JSON)', async () => {
    // Without a session, browsers must NEVER see a JSON 401 — that
    // looks like a 404 to a user who just clicked through Cloudflare
    // Access SSO. The handler redirects to /settings instead.
    const { db } = makeDb(userWith('["go"]'));
    const { kv } = makeKv();
    const req = await bulkGetRequest({});
    const res = await GET(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${APP_ORIGIN}/settings?rediscover=error`);
  });

  it('REQ-DISC-004: GET with Accept: application/json without a session returns 401 (scripted callers opt in)', async () => {
    const { db } = makeDb(userWith('["go"]'));
    const { kv } = makeKv();
    const req = await bulkGetRequest({ accept: 'application/json' });
    const res = await GET(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(401);
  });
});
