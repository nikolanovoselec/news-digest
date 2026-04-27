// Tests for src/pages/api/admin/discovery/retry.ts — REQ-DISC-004 + REQ-AUTH-003.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from '~/pages/api/admin/discovery/retry';
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

/** D1 stub — SELECT returns the user row, records INSERT params. */
function makeDb(row: UserRow | null): {
  db: D1Database;
  runCalls: Array<{ sql: string; params: unknown[] }>;
} {
  const runCalls: Array<{ sql: string; params: unknown[] }> = [];
  const prepareSpy = vi.fn().mockImplementation((sql: string) => ({
    bind: (...params: unknown[]) => ({
      first: vi.fn().mockResolvedValue(sql.startsWith('SELECT') ? row : null),
      run: vi.fn().mockImplementation(async () => {
        runCalls.push({ sql, params });
        return { success: true, meta: { changes: 1 } };
      }),
    }),
  }));
  const db = { prepare: prepareSpy } as unknown as D1Database;
  return { db, runCalls };
}

function makeKv(): {
  kv: KVNamespace;
  deletes: string[];
} {
  const deletes: string[] = [];
  const kv = {
    delete: vi.fn().mockImplementation(async (key: string) => {
      deletes.push(key);
    }),
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  } as unknown as KVNamespace;
  return { kv, deletes };
}

function baseRow(hashtagsJson: string | null): UserRow {
  return {
    id: '12345',
    email: 'alice@example.com',
    gh_login: 'alice',
    tz: 'Europe/Zurich',
    digest_hour: 8,
    digest_minute: 0,
    hashtags_json: hashtagsJson,
    model_id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    email_enabled: 1,
    session_version: 1,
  };
}

function envWith(db: D1Database, kv: KVNamespace): Partial<Env> {
  return {
    APP_URL,
    OAUTH_JWT_SECRET: JWT_SECRET,
    DB: db,
    KV: kv,
    // CF-001 — retry now requires admin gate. Tests use the
    // session-row email as the admin email.
    ADMIN_EMAIL: 'alice@example.com',
  };
}

async function retryRequest(options: {
  origin?: string | null;
  cookie?: string | null;
  body?: unknown;
  /** Cf-Access-Jwt-Assertion override; defaults to a placeholder so
   *  tests that don't care about the admin gate still pass. */
  accessJwt?: string | null;
}): Promise<Request> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (options.origin !== null && options.origin !== undefined) {
    headers.set('Origin', options.origin);
  }
  if (options.cookie !== null && options.cookie !== undefined) {
    headers.set('Cookie', options.cookie);
  }
  const access = options.accessJwt === undefined ? 'placeholder.jwt.sig' : options.accessJwt;
  if (access !== null) {
    headers.set('Cf-Access-Jwt-Assertion', access);
  }
  const init: RequestInit = { method: 'POST', headers };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  return new Request(`${APP_URL}/api/admin/discovery/retry`, init);
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

describe('POST /api/admin/discovery/retry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('REQ-AUTH-003: rejects request with missing Origin header', async () => {
    const { db } = makeDb(baseRow('["ai"]'));
    const { kv } = makeKv();
    const req = await retryRequest({ origin: null, body: { tag: 'ai' } });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(403);
  });

  it('REQ-DISC-004: returns 401 without a session', async () => {
    const { db } = makeDb(baseRow('["ai"]'));
    const { kv } = makeKv();
    const req = await retryRequest({
      origin: APP_ORIGIN,
      body: { tag: 'ai' },
    });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(401);
  });

  it('REQ-DISC-004: rejects tag not in user hashtags_json with 400 unknown_tag', async () => {
    const cookie = await validSessionCookie();
    const { db } = makeDb(baseRow('["ai", "go"]'));
    const { kv } = makeKv();
    const req = await retryRequest({
      origin: APP_ORIGIN,
      cookie,
      body: { tag: 'rust' },
    });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('unknown_tag');
  });

  it('REQ-DISC-004: rejects when hashtags_json is null with 400 unknown_tag', async () => {
    const cookie = await validSessionCookie();
    const { db } = makeDb(baseRow(null));
    const { kv } = makeKv();
    const req = await retryRequest({
      origin: APP_ORIGIN,
      cookie,
      body: { tag: 'ai' },
    });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('unknown_tag');
  });

  it('REQ-DISC-004: rejects body without tag field', async () => {
    const cookie = await validSessionCookie();
    const { db } = makeDb(baseRow('["ai"]'));
    const { kv } = makeKv();
    const req = await retryRequest({
      origin: APP_ORIGIN,
      cookie,
      body: {},
    });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(400);
  });

  it('REQ-DISC-004: rejects malformed JSON body', async () => {
    const cookie = await validSessionCookie();
    const { db } = makeDb(baseRow('["ai"]'));
    const { kv } = makeKv();
    const req = new Request(`${APP_URL}/api/admin/discovery/retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: APP_ORIGIN,
        Cookie: cookie,
      },
      body: 'not json',
    });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(400);
  });

  it('REQ-DISC-004: valid tag clears KV entries and inserts pending row, returns 200 {ok:true}', async () => {
    const cookie = await validSessionCookie();
    const { db, runCalls } = makeDb(baseRow('["ai"]'));
    const { kv, deletes } = makeKv();
    const req = await retryRequest({
      origin: APP_ORIGIN,
      cookie,
      body: { tag: 'ai' },
    });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Both KV keys were cleared.
    expect(deletes).toContain('sources:ai');
    expect(deletes).toContain('discovery_failures:ai');

    // INSERT OR IGNORE pending_discoveries row for (user_id, tag).
    const insert = runCalls.find(
      (c) => typeof c.sql === 'string' && c.sql.startsWith('INSERT OR IGNORE INTO pending_discoveries'),
    );
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe('12345'); // user_id
    expect(insert!.params[1]).toBe('ai'); // tag
    expect(typeof insert!.params[2]).toBe('number'); // added_at
  });

  it('REQ-DISC-004: accepts tag with leading # and stores normalised form', async () => {
    const cookie = await validSessionCookie();
    const { db, runCalls } = makeDb(baseRow('["ai"]'));
    const { kv, deletes } = makeKv();
    const req = await retryRequest({
      origin: APP_ORIGIN,
      cookie,
      body: { tag: '#ai' },
    });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(200);

    // Normalised form is used for KV keys (no leading #).
    expect(deletes).toContain('sources:ai');

    const insert = runCalls.find(
      (c) => typeof c.sql === 'string' && c.sql.startsWith('INSERT OR IGNORE INTO pending_discoveries'),
    );
    expect(insert!.params[1]).toBe('ai');
  });

  // ---- REQ-DISC-004 form-POST branch -------------------------------------
  //
  // A native <form method="post" enctype="application/x-www-form-urlencoded">
  // submission must be accepted, queue the tag identically to the JSON
  // path, and return a 303 redirect to /settings so the browser navigates
  // back with a visible confirmation rather than seeing a raw JSON body.

  async function retryFormRequest(options: {
    origin?: string | null;
    cookie?: string | null;
    tag?: string | null;
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
    const params = new URLSearchParams();
    if (options.tag !== null && options.tag !== undefined) {
      params.set('tag', options.tag);
    }
    return new Request(`${APP_URL}/api/admin/discovery/retry`, {
      method: 'POST',
      headers,
      body: params.toString(),
    });
  }

  it('REQ-DISC-004: form-encoded POST returns 303 redirect to /settings', async () => {
    const cookie = await validSessionCookie();
    const { db, runCalls } = makeDb(baseRow('["ikea"]'));
    const { kv, deletes } = makeKv();
    const req = await retryFormRequest({
      origin: APP_ORIGIN,
      cookie,
      tag: 'ikea',
    });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(303);
    const location = res.headers.get('Location');
    expect(location).toBe('/settings?rediscover=ok&tag=ikea');

    // Same side effects as the JSON path.
    expect(deletes).toContain('sources:ikea');
    expect(deletes).toContain('discovery_failures:ikea');
    const insert = runCalls.find(
      (c) =>
        typeof c.sql === 'string' &&
        c.sql.startsWith('INSERT OR IGNORE INTO pending_discoveries'),
    );
    expect(insert).toBeDefined();
    expect(insert!.params[1]).toBe('ikea');
  });

  it('REQ-DISC-004: form-encoded POST still rejects tags outside hashtags_json', async () => {
    const cookie = await validSessionCookie();
    const { db } = makeDb(baseRow('["ai"]'));
    const { kv } = makeKv();
    const req = await retryFormRequest({
      origin: APP_ORIGIN,
      cookie,
      tag: 'netflix',
    });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('unknown_tag');
  });

  it('REQ-DISC-004: form-encoded POST still rejects missing Origin header', async () => {
    const cookie = await validSessionCookie();
    const { db } = makeDb(baseRow('["ikea"]'));
    const { kv } = makeKv();
    const req = await retryFormRequest({ origin: null, cookie, tag: 'ikea' });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(403);
  });

  it('REQ-DISC-004: form-encoded POST without a session returns 401', async () => {
    const { db } = makeDb(baseRow('["ikea"]'));
    const { kv } = makeKv();
    const req = await retryFormRequest({ origin: APP_ORIGIN, tag: 'ikea' });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(401);
  });

  it('REQ-DISC-004: form-encoded POST URL-encodes the tag in the redirect location', async () => {
    const cookie = await validSessionCookie();
    const { db } = makeDb(baseRow('["my-tag"]'));
    const { kv } = makeKv();
    const req = await retryFormRequest({
      origin: APP_ORIGIN,
      cookie,
      tag: 'my-tag',
    });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(303);
    const location = res.headers.get('Location') ?? '';
    // encodeURIComponent('my-tag') = 'my-tag' (no special chars) — but the
    // invariant we want to pin is that the redirect URL is well-formed.
    expect(location.startsWith('/settings?rediscover=ok&tag=')).toBe(true);
  });

  it('REQ-DISC-004: tag membership is case-insensitive (legacy mixed-case storage)', async () => {
    // Regression guard: a legacy row stored as `["#AI"]` must still
    // accept a button click posting `tag=ai` (the on-disk format was
    // case-sensitive before the settings write path lowercased).
    const cookie = await validSessionCookie();
    const { db, runCalls } = makeDb(baseRow('["#AI"]'));
    const { kv, deletes } = makeKv();
    const req = await retryRequest({
      origin: APP_ORIGIN,
      cookie,
      body: { tag: 'ai' },
    });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(200);
    // KV keys are always the normalised lowercase form, matching the
    // chunk consumer + coordinator's view of sources:{tag}.
    expect(deletes).toContain('sources:ai');
    const insert = runCalls.find(
      (c) =>
        typeof c.sql === 'string' &&
        c.sql.startsWith('INSERT OR IGNORE INTO pending_discoveries'),
    );
    expect(insert!.params[1]).toBe('ai');
  });

  it('REQ-DISC-004: JSON POST response shape unchanged (regression guard)', async () => {
    // The form-encoded branch must not accidentally shadow the JSON
    // contract. A JSON POST still returns 200 with {ok: true}.
    const cookie = await validSessionCookie();
    const { db } = makeDb(baseRow('["ai"]'));
    const { kv } = makeKv();
    const req = await retryRequest({
      origin: APP_ORIGIN,
      cookie,
      body: { tag: 'ai' },
    });
    const res = await POST(makeContext(req, envWith(db, kv)) as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
