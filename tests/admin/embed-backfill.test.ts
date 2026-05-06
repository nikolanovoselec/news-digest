// Tests for /api/admin/embed-backfill — REQ-PIPE-003.
//
// Coverage:
//   - empty corpus → done: true, processed: 0
//   - happy path → embed call + Vectorize.upsert + D1 status update,
//     remaining decremented
//   - embed failure → rows marked 'failed', processed: 0
//   - admin gate (CF-001) — guarded by requireAdminSession (covered by
//     middleware tests; this suite mocks an authed context)

import { describe, it, expect, vi } from 'vitest';
import { POST } from '~/pages/api/admin/embed-backfill';
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

interface PendingRow {
  id: string;
  title: string;
  details_json: string;
  source_snippet: string | null;
  published_at: number;
  primary_source_url: string;
}

interface DbFixture {
  pending: PendingRow[];
  remaining: number;
  /** Captured run() calls — for assertions on UPDATE statements. */
  runCalls: Array<{ sql: string; params: unknown[] }>;
  /** Captured batch() submissions. */
  batchCalls: Array<Array<{ sql: string; params: unknown[] }>>;
  /** Number of pending-SELECTs served so far. The handler's server-side
   *  loop calls SELECT once per batch; we serve the fixture's rows on
   *  the first call and an empty page after, so the loop terminates. */
  selectCalls: number;
}

function makeDb(fixture: DbFixture): D1Database {
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const bound: unknown[] = [];
    const ops = {
      first: vi.fn().mockImplementation(async () => {
        if (sql.includes('FROM users')) return ADMIN_USER_ROW;
        if (sql.includes('SELECT COUNT(*) AS c FROM articles')) {
          return { c: fixture.remaining };
        }
        return null;
      }),
      all: vi.fn().mockImplementation(async () => {
        if (sql.includes('SELECT id, title, details_json')) {
          const page = fixture.selectCalls === 0 ? fixture.pending : [];
          fixture.selectCalls += 1;
          return { results: page };
        }
        return { results: [] };
      }),
      run: vi.fn().mockImplementation(async () => {
        fixture.runCalls.push({ sql, params: [...bound] });
        return { success: true, meta: { changes: 1 } };
      }),
    };
    const stmt = {
      ...ops,
      bind: (...params: unknown[]) => {
        bound.push(...params);
        return ops;
      },
    };
    return stmt as unknown as D1PreparedStatement;
  });
  const batch = vi.fn().mockImplementation(async (statements: unknown[]) => {
    const stmts = statements.map((s) => {
      const cast = s as { sql?: string; params?: unknown[] };
      return { sql: cast.sql ?? '', params: cast.params ?? [] };
    });
    fixture.batchCalls.push(stmts);
    return [];
  });
  return { prepare, batch } as unknown as D1Database;
}

function makeAi(opts: { fail?: boolean } = {}): Ai {
  return {
    run: vi.fn().mockImplementation(async (model: string, params: { text: string[] }) => {
      if (opts.fail) throw new Error('AI binding offline');
      return {
        data: params.text.map(() => Array.from({ length: 768 }, (_, i) => i / 768)),
      };
    }),
  } as unknown as Ai;
}

function makeVectorize(opts: { fail?: boolean } = {}): Vectorize {
  return {
    upsert: vi.fn().mockImplementation(async () => {
      if (opts.fail) throw new Error('Vectorize backend offline');
      return { count: 0, ids: [] };
    }),
    query: vi.fn(),
    queryById: vi.fn(),
    deleteByIds: vi.fn(),
  } as unknown as Vectorize;
}

async function adminCookieJwt(): Promise<string> {
  return signSession(
    { sub: ADMIN_ID, email: ADMIN_EMAIL, ghl: 'admin', sv: 1 },
    SECRET,
  );
}

interface BuildContextOpts {
  pending: PendingRow[];
  remainingAfter: number;
  aiFails?: boolean;
  vectorizeFails?: boolean;
  reembed?: boolean;
}

async function buildContextAndCall(opts: BuildContextOpts): Promise<{
  res: Response;
  fixture: DbFixture;
  ai: Ai;
  vectorize: Vectorize;
}> {
  const fixture: DbFixture = {
    pending: opts.pending,
    remaining: opts.remainingAfter,
    runCalls: [],
    batchCalls: [],
    selectCalls: 0,
  };
  const db = makeDb(fixture);
  const ai = makeAi(opts.aiFails === true ? { fail: true } : {});
  const vectorize = makeVectorize(opts.vectorizeFails === true ? { fail: true } : {});
  const cookie = await adminCookieJwt();
  const url = `${APP_URL}/api/admin/embed-backfill${
    opts.reembed === true ? '?reembed=1' : ''
  }`;
  const req = new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
    },
  });
  const env = {
    DB: db,
    AI: ai,
    VECTORIZE: vectorize,
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
  return { res, fixture, ai, vectorize };
}

describe('POST /api/admin/embed-backfill — REQ-PIPE-003', () => {
  it('REQ-PIPE-003: empty corpus returns done:true and processed:0', async () => {
    const { res } = await buildContextAndCall({
      pending: [],
      remainingAfter: 0,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      processed: number;
      remaining: number;
      done: boolean;
    };
    expect(body.processed).toBe(0);
    expect(body.remaining).toBe(0);
    expect(body.done).toBe(true);
  });

  it('REQ-PIPE-003: happy path embeds, upserts, and stamps embedded_at', async () => {
    const { res, fixture, ai, vectorize } = await buildContextAndCall({
      pending: [
        {
          id: 'a-1',
          title: 'A',
          details_json: '["body of a"]',
          source_snippet: null,
          published_at: 1000,
          primary_source_url: 'https://x/a',
        },
        {
          id: 'a-2',
          title: 'B',
          details_json: '["body of b"]',
          source_snippet: 'raw scraped b',
          published_at: 1100,
          primary_source_url: 'https://x/b',
        },
      ],
      remainingAfter: 5,
    });
    const aiRun = ai.run as unknown as ReturnType<typeof vi.fn>;
    const upsert = vectorize.upsert as unknown as ReturnType<typeof vi.fn>;
    expect(res.status).toBe(200);
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    const upsertCall = upsert.mock.calls[0]![0] as Array<{
      id: string;
      values: number[];
    }>;
    expect(upsertCall.map((c) => c.id)).toEqual(['a-1', 'a-2']);
    // The status-update batch contains 2 UPDATE statements stamping
    // embedded_at + embedding_status='embedded'.
    expect(fixture.batchCalls.length).toBe(1);
    expect(fixture.batchCalls[0]!.length).toBe(2);
    const body = (await res.json()) as {
      processed: number;
      remaining: number;
      done: boolean;
    };
    // Server-side loop drains until remaining=0; the second SELECT
    // returns [] (mocked depletion), so the run completes in-request.
    expect(body.processed).toBe(2);
    expect(body.remaining).toBe(0);
    expect(body.done).toBe(true);
  });

  it('REQ-PIPE-003: AI failure marks rows as failed and reports processed:0', async () => {
    const { res, fixture } = await buildContextAndCall({
      pending: [
        {
          id: 'p-1',
          title: 'P',
          details_json: '["body p"]',
          source_snippet: null,
          published_at: 1000,
          primary_source_url: 'https://x/p',
        },
      ],
      remainingAfter: 1,
      aiFails: true,
    });
    const body = (await res.json()) as {
      processed: number;
      failed: number;
      remaining: number;
      done: boolean;
    };
    expect(res.status).toBe(200);
    expect(body.processed).toBe(0);
    expect(body.failed).toBe(1);
    // Forward-progress guard breaks on processed===0 (persistent AI
    // outage) so remaining stays at the failed-row count and done
    // is false — the operator clicks again to retry.
    expect(body.remaining).toBe(1);
    expect(body.done).toBe(false);
    // The recovery UPDATE setting embedding_status='failed' was issued.
    const failedUpdate = fixture.runCalls.find((c) =>
      c.sql.includes("embedding_status = 'failed'"),
    );
    expect(failedUpdate).toBeDefined();
  });

  it('REQ-PIPE-003 AC 12: ?reembed=1 flips every row to failed before the SELECT loop runs', async () => {
    const { res, fixture } = await buildContextAndCall({
      reembed: true,
      pending: [
        {
          id: 'r-1',
          title: 'R',
          details_json: '["body r"]',
          source_snippet: null,
          published_at: 3000,
          primary_source_url: 'https://x/r',
        },
      ],
      remainingAfter: 0,
    });
    expect(res.status).toBe(200);
    // The first issued UPDATE on the run is the unconditional re-embed
    // flip — captured in runCalls. SELECT/UPDATE for individual rows
    // come after.
    const reembedFlip = fixture.runCalls.find(
      (c) =>
        c.sql.includes("UPDATE articles SET embedding_status = 'failed'") &&
        !c.sql.includes('WHERE'),
    );
    expect(reembedFlip).toBeDefined();
  });

  it('REQ-PIPE-003: Vectorize upsert failure marks rows as failed', async () => {
    const { res, fixture } = await buildContextAndCall({
      pending: [
        {
          id: 'q-1',
          title: 'Q',
          details_json: '["body q"]',
          source_snippet: null,
          published_at: 2000,
          primary_source_url: 'https://x/q',
        },
      ],
      remainingAfter: 1,
      vectorizeFails: true,
    });
    const body = (await res.json()) as {
      processed: number;
      failed: number;
    };
    expect(res.status).toBe(200);
    expect(body.processed).toBe(0);
    expect(body.failed).toBe(1);
    const failedUpdate = fixture.runCalls.find((c) =>
      c.sql.includes("embedding_status = 'failed'"),
    );
    expect(failedUpdate).toBeDefined();
  });
});
