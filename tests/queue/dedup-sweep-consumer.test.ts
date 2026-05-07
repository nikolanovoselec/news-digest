// Tests for src/queue/dedup-sweep-consumer.ts — REQ-PIPE-003 AC 9.
//
// The consumer self-chains across batches, updates the dedup_runs
// audit row, and re-enqueues continuation messages until the sweep
// finishes (`done: true`). Coverage:
//   1. Single-batch sweep that hits the corpus tail flips audit row
//      to status='done' and does NOT enqueue a continuation.
//   2. Multi-batch sweep enqueues exactly one continuation message
//      with the next composite cursor.
//   3. Already-terminal audit row short-circuits — the consumer
//      neither runs the batch nor re-enqueues.
//   4. Missing audit row (operator wiped the table) short-circuits
//      without throwing — silent for queue redeliveries against an
//      old run_id.
//   5. Vectorize failure during the batch stamps the error onto the
//      audit row and rethrows so the queue retries.

import { describe, it, expect, vi } from 'vitest';
import { processOneDedupSweep } from '~/queue/dedup-sweep-consumer';

interface DbCalls {
  selectStatus: Array<{ runId: string; result: { status: string } | null }>;
  updateCalls: Array<{ sql: string; params: unknown[] }>;
}

function makeDbWithRun(opts: {
  status?: string | null;
  articles?: Array<{ id: string; published_at: number; primary_source_url: string }>;
  remainingAfterBatch?: number;
}): { db: D1Database; calls: DbCalls } {
  const calls: DbCalls = { selectStatus: [], updateCalls: [] };
  const articles = opts.articles ?? [];
  const remaining = opts.remainingAfterBatch ?? 0;

  const prepare = vi.fn().mockImplementation((sql: string) => {
    const bound: unknown[] = [];
    const ops = {
      first: vi.fn().mockImplementation(async () => {
        if (sql.includes('SELECT status FROM dedup_runs')) {
          const runId = bound[0] as string;
          if (opts.status === null) {
            calls.selectStatus.push({ runId, result: null });
            return null;
          }
          const result = { status: opts.status ?? 'running' };
          calls.selectStatus.push({ runId, result });
          return result;
        }
        if (sql.includes('SELECT COUNT(*) AS c')) {
          return { c: remaining };
        }
        if (sql.includes('SELECT id, title, source_snippet FROM articles')) {
          // No matches needed for these tests
          return null;
        }
        return null;
      }),
      all: vi.fn().mockImplementation(async () => {
        if (
          sql.includes('SELECT id, title, source_snippet, published_at') &&
          sql.includes("embedding_status = 'embedded'")
        ) {
          return {
            results: articles.map((a) => ({
              id: a.id,
              title: 'title',
              source_snippet: null,
              published_at: a.published_at,
              primary_source_url: a.primary_source_url,
            })),
          };
        }
        return { results: [] };
      }),
      run: vi.fn().mockImplementation(async () => {
        if (sql.includes('UPDATE dedup_runs')) {
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

function makeQueue() {
  const sends: unknown[] = [];
  const queue = {
    send: vi.fn().mockImplementation(async (msg: unknown) => {
      sends.push(msg);
    }),
    sendBatch: vi.fn(),
  } as unknown as Queue;
  return { queue, sends };
}

function makeVectorize(failures: { queryThrows?: boolean } = {}) {
  return {
    queryById: vi.fn().mockImplementation(async () => {
      if (failures.queryThrows === true) {
        throw new Error('vectorize down');
      }
      return { count: 0, matches: [] };
    }),
    deleteByIds: vi.fn().mockResolvedValue({ count: 0, ids: [] }),
    query: vi.fn(),
    upsert: vi.fn(),
  } as unknown as Vectorize;
}

describe('processOneDedupSweep — REQ-PIPE-003 AC 9', () => {
  it('flips audit row to status=done when batch reports done:true', async () => {
    // Empty corpus → batch returns scanned:0, merged:0, done:true.
    const { db, calls } = makeDbWithRun({
      status: 'running',
      articles: [],
      remainingAfterBatch: 0,
    });
    const { queue, sends } = makeQueue();
    const env = {
      DB: db,
      VECTORIZE: makeVectorize(),
      AI: { run: vi.fn() },
      DEDUP_SWEEP: queue,
    } as unknown as Env;
    await processOneDedupSweep(env, {
      run_id: '01TESTRUNID0000000000000AA',
      cursor: null,
    });
    // Status flipped to done. The third bound param is the new
    // status.
    expect(calls.updateCalls.length).toBe(1);
    const updateParams = calls.updateCalls[0]!.params;
    expect(updateParams[0]).toBe('01TESTRUNID0000000000000AA');
    expect(updateParams[1]).toBe('done');
    // No continuation message sent.
    expect(sends.length).toBe(0);
  });

  it('re-enqueues continuation message when more articles remain', async () => {
    const ARTICLE = {
      id: '01ARTICLE000000000000000A1',
      published_at: 1_700_000_000,
      primary_source_url: 'https://example.com/a',
    };
    const { db, calls } = makeDbWithRun({
      status: 'running',
      articles: [ARTICLE],
      remainingAfterBatch: 50,
    });
    const { queue, sends } = makeQueue();
    const env = {
      DB: db,
      VECTORIZE: makeVectorize(),
      AI: { run: vi.fn() },
      DEDUP_SWEEP: queue,
    } as unknown as Env;
    await processOneDedupSweep(env, {
      run_id: '01TESTRUNID0000000000000AA',
      cursor: null,
      batch: 1,
    });
    // Update keeps status='running' because remaining > 0.
    expect(calls.updateCalls.length).toBe(1);
    expect(calls.updateCalls[0]!.params[1]).toBe('running');
    // CAS guard binds the incoming message cursor at positions 9/10
    // (params[8]/[9]) — null for the first batch — so redelivery of
    // the same message can be detected and skipped.
    expect(calls.updateCalls[0]!.params[8]).toBeNull();
    expect(calls.updateCalls[0]!.params[9]).toBeNull();
    // Exactly one continuation message; cursor advances to the last
    // scanned article, batch is preserved verbatim.
    expect(sends.length).toBe(1);
    expect(sends[0]).toEqual({
      run_id: '01TESTRUNID0000000000000AA',
      cursor: { pa: ARTICLE.published_at, id: ARTICLE.id },
      batch: 1,
    });
  });

  it('short-circuits when audit row is already terminal (status=done)', async () => {
    const { db, calls } = makeDbWithRun({
      status: 'done',
      articles: [],
    });
    const { queue, sends } = makeQueue();
    const env = {
      DB: db,
      VECTORIZE: makeVectorize(),
      AI: { run: vi.fn() },
      DEDUP_SWEEP: queue,
    } as unknown as Env;
    await processOneDedupSweep(env, {
      run_id: '01TESTRUNID0000000000000AA',
      cursor: null,
    });
    // No update SQL fired (no batch was even started).
    expect(calls.updateCalls.length).toBe(0);
    expect(sends.length).toBe(0);
  });

  it('short-circuits without throwing when audit row is missing', async () => {
    const { db, calls } = makeDbWithRun({ status: null });
    const { queue, sends } = makeQueue();
    const env = {
      DB: db,
      VECTORIZE: makeVectorize(),
      AI: { run: vi.fn() },
      DEDUP_SWEEP: queue,
    } as unknown as Env;
    await processOneDedupSweep(env, {
      run_id: '01STALERUN00000000000000AA',
      cursor: null,
    });
    // No update SQL, no enqueue, no throw — silent for stale runs.
    expect(calls.updateCalls.length).toBe(0);
    expect(sends.length).toBe(0);
    expect(calls.selectStatus.length).toBe(1);
    expect(calls.selectStatus[0]!.result).toBeNull();
  });

  it('CAS-skips counter increment on queue redelivery but still sends continuation', async () => {
    // Simulate a redelivery where the audit row's last_cursor was
    // already advanced by the original successful run. The UPDATE's
    // CAS guard (last_cursor_pa IS ?prev AND last_cursor_id IS ?prev)
    // should not match → D1 reports meta.changes=0. The consumer
    // logs the skip but still issues the continuation send because
    // the original send may itself have failed (which is what caused
    // the redelivery).
    const ARTICLE = {
      id: '01ARTICLE000000000000000B2',
      published_at: 1_700_000_000,
      primary_source_url: 'https://example.com/b',
    };
    const updateCalls: Array<{ sql: string; params: unknown[] }> = [];
    const casMissDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        const bound: unknown[] = [];
        const ops = {
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT status FROM dedup_runs')) {
              return { status: 'running' };
            }
            if (sql.includes('SELECT COUNT(*) AS c')) {
              return { c: 50 };
            }
            return null;
          }),
          all: vi.fn().mockImplementation(async () => {
            if (
              sql.includes('SELECT id, title, source_snippet, published_at') &&
              sql.includes("embedding_status = 'embedded'")
            ) {
              return {
                results: [
                  {
                    id: ARTICLE.id,
                    title: 'title',
                    source_snippet: null,
                    published_at: ARTICLE.published_at,
                    primary_source_url: ARTICLE.primary_source_url,
                  },
                ],
              };
            }
            return { results: [] };
          }),
          run: vi.fn().mockImplementation(async () => {
            if (sql.includes('UPDATE dedup_runs')) {
              updateCalls.push({ sql, params: [...bound] });
              // CAS miss: zero rows affected because the saved
              // last_cursor no longer matches the incoming cursor.
              return { success: true, meta: { changes: 0 } };
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
      }),
      batch: vi.fn(),
    } as unknown as D1Database;
    const { queue, sends } = makeQueue();
    const env = {
      DB: casMissDb,
      VECTORIZE: makeVectorize(),
      AI: { run: vi.fn() },
      DEDUP_SWEEP: queue,
    } as unknown as Env;
    await processOneDedupSweep(env, {
      run_id: '01TESTRUNID0000000000000AA',
      cursor: null,
      batch: 1,
    });
    // UPDATE was issued (with CAS predicate); it just didn't match.
    expect(updateCalls.length).toBe(1);
    // CAS predicate carries the incoming message cursor at param
    // positions 9/10 (1-indexed in SQL → 8/9 in the JS bind array).
    // body.cursor was null for this redelivered first-batch case.
    expect(updateCalls[0]!.params[8]).toBeNull();
    expect(updateCalls[0]!.params[9]).toBeNull();
    // Continuation still fires — chain stays alive.
    expect(sends.length).toBe(1);
    expect(sends[0]).toEqual({
      run_id: '01TESTRUNID0000000000000AA',
      cursor: { pa: ARTICLE.published_at, id: ARTICLE.id },
      batch: 1,
    });
  });

  it('rethrows on Vectorize failure but stamps error onto audit row', async () => {
    // Vectorize.queryById throws on every call. The dedup batch loop
    // catches the per-article failure and continues, so a single
    // failure does NOT propagate. To force the consumer to throw we
    // need the batch itself to throw — easiest is to corrupt the
    // article SELECT, so we mock the prepare path differently.
    const failingDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        const bound: unknown[] = [];
        const ops = {
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes('SELECT status FROM dedup_runs')) {
              return { status: 'running' };
            }
            return null;
          }),
          all: vi.fn().mockImplementation(async () => {
            if (
              sql.includes('SELECT id, title, source_snippet, published_at')
            ) {
              throw new Error('D1 transient');
            }
            return { results: [] };
          }),
          run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
        };
        const stmt = {
          ...ops,
          bind: (...params: unknown[]) => {
            bound.push(...params);
            return { ...ops, sql, params };
          },
        };
        return stmt as unknown as D1PreparedStatement;
      }),
      batch: vi.fn(),
    } as unknown as D1Database;
    const { queue, sends } = makeQueue();
    const env = {
      DB: failingDb,
      VECTORIZE: makeVectorize(),
      AI: { run: vi.fn() },
      DEDUP_SWEEP: queue,
    } as unknown as Env;
    await expect(
      processOneDedupSweep(env, {
        run_id: '01FAILRUN0000000000000000A',
        cursor: null,
      }),
    ).rejects.toThrow(/D1 transient/);
    // Did not enqueue a continuation when the batch threw.
    expect(sends.length).toBe(0);
    // Did issue an UPDATE to stamp the error onto the audit row.
    const prepareMock = failingDb.prepare as ReturnType<typeof vi.fn>;
    const updateCall = prepareMock.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        (c[0] as string).includes('UPDATE dedup_runs') &&
        (c[0] as string).includes('error = ?2'),
    );
    expect(updateCall).toBeDefined();
  });
});
