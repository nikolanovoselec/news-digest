// Tests for src/worker.ts scheduled() — REQ-PIPE-001 / REQ-PIPE-005 /
// REQ-DISC-003 / REQ-MAIL-001.
//
// The cron dispatcher branches on `controller.cron`:
//   - `0 * * * *`   → starts a scrape_run and enqueues SCRAPE_COORDINATOR.
//   - `0 3 * * *`   → runs cleanup (REQ-PIPE-005).
//   - `*/5 * * * *` → discovery drain + daily-email dispatcher (per-user
//                     digest enqueue is retired).
//
// These tests stub D1, KV, and the queue producers, then drive the
// `scheduled` export with the relevant controller.cron value.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import workerDefault, { scheduled } from '~/worker';

/** Recorded SQL execution — one entry per prepare().bind().run()/all(). */
interface SqlCall {
  sql: string;
  params: unknown[];
  kind: 'run' | 'all' | 'first';
}

function makeDb(responses: {
  pendingDiscoveriesResults?: Array<{ tag: string }>;
} = {}): { db: D1Database; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const makeStmtMethods = (sql: string, params: unknown[]) => ({
    run: vi.fn().mockImplementation(async () => {
      calls.push({ sql, params, kind: 'run' });
      return { success: true, meta: { changes: 1 } };
    }),
    all: vi.fn().mockImplementation(async () => {
      calls.push({ sql, params, kind: 'all' });
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
  const db = {
    prepare,
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
  } as unknown as D1Database;
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
  sendCalls: unknown[];
  sendBatchCalls: Array<Array<{ body: unknown }>>;
}

function makeQueue(): QueueMock {
  const sendCalls: unknown[] = [];
  const sendBatchCalls: Array<Array<{ body: unknown }>> = [];
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
  return { queue, sendCalls, sendBatchCalls };
}

function makeEnv(
  db: D1Database,
  kv: KVNamespace,
  coordinator: Queue<unknown>,
  chunks: Queue<unknown>,
  digestJobs: Queue<unknown>,
): Env {
  return {
    DB: db,
    KV: kv,
    SCRAPE_COORDINATOR: coordinator,
    SCRAPE_CHUNKS: chunks,
    DIGEST_JOBS: digestJobs,
    AI: {
      run: vi.fn().mockResolvedValue({ response: '{"feeds":[]}' }),
    } as unknown as Ai,
    ASSETS: {} as Fetcher,
    OAUTH_CLIENT_ID: 'x',
    OAUTH_CLIENT_SECRET: 'x',
    OAUTH_JWT_SECRET: 'x',
    RESEND_API_KEY: 'x',
    RESEND_FROM: 'x',
    APP_URL: 'https://test.example.com',
  } as unknown as Env;
}

function makeController(cron: string): ScheduledController {
  return {
    scheduledTime: Date.now(),
    cron,
    noRetry: () => undefined,
  } as unknown as ScheduledController;
}

function makeCtx(): {
  ctx: ExecutionContext;
  waitUntils: Array<Promise<unknown>>;
} {
  const waitUntils: Array<Promise<unknown>> = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waitUntils.push(p);
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return { ctx, waitUntils };
}

describe('cron dispatch — REQ-PIPE-001 / REQ-PIPE-005', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('REQ-PIPE-001: cron "0 * * * *" starts a scrape_run and sends a SCRAPE_COORDINATOR message', async () => {
    const { db, calls } = makeDb();
    const kv = makeKv();
    const coordinator = makeQueue();
    const chunks = makeQueue();
    const digestJobs = makeQueue();
    const env = makeEnv(db, kv, coordinator.queue, chunks.queue, digestJobs.queue);
    const { ctx, waitUntils } = makeCtx();
    await scheduled(makeController('0 * * * *'), env, ctx);
    // Wait for any queue sends the handler deferred to waitUntil.
    await Promise.all(waitUntils);

    // A scrape_runs INSERT must have happened.
    const insert = calls.find(
      (c) => c.sql.includes('INSERT INTO scrape_runs') && c.kind === 'run',
    );
    expect(insert).toBeDefined();
    // And exactly one coordinator message was sent with a scrape_run_id.
    expect(coordinator.sendCalls).toHaveLength(1);
    const msg = coordinator.sendCalls[0] as { scrape_run_id: string };
    expect(typeof msg.scrape_run_id).toBe('string');
    expect(msg.scrape_run_id.length).toBeGreaterThan(0);
  });

  it('REQ-PIPE-005: cron "0 3 * * *" invokes runCleanup', async () => {
    // runCleanup is imported from src/queue/cleanup.ts. We assert that
    // the dispatcher reached it without throwing; since the stub body
    // is a no-op we can't assert DB calls, but we can assert no
    // coordinator or chunks messages are enqueued (the daily cleanup
    // branch never talks to the queue).
    const { db } = makeDb();
    const kv = makeKv();
    const coordinator = makeQueue();
    const chunks = makeQueue();
    const digestJobs = makeQueue();
    const env = makeEnv(db, kv, coordinator.queue, chunks.queue, digestJobs.queue);
    const { ctx } = makeCtx();
    await scheduled(makeController('0 3 * * *'), env, ctx);
    expect(coordinator.sendCalls).toHaveLength(0);
    expect(chunks.sendCalls).toHaveLength(0);
  });

  it('cron "*/5 * * * *" no longer enqueues per-user digests (regression guard)', async () => {
    const { db } = makeDb();
    const kv = makeKv();
    const coordinator = makeQueue();
    const chunks = makeQueue();
    const digestJobs = makeQueue();
    const env = makeEnv(db, kv, coordinator.queue, chunks.queue, digestJobs.queue);
    const { ctx } = makeCtx();
    await scheduled(makeController('*/5 * * * *'), env, ctx);
    // No coordinator enqueue (that's the hourly path), and critically
    // no DIGEST_JOBS send/sendBatch (per-user dispatch retired).
    expect(coordinator.sendCalls).toHaveLength(0);
    expect(digestJobs.sendCalls).toHaveLength(0);
    expect(digestJobs.sendBatchCalls).toHaveLength(0);
  });

  it('cron "*/5 * * * *" still drains pending_discoveries and dispatches daily emails', async () => {
    // The discovery drain issues a SELECT on pending_discoveries; seeing
    // that query execute is the observable signal that the branch fired.
    const { db, calls } = makeDb({
      pendingDiscoveriesResults: [],
    });
    const kv = makeKv();
    const coordinator = makeQueue();
    const chunks = makeQueue();
    const digestJobs = makeQueue();
    const env = makeEnv(db, kv, coordinator.queue, chunks.queue, digestJobs.queue);
    const { ctx } = makeCtx();
    await scheduled(makeController('*/5 * * * *'), env, ctx);
    const discoveryQuery = calls.find((c) =>
      c.sql.startsWith('SELECT tag FROM pending_discoveries'),
    );
    expect(discoveryQuery).toBeDefined();
    // dispatchDailyEmails is a stub in Gate B; its body is empty, so
    // we only assert the cron returned cleanly without throwing.
  });

  it('worker.ts default export has scheduled, queue, fetch handlers', () => {
    expect(typeof workerDefault.scheduled).toBe('function');
    expect(typeof workerDefault.queue).toBe('function');
    expect(typeof workerDefault.fetch).toBe('function');
  });
});
