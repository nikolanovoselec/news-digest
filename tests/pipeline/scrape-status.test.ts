// Tests for src/pages/api/scrape-status.ts — REQ-PIPE-006 AC 5.
//
// The endpoint drives the dashboard's "Update in progress…" label
// and the settings Force Refresh progress line. Contract:
//   - idle (no run OR last run is ready/failed) → { running: false }
//   - running → { running: true, id, started_at, chunks_remaining,
//                 chunks_total, articles_ingested }
// The body is JSON; 401 when no session; 200 otherwise.

import { describe, it, expect, vi } from 'vitest';
import { GET } from '~/pages/api/scrape-status';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';
import { signSession } from '~/lib/session-jwt';

const JWT_SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';

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

interface RunRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  chunk_count: number | null;
  articles_ingested: number | null;
}

function baseUser(): UserRow {
  return {
    id: 'u1',
    email: 'u1@example.com',
    gh_login: 'u1',
    tz: 'UTC',
    digest_hour: 8,
    digest_minute: 0,
    hashtags_json: JSON.stringify(['generative-ai']),
    model_id: null,
    email_enabled: 1,
    session_version: 1,
  };
}

/** Stub D1 returning the supplied user row for the session SELECT and
 *  the supplied scrape_runs row for the status SELECT. */
function makeDb(user: UserRow | null, run: RunRow | null): D1Database {
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const stmt = {
      bind: (..._params: unknown[]) => stmt,
      first: vi.fn().mockImplementation(async () => {
        if (sql.includes('FROM users')) return user;
        if (sql.includes('FROM scrape_runs')) return run;
        return null;
      }),
      all: vi.fn().mockResolvedValue({ success: true, results: [] }),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
    };
    return stmt;
  });
  return { prepare } as unknown as D1Database;
}

/** Stub KV returning the supplied counter string for the
 *  chunks_remaining lookup. */
function makeKv(counter: string | null): KVNamespace {
  return {
    get: vi.fn().mockImplementation(async () => counter),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
  } as unknown as KVNamespace;
}

function envFrom(db: D1Database, kv: KVNamespace): Partial<Env> {
  return {
    OAUTH_JWT_SECRET: JWT_SECRET,
    DB: db,
    KV: kv,
    APP_URL: 'https://test.example.com',
  };
}

function makeContext(request: Request, env: Partial<Env>): unknown {
  return {
    request,
    locals: { runtime: { env: env as Env } },
    url: new URL(request.url),
  };
}

async function authedRequest(): Promise<Request> {
  const token = await signSession(
    { sub: 'u1', email: 'u1@example.com', ghl: 'u1', sv: 1 },
    JWT_SECRET,
  );
  return new Request('https://test.example.com/api/scrape-status', {
    method: 'GET',
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

describe('GET /api/scrape-status — REQ-PIPE-006 AC 5', () => {
  it('REQ-PIPE-006: returns 401 when no session cookie is present', async () => {
    const req = new Request('https://test.example.com/api/scrape-status');
    const res = await GET(
      makeContext(req, envFrom(makeDb(null, null), makeKv(null))) as never,
    );
    expect(res.status).toBe(401);
  });

  it('REQ-PIPE-006: returns { running: false } when there is no scrape_runs row at all', async () => {
    const res = await GET(
      makeContext(
        await authedRequest(),
        envFrom(makeDb(baseUser(), null), makeKv(null)),
      ) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { running: boolean };
    expect(body.running).toBe(false);
  });

  it('REQ-PIPE-006: returns { running: false } when the most recent run is ready', async () => {
    const run: RunRow = {
      id: 'r1',
      started_at: 1_000_000,
      finished_at: 1_000_060,
      status: 'ready',
      chunk_count: 10,
      articles_ingested: 50,
    };
    const res = await GET(
      makeContext(
        await authedRequest(),
        envFrom(makeDb(baseUser(), run), makeKv('0')),
      ) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { running: boolean };
    expect(body.running).toBe(false);
  });

  it('REQ-PIPE-006: returns in-flight fields (id, started_at, chunks_remaining, chunks_total, articles_ingested) when a run is running', async () => {
    const run: RunRow = {
      id: 'r2',
      started_at: 1_111_111,
      finished_at: null,
      status: 'running',
      chunk_count: 12,
      articles_ingested: 27,
    };
    const res = await GET(
      makeContext(
        await authedRequest(),
        envFrom(makeDb(baseUser(), run), makeKv('5')),
      ) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      running: boolean;
      id: string;
      started_at: number;
      chunks_remaining: number;
      chunks_total: number;
      articles_ingested: number;
    };
    expect(body.running).toBe(true);
    expect(body.id).toBe('r2');
    expect(body.started_at).toBe(1_111_111);
    expect(body.chunks_remaining).toBe(5);
    expect(body.chunks_total).toBe(12);
    expect(body.articles_ingested).toBe(27);
  });

  it('REQ-PIPE-006: falls back to null chunks_remaining when the KV counter is missing', async () => {
    const run: RunRow = {
      id: 'r3',
      started_at: 1_222_222,
      finished_at: null,
      status: 'running',
      chunk_count: 3,
      articles_ingested: 0,
    };
    const res = await GET(
      makeContext(
        await authedRequest(),
        envFrom(makeDb(baseUser(), run), makeKv(null)),
      ) as never,
    );
    const body = (await res.json()) as { chunks_remaining: number | null };
    expect(body.chunks_remaining).toBeNull();
  });

  it('REQ-PIPE-006: null chunks_total when the coordinator hasn\'t written chunk_count yet (0 or absent)', async () => {
    const run: RunRow = {
      id: 'r4',
      started_at: 1_333_333,
      finished_at: null,
      status: 'running',
      chunk_count: null,
      articles_ingested: 0,
    };
    const res = await GET(
      makeContext(
        await authedRequest(),
        envFrom(makeDb(baseUser(), run), makeKv(null)),
      ) as never,
    );
    const body = (await res.json()) as { chunks_total: number | null };
    expect(body.chunks_total).toBeNull();
  });
});
