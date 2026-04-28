// Tests for src/pages/api/settings.ts — REQ-SET-001..005 GET shape and
// PUT validation. REQ-SET-006-adjacent first_run derivation. PUT queues
// discovery for tags missing from KV.

import { describe, it, expect, vi } from 'vitest';
import { GET, POST, PUT, MAX_HASHTAGS } from '~/pages/api/settings';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';
import { signSession } from '~/lib/session-jwt';

const JWT_SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';
const APP_URL = 'https://news-digest.example.com';
const APP_ORIGIN = 'https://news-digest.example.com';
const VALID_MODEL_ID = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';

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

interface SettingsRow {
  hashtags_json: string | null;
  digest_hour: number | null;
  digest_minute: number;
  tz: string;
  model_id: string | null;
  email_enabled: number;
}

/**
 * Build a D1 stub:
 *  - `SELECT id, email, gh_login, tz, ...` -> the auth-middleware row
 *    ({@link authRow})
 *  - `SELECT hashtags_json, ...` -> the GET settings row
 *    ({@link settingsRow}, defaults to the same data as {@link authRow})
 *  - UPDATE/INSERT OR IGNORE -> recorded for assertions
 */
function makeDb(
  authRow: UserRow | null,
  settingsRow?: SettingsRow | null,
): {
  db: D1Database;
  runCalls: { sql: string; params: unknown[] }[];
  batchCalls: { sql: string; params: unknown[] }[][];
} {
  const runCalls: { sql: string; params: unknown[] }[] = [];
  const batchCalls: { sql: string; params: unknown[] }[][] = [];

  const deriveSettingsRow = (): SettingsRow | null => {
    if (settingsRow !== undefined) return settingsRow;
    if (authRow === null) return null;
    return {
      hashtags_json: authRow.hashtags_json,
      digest_hour: authRow.digest_hour,
      digest_minute: authRow.digest_minute,
      tz: authRow.tz,
      model_id: authRow.model_id,
      email_enabled: authRow.email_enabled,
    };
  };

  const prepareSpy = vi.fn().mockImplementation((sql: string) => {
    const stmt = {
      _sql: sql,
      _params: [] as unknown[],
      bind(...params: unknown[]) {
        stmt._params = params;
        return stmt;
      },
      first: vi.fn().mockImplementation(async () => {
        if (sql.startsWith('SELECT id, email, gh_login')) return authRow;
        if (sql.startsWith('SELECT hashtags_json')) return deriveSettingsRow();
        return null;
      }),
      run: vi.fn().mockImplementation(async () => {
        runCalls.push({ sql, params: stmt._params });
        return { success: true, meta: { changes: 1 } };
      }),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    return stmt;
  });

  const batchFn = vi.fn().mockImplementation(async (stmts: unknown[]) => {
    const recorded = stmts.map((s) => {
      const typed = s as { _sql: string; _params: unknown[] };
      return { sql: typed._sql, params: typed._params };
    });
    batchCalls.push(recorded);
    return recorded.map(() => ({ success: true, meta: { changes: 1 } }));
  });

  const db = { prepare: prepareSpy, batch: batchFn } as unknown as D1Database;
  return { db, runCalls, batchCalls };
}

/**
 * KV stub that returns a miss for every listed tag (so every tag looks
 * new and gets queued for discovery) unless the key is in {@link have}.
 */
function makeKv(have: string[] = []): { kv: KVNamespace } {
  const kv = {
    get: vi.fn().mockImplementation(async (key: string) => {
      const tag = key.startsWith('sources:') ? key.slice('sources:'.length) : '';
      return have.includes(tag) ? 'cached' : null;
    }),
  } as unknown as KVNamespace;
  return { kv };
}

function env(db: D1Database, kv: KVNamespace): Partial<Env> {
  return {
    APP_URL,
    OAUTH_JWT_SECRET: JWT_SECRET,
    DB: db,
    KV: kv,
  };
}

function makeContext(request: Request, e: Partial<Env>): unknown {
  return {
    request,
    locals: { runtime: { env: e as Env } },
    url: new URL(request.url),
  };
}

function baseRow(): UserRow {
  return {
    id: '12345',
    email: 'alice@example.com',
    gh_login: 'alice',
    tz: 'Europe/Zurich',
    digest_hour: 8,
    digest_minute: 0,
    hashtags_json: JSON.stringify(['ai', 'llm']),
    model_id: VALID_MODEL_ID,
    email_enabled: 1,
    session_version: 1,
  };
}

function newUserRow(): UserRow {
  return {
    id: '12345',
    email: 'alice@example.com',
    gh_login: 'alice',
    tz: 'UTC',
    digest_hour: null,
    digest_minute: 0,
    hashtags_json: null,
    model_id: null,
    email_enabled: 1,
    session_version: 1,
  };
}

interface AuthedRequestOpts {
  /** Explicit null to OMIT the Origin header; string to set a specific
   *  origin; undefined (or omitted) to use the default APP_ORIGIN. */
  origin?: string | null;
  /** Explicit null to OMIT the session cookie; string to override;
   *  undefined (or omitted) to generate a fresh token for user 12345. */
  token?: string | null;
}

async function authedRequest(
  method: 'GET' | 'PUT',
  body?: unknown,
  opts: AuthedRequestOpts = {},
): Promise<Request> {
  const headers = new Headers();
  if (method === 'PUT') {
    headers.set('Content-Type', 'application/json');
    if (typeof opts.origin === 'string') {
      headers.set('Origin', opts.origin);
    } else if (!('origin' in opts) || opts.origin === undefined) {
      headers.set('Origin', APP_ORIGIN);
    }
    // opts.origin === null -> OMIT.
  }
  if (opts.token !== null) {
    const token =
      opts.token ??
      (await signSession(
        { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
        JWT_SECRET,
      ));
    headers.set('Cookie', `${SESSION_COOKIE_NAME}=${token}`);
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`${APP_URL}/api/settings`, init);
}

describe('GET /api/settings', () => {
  it('REQ-SET-001: returns 401 when there is no session', async () => {
    const { db } = makeDb(null);
    const { kv } = makeKv();
    const req = await authedRequest('GET', undefined, { token: null });
    const res = await GET(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(401);
  });

  it('REQ-SET-001: returns the settings shape for an authenticated user', async () => {
    const { db } = makeDb(baseRow());
    const { kv } = makeKv();
    const req = await authedRequest('GET');
    const res = await GET(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hashtags: string[];
      digest_hour: number | null;
      digest_minute: number;
      tz: string;
      model_id: string | null;
      email_enabled: boolean;
      first_run: boolean;
    };
    expect(body.hashtags).toEqual(['ai', 'llm']);
    expect(body.digest_hour).toBe(8);
    expect(body.digest_minute).toBe(0);
    expect(body.tz).toBe('Europe/Zurich');
    expect(body.model_id).toBe(VALID_MODEL_ID);
    expect(body.email_enabled).toBe(true);
    expect(body.first_run).toBe(false);
  });

  it('REQ-SET-001: reports first_run=true when hashtags_json is NULL', async () => {
    const { db } = makeDb(newUserRow());
    const { kv } = makeKv();
    const req = await authedRequest('GET');
    const res = await GET(makeContext(req, env(db, kv)) as never);
    const body = (await res.json()) as { first_run: boolean };
    expect(body.first_run).toBe(true);
  });
});

describe('PUT /api/settings', () => {
  it('REQ-SET-001: returns 403 when Origin is missing', async () => {
    const { db } = makeDb(baseRow());
    const { kv } = makeKv();
    const req = await authedRequest('PUT', { hashtags: ['ai'] }, { origin: null });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(403);
  });

  it('REQ-SET-001: returns 401 when not authenticated', async () => {
    const { db } = makeDb(null);
    const { kv } = makeKv();
    const req = await authedRequest(
      'PUT',
      {
        hashtags: ['ai'],
        digest_hour: 8,
        digest_minute: 0,
        tz: 'UTC',
        model_id: VALID_MODEL_ID,
        email_enabled: true,
      },
      { token: null, origin: APP_ORIGIN },
    );
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(401);
  });

  it('REQ-SET-002: rejects empty hashtag array with invalid_hashtags', async () => {
    const { db } = makeDb(baseRow());
    const { kv } = makeKv();
    const req = await authedRequest('PUT', {
      hashtags: [],
      digest_hour: 8,
      digest_minute: 0,
      tz: 'UTC',
      model_id: VALID_MODEL_ID,
      email_enabled: true,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_hashtags' });
  });

  it('REQ-SET-002: rejects hashtag with only disallowed characters', async () => {
    const { db } = makeDb(baseRow());
    const { kv } = makeKv();
    // "!!" normalizes to "" which fails the 2-32 length check.
    const req = await authedRequest('PUT', {
      hashtags: ['!!'],
      digest_hour: 8,
      digest_minute: 0,
      tz: 'UTC',
      model_id: VALID_MODEL_ID,
      email_enabled: true,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_hashtags' });
  });

  it('REQ-SET-002: rejects hashtag shorter than 2 chars after normalization', async () => {
    const { db } = makeDb(baseRow());
    const { kv } = makeKv();
    const req = await authedRequest('PUT', {
      hashtags: ['a'],
      digest_hour: 8,
      digest_minute: 0,
      tz: 'UTC',
      model_id: VALID_MODEL_ID,
      email_enabled: true,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(400);
  });

  it('REQ-SET-002: rejects more than MAX_HASHTAGS tags', async () => {
    // Derive the array length from the exported constant so a future
    // cap bump doesn't silently break this test.
    const { db } = makeDb(baseRow());
    const { kv } = makeKv();
    const tags = Array.from({ length: MAX_HASHTAGS + 1 }, (_, i) => `tag${i}a`);
    const req = await authedRequest('PUT', {
      hashtags: tags,
      digest_hour: 8,
      digest_minute: 0,
      tz: 'UTC',
      model_id: VALID_MODEL_ID,
      email_enabled: true,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_hashtags' });
  });

  it('REQ-SET-002: deduplicates hashtags before storage', async () => {
    const { db, runCalls } = makeDb(baseRow());
    const { kv } = makeKv(['ai', 'llm']); // no discovery needed
    const req = await authedRequest('PUT', {
      hashtags: ['ai', 'ai', 'llm'],
      digest_hour: 8,
      digest_minute: 0,
      tz: 'UTC',
      model_id: VALID_MODEL_ID,
      email_enabled: true,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(200);
    const update = runCalls.find((c) => c.sql.startsWith('UPDATE users'));
    expect(update).toBeDefined();
    const stored = JSON.parse(update!.params[0] as string) as string[];
    expect(stored).toEqual(['ai', 'llm']);
  });

  it('REQ-SET-002: strips leading "#" and lowercases before persist', async () => {
    const { db, runCalls } = makeDb(baseRow());
    const { kv } = makeKv(['ai']);
    const req = await authedRequest('PUT', {
      hashtags: ['#AI'],
      digest_hour: 8,
      digest_minute: 0,
      tz: 'UTC',
      model_id: VALID_MODEL_ID,
      email_enabled: true,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(200);
    const update = runCalls.find((c) => c.sql.startsWith('UPDATE users'));
    const stored = JSON.parse(update!.params[0] as string) as string[];
    expect(stored).toEqual(['ai']);
  });

  it('REQ-SET-003: rejects digest_hour outside 0..23', async () => {
    const { db } = makeDb(baseRow());
    const { kv } = makeKv();
    const req = await authedRequest('PUT', {
      hashtags: ['ai'],
      digest_hour: 24,
      digest_minute: 0,
      tz: 'UTC',
      model_id: VALID_MODEL_ID,
      email_enabled: true,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_time' });
  });

  it('REQ-SET-003: rejects digest_minute outside 0..59', async () => {
    const { db } = makeDb(baseRow());
    const { kv } = makeKv();
    const req = await authedRequest('PUT', {
      hashtags: ['ai'],
      digest_hour: 8,
      digest_minute: 60,
      tz: 'UTC',
      model_id: VALID_MODEL_ID,
      email_enabled: true,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_time' });
  });

  it('REQ-SET-003: rejects non-integer digest_hour', async () => {
    const { db } = makeDb(baseRow());
    const { kv } = makeKv();
    const req = await authedRequest('PUT', {
      hashtags: ['ai'],
      digest_hour: 8.5,
      digest_minute: 0,
      tz: 'UTC',
      model_id: VALID_MODEL_ID,
      email_enabled: true,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_time' });
  });

  it('REQ-SET-003: rejects invalid IANA timezone', async () => {
    const { db } = makeDb(baseRow());
    const { kv } = makeKv();
    const req = await authedRequest('PUT', {
      hashtags: ['ai'],
      digest_hour: 8,
      digest_minute: 0,
      tz: 'Mars/Olympus_Mons',
      model_id: VALID_MODEL_ID,
      email_enabled: true,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_tz' });
  });

  it('REQ-SET-004: rejects model_id not in catalog with invalid_model_id', async () => {
    const { db } = makeDb(baseRow());
    const { kv } = makeKv();
    const req = await authedRequest('PUT', {
      hashtags: ['ai'],
      digest_hour: 8,
      digest_minute: 0,
      tz: 'UTC',
      model_id: '@cf/bogus/model',
      email_enabled: true,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_model_id' });
  });

  it('REQ-SET-005: rejects non-boolean email_enabled', async () => {
    const { db } = makeDb(baseRow());
    const { kv } = makeKv();
    const req = await authedRequest('PUT', {
      hashtags: ['ai'],
      digest_hour: 8,
      digest_minute: 0,
      tz: 'UTC',
      model_id: VALID_MODEL_ID,
      email_enabled: 1,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_email_enabled' });
  });

  it('REQ-SET-006: inserts pending_discoveries rows for tags missing from KV', async () => {
    const { db, batchCalls } = makeDb(baseRow());
    const { kv } = makeKv(['ai']); // `llm` and `mcp` are new
    const req = await authedRequest('PUT', {
      hashtags: ['ai', 'llm', 'mcp'],
      digest_hour: 8,
      digest_minute: 0,
      tz: 'UTC',
      model_id: VALID_MODEL_ID,
      email_enabled: true,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; discovering: string[] };
    expect(body.ok).toBe(true);
    expect(body.discovering.sort()).toEqual(['llm', 'mcp']);
    expect(batchCalls.length).toBe(1);
    const inserts = batchCalls[0]!;
    const inserted = inserts.map((s) => s.params[1]).sort();
    expect(inserted).toEqual(['llm', 'mcp']);
    // Every row bound with user_id=12345 as first arg.
    inserts.forEach((s) => expect(s.params[0]).toBe('12345'));
    // SQL uses INSERT OR IGNORE.
    inserts.forEach((s) => expect(s.sql).toContain('INSERT OR IGNORE'));
  });

  it('REQ-SET-001: persists all validated fields on a full successful save', async () => {
    const { db, runCalls } = makeDb(baseRow());
    const { kv } = makeKv(['ai']);
    const req = await authedRequest('PUT', {
      hashtags: ['ai'],
      digest_hour: 22,
      digest_minute: 30,
      tz: 'America/New_York',
      model_id: VALID_MODEL_ID,
      email_enabled: false,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(200);
    const update = runCalls.find((c) => c.sql.startsWith('UPDATE users'));
    expect(update).toBeDefined();
    // Binding order from the handler:
    //   hashtags_json, digest_hour, digest_minute, tz, model_id, email_enabled, id
    expect(update!.params[0]).toBe(JSON.stringify(['ai']));
    expect(update!.params[1]).toBe(22);
    expect(update!.params[2]).toBe(30);
    expect(update!.params[3]).toBe('America/New_York');
    expect(update!.params[4]).toBe(VALID_MODEL_ID);
    expect(update!.params[5]).toBe(0);
    expect(update!.params[6]).toBe('12345');
  });

  it('REQ-SET-001: returns 400 on non-JSON body', async () => {
    const { db } = makeDb(baseRow());
    const { kv } = makeKv();
    const headers = new Headers({
      'Content-Type': 'application/json',
      Origin: APP_ORIGIN,
    });
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      JWT_SECRET,
    );
    headers.set('Cookie', `${SESSION_COOKIE_NAME}=${token}`);
    const req = new Request(`${APP_URL}/api/settings`, {
      method: 'PUT',
      headers,
      body: 'not-json',
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'bad_request' });
  });

  it('REQ-SET-004: model_id POST still accepts stored preference (no regression when UI is re-enabled)', async () => {
    // The ModelSelect UI is hidden in Wave 2 (`showModelSelect = false`
    // in settings.astro), but the PUT handler must continue to accept
    // and persist a valid model_id so flipping the toggle back on is a
    // one-line change — not a DB migration. This test asserts that the
    // round-trip (receive valid model_id → persist to users.model_id)
    // still works unmodified.
    const { db, runCalls } = makeDb(baseRow());
    const { kv } = makeKv(['ai']);
    const STORED_MODEL_ID = '@cf/openai/gpt-oss-20b';
    const req = await authedRequest('PUT', {
      hashtags: ['ai'],
      digest_hour: 8,
      digest_minute: 0,
      tz: 'UTC',
      model_id: STORED_MODEL_ID,
      email_enabled: true,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(200);

    const update = runCalls.find((c) => c.sql.startsWith('UPDATE users'));
    expect(update).toBeDefined();
    // Binding order: hashtags_json, digest_hour, digest_minute, tz,
    // model_id, email_enabled, id. The persisted model_id is the 5th
    // param (index 4).
    expect(update!.params[4]).toBe(STORED_MODEL_ID);
  });

  it('REQ-SET-006: no discovery inserts when every tag already has sources', async () => {
    const { db, batchCalls } = makeDb(baseRow());
    const { kv } = makeKv(['ai', 'llm']);
    const req = await authedRequest('PUT', {
      hashtags: ['ai', 'llm'],
      digest_hour: 8,
      digest_minute: 0,
      tz: 'UTC',
      model_id: VALID_MODEL_ID,
      email_enabled: true,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { discovering: string[] };
    expect(body.discovering).toEqual([]);
    expect(batchCalls.length).toBe(0);
  });

  it('REQ-AUTH-001 AC 9 / CF-028: returns 429 when the per-user TAGS_MUTATION bucket is exhausted (PUT closes the bypass)', async () => {
    // PUT /api/settings is the alternative tag-mutation write path
    // alongside POST /api/tags*. The bucket counter is shared so a
    // client that drove POST /api/tags to the limit must also be
    // throttled when it switches to PUT /api/settings.
    const { db } = makeDb(baseRow());
    const kvStore = new Map<string, string>();
    const nowSec = Math.floor(Date.now() / 1000);
    const windowIndex = Math.floor(nowSec / 60);
    kvStore.set(`ratelimit:tags_mutation:user:12345:${windowIndex}`, '30');
    const kv = {
      get: vi.fn().mockImplementation(async (key: string) => kvStore.get(key) ?? null),
      put: vi.fn().mockImplementation(async (key: string, value: string) => {
        kvStore.set(key, value);
      }),
    } as unknown as KVNamespace;
    const req = await authedRequest('PUT', {
      hashtags: ['ai', 'llm'],
      digest_hour: 8,
      digest_minute: 0,
      tz: 'UTC',
      model_id: VALID_MODEL_ID,
      email_enabled: true,
    });
    const res = await PUT(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Native form-POST handler — REQ-SET-003. The settings page submits two
// <select> fields named `hour` and `minute` (replacing `<input type="time">`
// because the native time-input UI ignores `lang` and falls back to the
// device locale, breaking 24h display for en-US devices).
// ---------------------------------------------------------------------------

async function formPostRequest(
  fields: Record<string, string>,
  opts: AuthedRequestOpts = {},
): Promise<Request> {
  const headers = new Headers({
    'Content-Type': 'application/x-www-form-urlencoded',
  });
  if (typeof opts.origin === 'string') {
    headers.set('Origin', opts.origin);
  } else if (!('origin' in opts) || opts.origin === undefined) {
    headers.set('Origin', APP_ORIGIN);
  }
  if (opts.token !== null) {
    const token =
      opts.token ??
      (await signSession(
        { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
        JWT_SECRET,
      ));
    headers.set('Cookie', `${SESSION_COOKIE_NAME}=${token}`);
  }
  const body = new URLSearchParams(fields).toString();
  return new Request(`${APP_URL}/api/settings`, {
    method: 'POST',
    headers,
    body,
  });
}

describe('POST /api/settings (form-encoded fallback)', () => {
  it('REQ-SET-003: accepts hour + minute as separate <select> fields, persists 24h hour', async () => {
    const { db, runCalls } = makeDb(baseRow());
    const { kv } = makeKv(['ai', 'llm']);
    const req = await formPostRequest({
      hour: '14',
      minute: '30',
      tz: 'Europe/Zagreb',
      model_id: VALID_MODEL_ID,
      email_enabled: 'on',
    });
    const res = await POST(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/settings?saved=ok');

    const update = runCalls.find((c) => c.sql.startsWith('UPDATE users'));
    expect(update).toBeDefined();
    // POST handler binding order: digest_hour, digest_minute, tz,
    // model_id, email_enabled, id.
    expect(update!.params[0]).toBe(14);
    expect(update!.params[1]).toBe(30);
    expect(update!.params[2]).toBe('Europe/Zagreb');
  });

  it('REQ-SET-003: zero-padded `01` and `05` are parsed as hour=1, minute=5', async () => {
    const { db, runCalls } = makeDb(baseRow());
    const { kv } = makeKv(['ai', 'llm']);
    const req = await formPostRequest({
      hour: '01',
      minute: '05',
      tz: 'Europe/Zagreb',
      model_id: VALID_MODEL_ID,
      email_enabled: 'on',
    });
    const res = await POST(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(303);
    const update = runCalls.find((c) => c.sql.startsWith('UPDATE users'));
    expect(update!.params[0]).toBe(1);
    expect(update!.params[1]).toBe(5);
  });

  it('REQ-SET-003: hour+minute take precedence over legacy `time` when both are present', async () => {
    // The fresh UI submits hour+minute; if a stale page is mid-roll
    // and somehow ends up with both shapes, the fresh selects must
    // win. A regression that flipped the order would silently snap
    // saved times back to whatever the stale `time` field held.
    const { db, runCalls } = makeDb(baseRow());
    const { kv } = makeKv(['ai', 'llm']);
    const req = await formPostRequest({
      hour: '14',
      minute: '30',
      time: '07:00',
      tz: 'Europe/Zagreb',
      model_id: VALID_MODEL_ID,
    });
    const res = await POST(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(303);
    const update = runCalls.find((c) => c.sql.startsWith('UPDATE users'));
    expect(update!.params[0]).toBe(14);
    expect(update!.params[1]).toBe(30);
  });

  it('REQ-SET-003: empty-string hour+minute fall through to legacy `time` (M2)', async () => {
    // A stale page that submits both shapes with the new fields
    // empty (e.g. JS-disabled with stale markup) must NOT error
    // out — the legacy `time` parse is the right answer in that
    // case. Without this guard the user sees `invalid_time` for a
    // perfectly valid request.
    const { db, runCalls } = makeDb(baseRow());
    const { kv } = makeKv(['ai', 'llm']);
    const req = await formPostRequest({
      hour: '',
      minute: '',
      time: '07:45',
      tz: 'Europe/Zagreb',
      model_id: VALID_MODEL_ID,
    });
    const res = await POST(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/settings?saved=ok');
    const update = runCalls.find((c) => c.sql.startsWith('UPDATE users'));
    expect(update!.params[0]).toBe(7);
    expect(update!.params[1]).toBe(45);
  });

  it('REQ-SET-003: legacy `time=HH:MM` still works (back-compat for in-flight pages)', async () => {
    const { db, runCalls } = makeDb(baseRow());
    const { kv } = makeKv(['ai', 'llm']);
    const req = await formPostRequest({
      time: '07:45',
      tz: 'Europe/Zagreb',
      model_id: VALID_MODEL_ID,
    });
    const res = await POST(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(303);
    const update = runCalls.find((c) => c.sql.startsWith('UPDATE users'));
    expect(update!.params[0]).toBe(7);
    expect(update!.params[1]).toBe(45);
  });

  it('REQ-SET-003: out-of-range hour redirects with invalid_time', async () => {
    const { db } = makeDb(baseRow());
    const { kv } = makeKv(['ai', 'llm']);
    const req = await formPostRequest({
      hour: '24',
      minute: '00',
      tz: 'Europe/Zagreb',
      model_id: VALID_MODEL_ID,
    });
    const res = await POST(makeContext(req, env(db, kv)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toContain('error=invalid_time');
  });
});
