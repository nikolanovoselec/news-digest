// Tests for src/pages/api/digest/refresh.ts — REQ-GEN-002.
//
// Covers:
//   - Origin check (REQ-AUTH-003)
//   - Session requirement
//   - 429 on rate-limit rejection (cooldown + daily cap)
//   - 409 on already-in-progress
//   - Enqueue + 202 on success

import { describe, it, expect, vi } from 'vitest';
import { POST } from '~/pages/api/digest/refresh';
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

function baseRow(): UserRow {
  return {
    id: 'user-1',
    email: 'alice@b.c',
    gh_login: 'alice',
    tz: 'UTC',
    digest_hour: 8,
    digest_minute: 0,
    hashtags_json: JSON.stringify(['ai']),
    model_id: VALID_MODEL_ID,
    email_enabled: 1,
    session_version: 1,
  };
}

interface DbResponses {
  /** Rows returned from the atomic UPDATE ... RETURNING. Empty = rate-
   *  limited. One row = accepted. */
  rateLimitRows?: Array<{ refresh_count_24h: number }>;
  /** Row returned when the route re-reads to compute retry_after. */
  rateStateRow?: {
    last_refresh_at: number | null;
    refresh_window_start: number;
    refresh_count_24h: number;
  } | null;
  /** changes returned by the conditional INSERT INTO digests. */
  digestInsertChanges?: number;
}

function makeDb(userRow: UserRow | null, responses: DbResponses = {}): {
  db: D1Database;
  runCalls: { sql: string; params: unknown[] }[];
} {
  const runCalls: { sql: string; params: unknown[] }[] = [];
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: (...params: unknown[]) => ({
      first: vi.fn().mockImplementation(async () => {
        if (sql.startsWith('SELECT id, email, gh_login')) return userRow;
        if (sql.startsWith('SELECT last_refresh_at')) {
          return responses.rateStateRow ?? null;
        }
        return null;
      }),
      run: vi.fn().mockImplementation(async () => {
        runCalls.push({ sql, params });
        if (sql.startsWith('INSERT INTO digests')) {
          return {
            success: true,
            meta: { changes: responses.digestInsertChanges ?? 1 },
          };
        }
        return { success: true, meta: { changes: 0 } };
      }),
      all: vi.fn().mockImplementation(async () => {
        runCalls.push({ sql, params });
        if (sql.startsWith('UPDATE users SET')) {
          return {
            success: true,
            results: responses.rateLimitRows ?? [{ refresh_count_24h: 1 }],
          };
        }
        return { success: true, results: [] };
      }),
    }),
  }));
  const db = { prepare } as unknown as D1Database;
  return { db, runCalls };
}

function makeQueue(): { queue: Queue<unknown>; sent: unknown[] } {
  const sent: unknown[] = [];
  const queue = {
    send: vi.fn().mockImplementation(async (msg: unknown) => {
      sent.push(msg);
    }),
    sendBatch: vi.fn(),
  } as unknown as Queue<unknown>;
  return { queue, sent };
}

function makeEnv(db: D1Database, queue: Queue<unknown>): Partial<Env> {
  return {
    APP_URL,
    OAUTH_JWT_SECRET: JWT_SECRET,
    DB: db,
    KV: { get: vi.fn(), put: vi.fn() } as unknown as KVNamespace,
    DIGEST_JOBS: queue,
  };
}

function makeContext(request: Request, e: Partial<Env>): unknown {
  return {
    request,
    locals: { runtime: { env: e as Env } },
    url: new URL(request.url),
    params: {},
  };
}

async function refreshRequest(options: {
  origin?: string | null;
  cookie?: string | null;
} = {}): Promise<Request> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (options.origin !== null && options.origin !== undefined) {
    headers.set('Origin', options.origin);
  }
  if (options.cookie !== null && options.cookie !== undefined) {
    headers.set('Cookie', options.cookie);
  }
  return new Request(`${APP_URL}/api/digest/refresh`, {
    method: 'POST',
    headers,
  });
}

async function validSessionCookie(): Promise<string> {
  const token = await signSession(
    { sub: 'user-1', email: 'a@b.c', ghl: 'alice', sv: 1 },
    JWT_SECRET,
  );
  return `${SESSION_COOKIE_NAME}=${token}`;
}

describe('POST /api/digest/refresh', () => {
  it('REQ-AUTH-003: rejects request with missing Origin', async () => {
    const { db } = makeDb(baseRow());
    const { queue } = makeQueue();
    const req = await refreshRequest({ origin: null });
    const res = await POST(makeContext(req, makeEnv(db, queue)) as never);
    expect(res.status).toBe(403);
  });

  it('REQ-GEN-002: returns 401 without a session', async () => {
    const { db } = makeDb(baseRow());
    const { queue } = makeQueue();
    const req = await refreshRequest({ origin: APP_ORIGIN });
    const res = await POST(makeContext(req, makeEnv(db, queue)) as never);
    expect(res.status).toBe(401);
  });

  it('REQ-GEN-002: 429 rate_limited when the conditional UPDATE returns 0 rows (cooldown)', async () => {
    const cookie = await validSessionCookie();
    const now = Math.floor(Date.now() / 1000);
    const { db } = makeDb(baseRow(), {
      rateLimitRows: [], // rejected
      rateStateRow: {
        last_refresh_at: now - 60, // 1 min ago → cooldown hits
        refresh_window_start: now - 60,
        refresh_count_24h: 3,
      },
    });
    const { queue } = makeQueue();
    const req = await refreshRequest({ origin: APP_ORIGIN, cookie });
    const res = await POST(makeContext(req, makeEnv(db, queue)) as never);
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      code: string;
      retry_after_seconds: number;
      reason: string;
    };
    expect(body.code).toBe('rate_limited');
    expect(body.reason).toBe('cooldown');
    expect(body.retry_after_seconds).toBeGreaterThan(0);
    expect(body.retry_after_seconds).toBeLessThanOrEqual(300);
  });

  it('REQ-GEN-002: 429 rate_limited with daily_cap reason when 10/24h is reached', async () => {
    const cookie = await validSessionCookie();
    const now = Math.floor(Date.now() / 1000);
    const { db } = makeDb(baseRow(), {
      rateLimitRows: [],
      rateStateRow: {
        last_refresh_at: now - 600, // cooldown already past
        refresh_window_start: now - 1000, // early in 24h window
        refresh_count_24h: 100, // cap reached (matches DAILY_CAP in refresh.ts)
      },
    });
    const { queue } = makeQueue();
    const req = await refreshRequest({ origin: APP_ORIGIN, cookie });
    const res = await POST(makeContext(req, makeEnv(db, queue)) as never);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe('daily_cap');
  });

  it('REQ-GEN-002: 409 already_in_progress when conditional INSERT affects 0 rows', async () => {
    const cookie = await validSessionCookie();
    const { db } = makeDb(baseRow(), {
      rateLimitRows: [{ refresh_count_24h: 1 }],
      digestInsertChanges: 0,
    });
    const { queue, sent } = makeQueue();
    const req = await refreshRequest({ origin: APP_ORIGIN, cookie });
    const res = await POST(makeContext(req, makeEnv(db, queue)) as never);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('already_in_progress');
    expect(sent).toHaveLength(0);
  });

  it('REQ-GEN-002: happy path enqueues manual message and returns 202 with digest_id', async () => {
    const cookie = await validSessionCookie();
    const { db, runCalls } = makeDb(baseRow(), {
      rateLimitRows: [{ refresh_count_24h: 1 }],
      digestInsertChanges: 1,
    });
    const { queue, sent } = makeQueue();
    const req = await refreshRequest({ origin: APP_ORIGIN, cookie });
    const res = await POST(makeContext(req, makeEnv(db, queue)) as never);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { digest_id: string; status: string };
    expect(typeof body.digest_id).toBe('string');
    expect(body.digest_id.length).toBeGreaterThan(0);
    expect(body.status).toBe('in_progress');

    // Exactly one queue message of trigger=manual.
    expect(sent).toHaveLength(1);
    const msg = sent[0] as {
      trigger: string;
      user_id: string;
      local_date: string;
      digest_id: string;
    };
    expect(msg.trigger).toBe('manual');
    expect(msg.user_id).toBe('user-1');
    expect(msg.digest_id).toBe(body.digest_id);
    expect(msg.local_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The INSERT uses the conditional NOT EXISTS guard.
    const insert = runCalls.find((c) => c.sql.startsWith('INSERT INTO digests'));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain('NOT EXISTS');
    // ...and status='in_progress' trigger='manual'.
    expect(insert!.sql).toContain("'in_progress'");
    expect(insert!.sql).toContain("'manual'");
  });

  it('REQ-GEN-002: the rate-limit UPDATE binds the cooldown + daily-cap params', async () => {
    const cookie = await validSessionCookie();
    const { db, runCalls } = makeDb(baseRow(), {
      rateLimitRows: [{ refresh_count_24h: 1 }],
      digestInsertChanges: 1,
    });
    const { queue } = makeQueue();
    const req = await refreshRequest({ origin: APP_ORIGIN, cookie });
    await POST(makeContext(req, makeEnv(db, queue)) as never);

    const rateUpdate = runCalls.find((c) => c.sql.startsWith('UPDATE users SET'));
    expect(rateUpdate).toBeDefined();
    // params order in refresh.ts: [nowSec, WINDOW_SECONDS, userId, COOLDOWN_SECONDS, DAILY_CAP]
    expect(rateUpdate!.params[1]).toBe(86_400);
    expect(rateUpdate!.params[2]).toBe('user-1');
    expect(rateUpdate!.params[3]).toBe(30);
    expect(rateUpdate!.params[4]).toBe(100);
  });
});
