// Tests for src/worker.ts scheduled() — REQ-GEN-001 (cron dispatcher)
// + REQ-GEN-007 (stuck-digest sweeper).
//
// The cron handler runs three passes in order: sweeper, discovery
// processor, scheduling. These tests stub D1/KV/Queue/AI via vi.fn()
// and assert on the SQL executed and the messages enqueued.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import workerDefault, { scheduled } from '~/worker';

/** Recorded SQL execution — one entry per prepare().bind().run()/all(). */
interface SqlCall {
  sql: string;
  params: unknown[];
  kind: 'run' | 'all' | 'first';
}

/**
 * D1 stub. Takes a response-map keyed by a SQL-prefix matcher so a
 * single stub covers all three cron passes. Any SQL not matched falls
 * through to an empty result.
 */
function makeDb(responses: {
  updateDigestsResult?: { changes: number };
  distinctTzResults?: Array<{ tz: string }>;
  dueUsersResults?: Array<{ id: string }>;
  pendingDiscoveriesResults?: Array<{ tag: string }>;
}): { db: D1Database; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const makeStmtMethods = (sql: string, params: unknown[]) => ({
    run: vi.fn().mockImplementation(async () => {
      calls.push({ sql, params, kind: 'run' });
      if (sql.startsWith('UPDATE digests')) {
        return {
          success: true,
          meta: { changes: responses.updateDigestsResult?.changes ?? 0 },
        };
      }
      return { success: true, meta: { changes: 0 } };
    }),
    all: vi.fn().mockImplementation(async () => {
      calls.push({ sql, params, kind: 'all' });
      if (sql.includes('SELECT DISTINCT tz')) {
        return { success: true, results: responses.distinctTzResults ?? [] };
      }
      if (sql.includes('SELECT id FROM users')) {
        return { success: true, results: responses.dueUsersResults ?? [] };
      }
      if (sql.startsWith('SELECT tag FROM pending_discoveries')) {
        return {
          success: true,
          results: responses.pendingDiscoveriesResults ?? [],
        };
      }
      return { success: true, results: [] };
    }),
    first: vi.fn().mockImplementation(async () => {
      calls.push({ sql, params, kind: 'first' });
      return null;
    }),
  });
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const noBindMethods = makeStmtMethods(sql, []);
    return {
      ...noBindMethods,
      bind: (...params: unknown[]) => makeStmtMethods(sql, params),
    };
  });
  const db = { prepare } as unknown as D1Database;
  return { db, calls };
}

function makeKv(): KVNamespace {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
  } as unknown as KVNamespace;
}

interface QueueMock {
  queue: Queue<unknown>;
  sendBatchCalls: Array<Array<{ body: unknown }>>;
  sendCalls: unknown[];
}

function makeQueue(): QueueMock {
  const sendBatchCalls: Array<Array<{ body: unknown }>> = [];
  const sendCalls: unknown[] = [];
  const queue = {
    send: vi.fn().mockImplementation(async (body: unknown) => {
      sendCalls.push(body);
    }),
    sendBatch: vi
      .fn()
      .mockImplementation(async (messages: Array<{ body: unknown }>) => {
        sendBatchCalls.push(messages);
      }),
  } as unknown as Queue<unknown>;
  return { queue, sendBatchCalls, sendCalls };
}

function makeEnv(
  db: D1Database,
  kv: KVNamespace,
  queue: Queue<unknown>,
): Env {
  return {
    DB: db,
    KV: kv,
    DIGEST_JOBS: queue,
    AI: { run: vi.fn().mockResolvedValue({ response: '{"feeds":[]}' }) } as unknown as Ai,
    ASSETS: {} as Fetcher,
    OAUTH_CLIENT_ID: 'x',
    OAUTH_CLIENT_SECRET: 'x',
    OAUTH_JWT_SECRET: 'x',
    RESEND_API_KEY: 'x',
    RESEND_FROM: 'x',
    APP_URL: 'https://test.example.com',
  } as unknown as Env;
}

function makeController(): ScheduledController {
  return {
    scheduledTime: Date.now(),
    cron: '*/5 * * * *',
    noRetry: () => undefined,
  } as unknown as ScheduledController;
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: (_p: Promise<unknown>) => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
}

describe('scheduled() cron handler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('REQ-GEN-007: stuck-digest sweeper runs first with the 10-minute threshold', async () => {
    const { db, calls } = makeDb({ updateDigestsResult: { changes: 0 } });
    const kv = makeKv();
    const { queue } = makeQueue();
    const env = makeEnv(db, kv, queue);

    await scheduled(makeController(), env, makeCtx());

    const sweeper = calls.find(
      (c) => c.sql.startsWith('UPDATE digests') && c.kind === 'run',
    );
    expect(sweeper).toBeDefined();
    expect(sweeper!.sql).toContain("status = 'failed'");
    expect(sweeper!.sql).toContain("error_code = 'generation_stalled'");
    expect(sweeper!.sql).toContain("status = 'in_progress'");
    // The threshold parameter should be (now - 600).
    const nowSec = Math.floor(Date.now() / 1000);
    const threshold = sweeper!.params[0] as number;
    expect(threshold).toBeLessThanOrEqual(nowSec - 600);
    expect(threshold).toBeGreaterThanOrEqual(nowSec - 602);
  });

  it('REQ-GEN-007: sweeper failure aborts the cron — no scheduling queries run', async () => {
    // D1 that throws on UPDATE digests.
    const calls: SqlCall[] = [];
    const prepare = vi.fn().mockImplementation((sql: string) => ({
      bind: (..._params: unknown[]) => ({
        run: vi.fn().mockImplementation(async () => {
          calls.push({ sql, params: _params, kind: 'run' });
          if (sql.startsWith('UPDATE digests')) {
            throw new Error('d1 exploded');
          }
          return { success: true, meta: { changes: 0 } };
        }),
        all: vi.fn().mockResolvedValue({ success: true, results: [] }),
        first: vi.fn().mockResolvedValue(null),
      }),
    }));
    const db = { prepare } as unknown as D1Database;
    const kv = makeKv();
    const { queue, sendBatchCalls } = makeQueue();
    const env = makeEnv(db, kv, queue);

    await scheduled(makeController(), env, makeCtx());

    // Only the failing UPDATE digests call should exist.
    expect(calls.some((c) => c.sql.startsWith('SELECT DISTINCT tz'))).toBe(false);
    expect(sendBatchCalls).toHaveLength(0);
  });

  it('REQ-DISC-001: discovery processor is invoked after the sweeper', async () => {
    const { db, calls } = makeDb({
      updateDigestsResult: { changes: 0 },
      pendingDiscoveriesResults: [],
      distinctTzResults: [],
    });
    const kv = makeKv();
    const { queue } = makeQueue();
    const env = makeEnv(db, kv, queue);

    await scheduled(makeController(), env, makeCtx());

    // Should have queried pending_discoveries (the discovery processor).
    const discoveryQuery = calls.find((c) =>
      c.sql.startsWith('SELECT tag FROM pending_discoveries'),
    );
    expect(discoveryQuery).toBeDefined();

    // Sweeper came before it.
    const sweeperIdx = calls.findIndex((c) => c.sql.startsWith('UPDATE digests'));
    const discoveryIdx = calls.findIndex((c) =>
      c.sql.startsWith('SELECT tag FROM pending_discoveries'),
    );
    expect(sweeperIdx).toBeGreaterThanOrEqual(0);
    expect(discoveryIdx).toBeGreaterThanOrEqual(0);
    expect(sweeperIdx).toBeLessThan(discoveryIdx);
  });

  it('REQ-GEN-001: scheduling pass selects distinct tz then finds due users', async () => {
    const { db, calls } = makeDb({
      updateDigestsResult: { changes: 0 },
      pendingDiscoveriesResults: [],
      distinctTzResults: [{ tz: 'UTC' }],
      dueUsersResults: [{ id: 'u1' }, { id: 'u2' }],
    });
    const kv = makeKv();
    const { queue, sendBatchCalls } = makeQueue();
    const env = makeEnv(db, kv, queue);

    await scheduled(makeController(), env, makeCtx());

    // The distinct-tz query ran.
    expect(
      calls.find((c) => c.sql.includes('SELECT DISTINCT tz')),
    ).toBeDefined();

    // The due-users query ran.
    const dueUsers = calls.find((c) => c.sql.includes('SELECT id FROM users'));
    expect(dueUsers).toBeDefined();
    expect(dueUsers!.sql).toContain('hashtags_json IS NOT NULL');
    expect(dueUsers!.sql).toContain('digest_hour');
    expect(dueUsers!.sql).toContain('digest_minute');
    expect(dueUsers!.sql).toContain('last_generated_local_date');

    // sendBatch called once with two jobs.
    expect(sendBatchCalls).toHaveLength(1);
    expect(sendBatchCalls[0]).toHaveLength(2);
    const bodies = sendBatchCalls[0]!.map((m) => m.body) as Array<{
      trigger: string;
      user_id: string;
      local_date: string;
    }>;
    expect(bodies[0]!.trigger).toBe('scheduled');
    expect(bodies[0]!.user_id).toBe('u1');
    expect(bodies[1]!.user_id).toBe('u2');
    // local_date is YYYY-MM-DD.
    expect(bodies[0]!.local_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('REQ-GEN-001: enqueues nothing when no users are due', async () => {
    const { db } = makeDb({
      updateDigestsResult: { changes: 0 },
      pendingDiscoveriesResults: [],
      distinctTzResults: [{ tz: 'UTC' }],
      dueUsersResults: [],
    });
    const kv = makeKv();
    const { queue, sendBatchCalls } = makeQueue();
    const env = makeEnv(db, kv, queue);

    await scheduled(makeController(), env, makeCtx());
    expect(sendBatchCalls).toHaveLength(0);
  });

  it('REQ-GEN-001: window start/end are 5-minute-aligned half-open bounds', async () => {
    // Don't freeze time — just assert the shape of the bound params.
    // The window parameters are always [floor(m/5)*5, floor(m/5)*5+5).
    const { db, calls } = makeDb({
      updateDigestsResult: { changes: 0 },
      pendingDiscoveriesResults: [],
      distinctTzResults: [{ tz: 'UTC' }],
      dueUsersResults: [],
    });
    const kv = makeKv();
    const { queue } = makeQueue();
    const env = makeEnv(db, kv, queue);

    await scheduled(makeController(), env, makeCtx());

    const dueUsers = calls.find((c) => c.sql.includes('SELECT id FROM users'));
    expect(dueUsers).toBeDefined();
    // params: [tz, hour, windowStart, windowEnd, localDate]
    expect(dueUsers!.params[0]).toBe('UTC');
    expect(typeof dueUsers!.params[1]).toBe('number');
    expect(dueUsers!.params[1]).toBeGreaterThanOrEqual(0);
    expect(dueUsers!.params[1]).toBeLessThanOrEqual(23);
    const windowStart = dueUsers!.params[2] as number;
    const windowEnd = dueUsers!.params[3] as number;
    expect(windowStart % 5).toBe(0);
    expect(windowEnd - windowStart).toBe(5);
    expect(dueUsers!.params[4]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('REQ-GEN-001: enqueues across multiple timezones with a single sendBatch per chunk', async () => {
    const { db } = makeDb({
      updateDigestsResult: { changes: 0 },
      pendingDiscoveriesResults: [],
      distinctTzResults: [{ tz: 'UTC' }, { tz: 'America/New_York' }],
      dueUsersResults: [{ id: 'u1' }],
    });
    const kv = makeKv();
    const { queue, sendBatchCalls } = makeQueue();
    const env = makeEnv(db, kv, queue);

    await scheduled(makeController(), env, makeCtx());

    // Both tzs yielded u1 via the same stubbed dueUsersResults — two
    // total messages in one sendBatch.
    expect(sendBatchCalls.length).toBeGreaterThanOrEqual(1);
    const total = sendBatchCalls.reduce((acc, b) => acc + b.length, 0);
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it('worker.ts default export has scheduled, queue, fetch handlers', () => {
    expect(typeof workerDefault.scheduled).toBe('function');
    expect(typeof workerDefault.queue).toBe('function');
    expect(typeof workerDefault.fetch).toBe('function');
  });
});
