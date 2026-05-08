// Tests for the /api/admin/pipeline-run kicker — REQ-OPS-008.
//
// The endpoint creates a pipeline_runs audit row, enqueues exactly
// one pipeline-jobs message, and returns the new id. Coverage:
//   1. Default (mode='full') starts at scrape_kick.
//   2. mode='wipe' starts at reembed_flip.
//   3. Admin gate — request without session cookie → 401/403.

import { describe, it, expect, vi } from 'vitest';
import { POST } from '~/pages/api/admin/pipeline-run';
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
}

function makeDb(): { db: D1Database; calls: DbCalls } {
  const calls: DbCalls = { insertCalls: [] };
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const bound: unknown[] = [];
    const ops = {
      first: vi.fn().mockImplementation(async () => {
        if (sql.includes('FROM users')) return ADMIN_USER_ROW;
        return null;
      }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockImplementation(async () => {
        if (sql.includes('INSERT INTO pipeline_runs')) {
          calls.insertCalls.push({ sql, params: [...bound] });
        }
        return { success: true, meta: { changes: 1 } };
      }),
    };
    return {
      ...ops,
      bind: (...params: unknown[]) => {
        bound.push(...params);
        return ops;
      },
    } as unknown as D1PreparedStatement;
  });
  return {
    db: { prepare, batch: vi.fn() } as unknown as D1Database,
    calls,
  };
}

function makeQueue(): { queue: Queue; sends: Array<unknown> } {
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

async function callRoute(opts: {
  body?: object;
  authenticated?: boolean;
}): Promise<{
  res: Response;
  calls: DbCalls;
  sends: Array<unknown>;
}> {
  const { db, calls } = makeDb();
  const { queue, sends } = makeQueue();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (opts.authenticated !== false) {
    const cookie = await adminCookieJwt();
    headers['Cookie'] = `${SESSION_COOKIE_NAME}=${cookie}`;
  }
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: opts.body === undefined ? '' : JSON.stringify(opts.body),
  };
  const req = new Request(`${APP_URL}/api/admin/pipeline-run`, init);
  const env = {
    DB: db,
    PIPELINE_JOBS: queue,
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

describe('POST /api/admin/pipeline-run — REQ-OPS-008', () => {
  it('default body kicks a full-mode run starting at scrape_kick', async () => {
    const { res, calls, sends } = await callRoute({});
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      ok: boolean;
      pipeline_run_id: string;
      mode: string;
      current_phase: string;
    };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('full');
    expect(body.current_phase).toBe('scrape_kick');
    expect(typeof body.pipeline_run_id).toBe('string');
    expect(body.pipeline_run_id.length).toBeGreaterThan(20);

    expect(calls.insertCalls.length).toBe(1);
    const insertParams = calls.insertCalls[0]!.params;
    expect(insertParams[0]).toBe(body.pipeline_run_id);
    expect(insertParams[1]).toBe('full');
    expect(insertParams[2]).toBe('scrape_kick');

    expect(sends.length).toBe(1);
    expect(sends[0]).toEqual({
      pipeline_run_id: body.pipeline_run_id,
      phase: 'scrape_kick',
    });
  });

  it('mode=wipe kicks at reembed_flip phase', async () => {
    const { res, sends } = await callRoute({ body: { mode: 'wipe' } });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      ok: boolean;
      pipeline_run_id: string;
      mode: string;
      current_phase: string;
    };
    expect(body.mode).toBe('wipe');
    expect(body.current_phase).toBe('reembed_flip');
    expect(sends[0]).toEqual({
      pipeline_run_id: body.pipeline_run_id,
      phase: 'reembed_flip',
    });
  });

  it('rejects unauthenticated request', async () => {
    const { res } = await callRoute({ authenticated: false });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThanOrEqual(403);
  });
});
