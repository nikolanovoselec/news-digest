// Tests for the /api/admin/historical-dedup kicker — REQ-PIPE-003 AC 9.
//
// The endpoint is now a queue-driven sweep kicker rather than the body
// of the per-batch loop. The per-batch logic lives in
// src/lib/historical-dedup.ts and is covered by
// tests/lib/historical-dedup-batch.test.ts. The queue consumer that
// drives the loop without an open browser tab is covered by
// tests/queue/dedup-sweep-consumer.test.ts.
//
// What this test file covers:
//   1. Empty body POST → INSERTs a dedup_runs row, sends ONE message
//      to DEDUP_SWEEP, returns 202 + run_id (the new background-run
//      contract).
//   2. JSON body with cursor/batch → runs ONE synchronous batch and
//      returns the per-batch JSON shape (backwards-compat for scripted
//      callers / dev-bypass curl flows).
//   3. Browser HTML form post (no Accept header) → 303 redirect to
//      /settings?dedup=enqueued&run_id=… (queue-driven path) so the
//      JS in /settings can wire status polling on the redirect.
//   4. Admin gate — request without session cookie → 401/403.

import { describe, it, expect, vi } from 'vitest';
import { POST } from '~/pages/api/admin/historical-dedup';
import { signSession } from '~/lib/session-jwt';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';

const APP_URL = 'https://test.example.com';
const SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_ID = 'admin-user-id';

const ADMIN_USER_ROW = {
  id: ADMIN_ID,
  email: ADMIN_EMAIL,
  gh_login: 'admin',
  tz: 'UTC',
  digest_hour: null as number | null,
  digest_minute: 0,
  hashtags_json: null as string | null,
  model_id: null as string | null,
  email_enabled: 1,
  session_version: 1,
};

interface DbCalls {
  insertCalls: Array<{ sql: string; params: unknown[] }>;
  selectCalls: Array<{ sql: string; params: unknown[] }>;
  updateCalls: Array<{ sql: string; params: unknown[] }>;
}

function makeDb(): { db: D1Database; calls: DbCalls } {
  const calls: DbCalls = {
    insertCalls: [],
    selectCalls: [],
    updateCalls: [],
  };
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const bound: unknown[] = [];
    const ops = {
      first: vi.fn().mockImplementation(async () => {
        if (sql.includes('FROM users')) return ADMIN_USER_ROW;
        return null;
      }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockImplementation(async () => {
        if (sql.includes('INSERT INTO dedup_runs')) {
          calls.insertCalls.push({ sql, params: [...bound] });
        } else if (sql.includes('UPDATE dedup_runs')) {
          calls.updateCalls.push({ sql, params: [...bound] });
        }
        return { success: true, meta: { changes: 1 } };
      }),
    };
    const stmt = {
      ...ops,
      bind: (...params: unknown[]) => {
        bound.push(...params);
        return { ...ops, sql, params };
      },
    };
    return stmt as unknown as D1PreparedStatement;
  });
  return {
    db: { prepare, batch: vi.fn() } as unknown as D1Database,
    calls,
  };
}

interface QueueSends {
  sends: Array<unknown>;
}

function makeQueue(): { queue: Queue; sends: QueueSends['sends'] } {
  const sends: unknown[] = [];
  const queue = {
    send: vi.fn().mockImplementation(async (msg: unknown) => {
      sends.push(msg);
    }),
    sendBatch: vi.fn(),
  } as unknown as Queue;
  return { queue, sends };
}

async function adminCookieJwt(): Promise<string> {
  return signSession(
    { sub: ADMIN_ID, email: ADMIN_EMAIL, ghl: 'admin', sv: 1 },
    SECRET,
  );
}

interface CallOpts {
  body?: object | string;
  acceptJson?: boolean;
  authenticated?: boolean;
  contentType?: string;
}

async function callRoute(opts: CallOpts) {
  const { db, calls } = makeDb();
  const { queue, sends } = makeQueue();
  const headers: Record<string, string> = {};
  if (opts.contentType !== undefined) {
    headers['Content-Type'] = opts.contentType;
  }
  if (opts.acceptJson === true) {
    headers['Accept'] = 'application/json';
    if (opts.contentType === undefined) {
      headers['Content-Type'] = 'application/json';
    }
  }
  if (opts.authenticated !== false) {
    const cookie = await adminCookieJwt();
    headers['Cookie'] = `${SESSION_COOKIE_NAME}=${cookie}`;
    // CF-015: defence-in-depth Origin check requires a matching
    // origin on browser-driven POSTs. Browser-cookie callers carry
    // an Origin; set it to APP_URL so the gate passes for the
    // happy-path tests. Negative-Origin coverage lives in dedicated
    // tests below.
    headers['Origin'] = APP_URL;
  }
  const init: RequestInit = { method: 'POST', headers };
  if (opts.body !== undefined) {
    init.body =
      typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const req = new Request(`${APP_URL}/api/admin/historical-dedup`, init);
  const env = {
    DB: db,
    VECTORIZE: {
      queryById: vi.fn().mockResolvedValue({ count: 0, matches: [] }),
      deleteByIds: vi.fn().mockResolvedValue({ count: 0, ids: [] }),
      query: vi.fn(),
      upsert: vi.fn(),
    } as unknown as Vectorize,
    AI: { run: vi.fn() },
    DEDUP_SWEEP: queue,
    OAUTH_JWT_SECRET: SECRET,
    ADMIN_EMAIL,
    APP_URL,
  } as unknown as Env;
  const context = {
    request: req,
    locals: { runtime: { env } },
    url: new URL(req.url),
    params: {},
  } as never;
  const res = await POST(context);
  return { res, calls, sends };
}

describe('POST /api/admin/historical-dedup — REQ-PIPE-014 operator sweep kicker', () => {
  it('REQ-PIPE-003 AC 9: empty JSON body enqueues a sweep and returns 202 with run_id', async () => {
    const { res, calls, sends } = await callRoute({ acceptJson: true });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      ok: boolean;
      run_id: string;
      enqueued: boolean;
      started_at: number;
    };
    expect(body.ok).toBe(true);
    expect(body.enqueued).toBe(true);
    expect(typeof body.run_id).toBe('string');
    expect(body.run_id.length).toBeGreaterThan(20); // ULID
    expect(typeof body.started_at).toBe('number');

    // Audit row inserted with status='running'
    expect(calls.insertCalls.length).toBe(1);
    const insertSql = calls.insertCalls[0]!.sql;
    expect(insertSql).toContain('INSERT INTO dedup_runs');
    expect(insertSql).toContain("'running'");
    // First bound param is the run_id
    expect(calls.insertCalls[0]!.params[0]).toBe(body.run_id);

    // Exactly one queue message dispatched, cursor=null
    expect(sends.length).toBe(1);
    expect(sends[0]).toEqual({
      run_id: body.run_id,
      cursor: null,
      batch: 25,
    });
  });

  it('REQ-PIPE-003 AC 9: JSON body with cursor runs synchronous single batch (back-compat)', async () => {
    const { res, calls, sends } = await callRoute({
      acceptJson: true,
      body: { cursor: { pa: 1_700_000_000, id: '01ABC' }, batch: 5 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      scanned: number;
      merged: number;
      done: boolean;
      next_cursor: unknown;
      elapsed_ms: number;
    };
    expect(body.ok).toBe(true);
    expect(body.scanned).toBe(0);
    expect(body.merged).toBe(0);
    expect(body.done).toBe(true);
    expect(body.next_cursor).toBeNull();
    // No row inserted, no queue send — synchronous path is the
    // back-compat shape and does not start a tracked run
    expect(calls.insertCalls.length).toBe(0);
    expect(sends.length).toBe(0);
  });

  it('REQ-PIPE-003 AC 9: browser HTML form post 303-redirects to /settings?dedup=enqueued', async () => {
    // No Accept header — emulates the plain-form-post browser flow.
    const { res, sends } = await callRoute({
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(res.status).toBe(303);
    const location = res.headers.get('Location') ?? '';
    expect(location).toContain('/settings?dedup=enqueued');
    expect(location).toContain('run_id=');
    // Queue still got the send so the sweep is in-flight.
    expect(sends.length).toBe(1);
  });

  it('REQ-AUTH-001: unauthenticated request is rejected with 401 or 403', async () => {
    const { res, calls, sends } = await callRoute({
      acceptJson: true,
      authenticated: false,
    });
    expect([401, 403]).toContain(res.status);
    // No audit row inserted, no queue send
    expect(calls.insertCalls.length).toBe(0);
    expect(sends.length).toBe(0);
  });

  it('REQ-PIPE-003 AC 9: kick handles queue.send failure by flipping audit row to failed', async () => {
    // Build env with a queue that throws on .send to simulate a
    // platform outage at enqueue time. The audit row is inserted
    // before the send, so the kicker must catch and flip status to
    // 'failed' so the operator sees a clean error instead of a row
    // permanently stuck in 'running'.
    const { db, calls } = makeDb();
    const queue = {
      send: vi.fn().mockRejectedValue(new Error('queue unavailable')),
      sendBatch: vi.fn(),
    } as unknown as Queue;
    const cookie = await adminCookieJwt();
    const req = new Request(`${APP_URL}/api/admin/historical-dedup`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
        Origin: APP_URL,
      },
    });
    const env = {
      DB: db,
      DEDUP_SWEEP: queue,
      OAUTH_JWT_SECRET: SECRET,
      ADMIN_EMAIL,
      APP_URL,
    } as unknown as Env;
    const context = {
      request: req,
      locals: { runtime: { env } },
      url: new URL(req.url),
      params: {},
    } as never;
    const res = await POST(context);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('historical_dedup_kick_failed');

    // Insert happened, then queue.send threw, then audit row flipped
    // to 'failed'.
    expect(calls.insertCalls.length).toBe(1);
    expect(calls.updateCalls.length).toBe(1);
    const updateSql = calls.updateCalls[0]!.sql;
    expect(updateSql).toContain("status = 'failed'");
  });
});
