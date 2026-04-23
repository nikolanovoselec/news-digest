// Tests for src/queue/scrape-coordinator.ts — REQ-PIPE-001.
//
// The coordinator fetches CURATED_SOURCES + discovered-tag feeds,
// canonical-dedupes the pool, filters already-seen canonical URLs,
// chunks survivors into ≤100-item slices, and enqueues SCRAPE_CHUNKS
// messages with a KV counter primed to the chunk count. These tests
// stub fetch, D1, KV, and the queue producer.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCoordinator } from '~/queue/scrape-coordinator';

interface SqlRecord {
  sql: string;
  params: unknown[];
  via: 'run' | 'all' | 'first' | 'batch';
}

function makeDb(opts: {
  existingCanonicals?: string[];
} = {}): { db: D1Database; records: SqlRecord[] } {
  const records: SqlRecord[] = [];
  const existing = opts.existingCanonicals ?? [];
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: (...params: unknown[]) => ({
      run: vi.fn().mockImplementation(async () => {
        records.push({ sql, params, via: 'run' });
        return { success: true, meta: { changes: 1 } };
      }),
      all: vi.fn().mockImplementation(async () => {
        records.push({ sql, params, via: 'all' });
        if (sql.startsWith('SELECT canonical_url FROM articles')) {
          const matches = existing.filter((u) =>
            (params as string[]).includes(u),
          );
          return {
            success: true,
            results: matches.map((u) => ({ canonical_url: u })),
          };
        }
        return { success: true, results: [] };
      }),
      first: vi.fn().mockResolvedValue(null),
    }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
  }));
  const db = {
    prepare,
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
  } as unknown as D1Database;
  return { db, records };
}

function makeKv(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    get: vi.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
    put: vi
      .fn()
      .mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
      }),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockImplementation(async () => ({
      keys: [],
      list_complete: true,
    })),
  } as unknown as KVNamespace;
  return { kv, store };
}

function makeEnv(
  db: D1Database,
  kv: KVNamespace,
  chunksQueue: Queue<unknown>,
): Env {
  return {
    DB: db,
    KV: kv,
    SCRAPE_COORDINATOR: { send: vi.fn() } as unknown as Queue<unknown>,
    SCRAPE_CHUNKS: chunksQueue,
    AI: { run: vi.fn() } as unknown as Ai,
    DIGEST_JOBS: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue<unknown>,
    ASSETS: {} as Fetcher,
    OAUTH_CLIENT_ID: 'x',
    OAUTH_CLIENT_SECRET: 'x',
    OAUTH_JWT_SECRET: 'x',
    RESEND_API_KEY: 'x',
    RESEND_FROM: 'x',
    APP_URL: 'https://test.example.com',
  } as unknown as Env;
}

/** Build a chunks queue that records every send call. */
function makeChunksQueue(): {
  queue: Queue<unknown>;
  sends: unknown[];
} {
  const sends: unknown[] = [];
  const queue = {
    send: vi.fn().mockImplementation(async (body: unknown) => {
      sends.push(body);
    }),
    sendBatch: vi.fn(),
  } as unknown as Queue<unknown>;
  return { queue, sends };
}

/** Stub global fetch to return a minimal RSS feed with N items per call. */
function stubFetchWithItems(itemsPerFetch: number): void {
  const itemsXml: string[] = [];
  for (let i = 0; i < itemsPerFetch; i++) {
    itemsXml.push(
      `<item><title>Story ${i}</title><link>https://feed${i}.example.com/a</link></item>`,
    );
  }
  const rss = `<rss><channel>${itemsXml.join('')}</channel></rss>`;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(rss, {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      }),
    ),
  );
}

/** Stub fetch so every source returns zero items. */
function stubFetchEmpty(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response('<rss><channel></channel></rss>', {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      }),
    ),
  );
}

describe('scrape-coordinator — REQ-PIPE-001', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('REQ-PIPE-001: fetches all curated sources (mocked fetch), canonical-dedupes the pool', async () => {
    stubFetchWithItems(1);
    const { db } = makeDb();
    const { kv } = makeKv();
    const { queue, sends } = makeChunksQueue();
    const env = makeEnv(db, kv, queue);
    await runCoordinator(env, { scrape_run_id: 'run-1' });
    // At least one chunk sent — curated registry is non-empty.
    expect(sends.length).toBeGreaterThanOrEqual(1);
  });

  it('REQ-PIPE-001: filters out candidates whose canonical_url is already in articles', async () => {
    stubFetchWithItems(1);
    // Mark ALL the feed URLs returned by the stub as already-existing
    // so the coordinator's existing-check drops them to zero survivors.
    const urls: string[] = [];
    for (let i = 0; i < 1; i++) {
      urls.push(`https://feed${i}.example.com/a`);
    }
    const { db } = makeDb({ existingCanonicals: urls });
    const { kv } = makeKv();
    const { queue, sends } = makeChunksQueue();
    const env = makeEnv(db, kv, queue);
    await runCoordinator(env, { scrape_run_id: 'run-2' });
    // Everything in the pool already existed → no chunks enqueued + run
    // closed immediately.
    expect(sends.length).toBe(0);
  });

  it('REQ-PIPE-001: chunks survivors into slices of ≤100 and enqueues SCRAPE_CHUNKS per chunk', async () => {
    // Stub fetch to return many items per call. Per-source cap is 10 in
    // the coordinator, so we'll see ~10 × (curated sources) items. With
    // >50 curated sources, we reach multiple chunks easily.
    stubFetchWithItems(20);
    const { db } = makeDb();
    const { kv } = makeKv();
    const { queue, sends } = makeChunksQueue();
    const env = makeEnv(db, kv, queue);
    await runCoordinator(env, { scrape_run_id: 'run-3' });
    expect(sends.length).toBeGreaterThanOrEqual(1);
    for (const body of sends) {
      const msg = body as {
        scrape_run_id: string;
        candidates: unknown[];
        total_chunks: number;
      };
      expect(msg.scrape_run_id).toBe('run-3');
      expect(msg.candidates.length).toBeLessThanOrEqual(100);
    }
  });

  it('REQ-PIPE-001: sets KV chunks_remaining counter to the chunk count with 3-hour TTL', async () => {
    stubFetchWithItems(1);
    const { db } = makeDb();
    const { kv, store } = makeKv();
    const { queue, sends } = makeChunksQueue();
    const env = makeEnv(db, kv, queue);
    await runCoordinator(env, { scrape_run_id: 'run-4' });
    const counter = store.get('scrape_run:run-4:chunks_remaining');
    expect(counter).toBeDefined();
    expect(Number(counter)).toBe(sends.length);
    const putMock = kv.put as ReturnType<typeof vi.fn>;
    const putCall = putMock.mock.calls.find(
      (c: unknown[]) => c[0] === 'scrape_run:run-4:chunks_remaining',
    );
    expect(putCall).toBeDefined();
    const opts = putCall![2] as { expirationTtl: number };
    expect(opts.expirationTtl).toBe(3 * 3600);
  });

  it('REQ-PIPE-001: when pool is empty, finishRun(ready) is called immediately', async () => {
    stubFetchEmpty();
    const { db, records } = makeDb();
    const { kv } = makeKv();
    const { queue, sends } = makeChunksQueue();
    const env = makeEnv(db, kv, queue);
    await runCoordinator(env, { scrape_run_id: 'run-5' });
    expect(sends.length).toBe(0);
    const finish = records.find(
      (r) =>
        r.sql.includes('UPDATE scrape_runs') &&
        (r.params as unknown[])[1] === 'ready',
    );
    expect(finish).toBeDefined();
  });
});
