// Tests for the coordinator's feed-eviction path — REQ-DISC-003.
//
// When a discovered feed URL crosses `CONSECUTIVE_FETCH_FAILURE_LIMIT`
// consecutive fetch failures, the coordinator:
//   1. Removes the URL from its `sources:{tag}` KV entry.
//   2. Clears the per-URL health counter.
//   3. If that was the last feed for the tag, INSERTs a
//      `pending_discoveries` row with user_id = '__system__' so the
//      next discovery cron repopulates the tag.
//
// Tests use a failing global fetch stub so every source URL accumulates
// failures inside one coordinator pass — the health counter is seeded
// close to the threshold in KV so exactly one fetch pushes it over.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCoordinator } from '~/queue/scrape-coordinator';
import { CONSECUTIVE_FETCH_FAILURE_LIMIT } from '~/lib/feed-health';

interface SqlRecord {
  sql: string;
  params: unknown[];
}

function makeDb(): { db: D1Database; records: SqlRecord[] } {
  const records: SqlRecord[] = [];
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: (...params: unknown[]) => ({
      run: vi.fn().mockImplementation(async () => {
        records.push({ sql, params });
        return { success: true, meta: { changes: 1 } };
      }),
      all: vi.fn().mockImplementation(async () => {
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

interface KvHandles {
  kv: KVNamespace;
  store: Map<string, string>;
  listReturn: Array<{ name: string }>;
}

function makeKv(initial: Record<string, string> = {}, listReturn: Array<{ name: string }> = []): KvHandles {
  const store = new Map<string, string>(Object.entries(initial));
  const kv = {
    get: vi.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
    put: vi.fn().mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn().mockImplementation(async () => ({
      keys: listReturn,
      list_complete: true,
    })),
  } as unknown as KVNamespace;
  return { kv, store, listReturn };
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
    GH_OAUTH_CLIENT_ID: 'x',
    GH_OAUTH_CLIENT_SECRET: 'x',
    OAUTH_JWT_SECRET: 'x',
    RESEND_API_KEY: 'x',
    RESEND_FROM: 'x',
    APP_URL: 'https://test.example.com',
  } as unknown as Env;
}

function makeChunksQueue(): Queue<unknown> {
  return {
    send: vi.fn(),
    sendBatch: vi.fn(),
  } as unknown as Queue<unknown>;
}

describe('scrape-coordinator eviction — REQ-DISC-003', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('REQ-DISC-003: a discovered-feed URL at the failure threshold is removed from sources:{tag}', async () => {
    const feedUrl = 'https://dead.example.com/rss';
    const otherUrl = 'https://alive.example.com/rss';
    const sourcesKey = 'sources:ikea';
    const healthKey = `source_health:${feedUrl}`;

    // 1 failure away from eviction — one more failed fetch in the
    // coordinator pass should push the URL over the threshold.
    const initial: Record<string, string> = {
      [sourcesKey]: JSON.stringify({
        feeds: [
          { name: 'Dead Feed', url: feedUrl, kind: 'rss' },
          { name: 'Alive Feed', url: otherUrl, kind: 'rss' },
        ],
        discovered_at: Date.now(),
      }),
      [healthKey]: String(CONSECUTIVE_FETCH_FAILURE_LIMIT - 1),
    };
    const { kv, store } = makeKv(initial, [{ name: sourcesKey }]);

    // Global fetch returns 500 for the dead URL and a benign empty RSS
    // for everything else so curated sources don't pollute the run.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url === feedUrl) {
          return new Response('server exploded', { status: 500 });
        }
        return new Response('<rss><channel></channel></rss>', {
          status: 200,
          headers: { 'content-type': 'application/rss+xml' },
        });
      }),
    );

    const { db } = makeDb();
    const env = makeEnv(db, kv, makeChunksQueue());
    await runCoordinator(env, { scrape_run_id: 'evict-1' });

    const after = store.get(sourcesKey);
    expect(after).toBeDefined();
    const parsed = JSON.parse(after!) as {
      feeds: Array<{ url: string }>;
    };
    const urls = parsed.feeds.map((f) => f.url);
    expect(urls).not.toContain(feedUrl);
    expect(urls).toContain(otherUrl);
  });

  it('REQ-DISC-003: an evicted URL has its per-URL health counter cleared', async () => {
    const feedUrl = 'https://dead.example.com/rss';
    const sourcesKey = 'sources:ikea';
    const healthKey = `source_health:${feedUrl}`;

    const initial: Record<string, string> = {
      [sourcesKey]: JSON.stringify({
        feeds: [{ name: 'Dead Feed', url: feedUrl, kind: 'rss' }],
        discovered_at: Date.now(),
      }),
      [healthKey]: String(CONSECUTIVE_FETCH_FAILURE_LIMIT - 1),
    };
    const { kv, store } = makeKv(initial, [{ name: sourcesKey }]);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url === feedUrl) {
          return new Response('bad', { status: 500 });
        }
        return new Response('<rss><channel></channel></rss>', {
          status: 200,
          headers: { 'content-type': 'application/rss+xml' },
        });
      }),
    );

    const { db } = makeDb();
    const env = makeEnv(db, kv, makeChunksQueue());
    await runCoordinator(env, { scrape_run_id: 'evict-2' });

    // After eviction the counter key is gone.
    expect(store.get(healthKey)).toBeUndefined();
  });

  it('REQ-DISC-003: when eviction empties the feed list, a system-owned re-discovery row is inserted', async () => {
    const feedUrl = 'https://dead.example.com/rss';
    const sourcesKey = 'sources:ikea';
    const healthKey = `source_health:${feedUrl}`;

    // Only one feed on the tag — evicting it leaves feeds=[] and
    // triggers the re-queue branch.
    const initial: Record<string, string> = {
      [sourcesKey]: JSON.stringify({
        feeds: [{ name: 'Only Feed', url: feedUrl, kind: 'rss' }],
        discovered_at: Date.now(),
      }),
      [healthKey]: String(CONSECUTIVE_FETCH_FAILURE_LIMIT - 1),
    };
    const { kv } = makeKv(initial, [{ name: sourcesKey }]);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url === feedUrl) {
          return new Response('bad', { status: 500 });
        }
        return new Response('<rss><channel></channel></rss>', {
          status: 200,
          headers: { 'content-type': 'application/rss+xml' },
        });
      }),
    );

    const { db, records } = makeDb();
    const env = makeEnv(db, kv, makeChunksQueue());
    await runCoordinator(env, { scrape_run_id: 'evict-3' });

    const insert = records.find(
      (r) =>
        typeof r.sql === 'string' &&
        r.sql.startsWith('INSERT OR IGNORE INTO pending_discoveries'),
    );
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe('__system__');
    expect(insert!.params[1]).toBe('ikea');
    expect(typeof insert!.params[2]).toBe('number');
  });

  it('REQ-DISC-003: a tag with surviving feeds after eviction does NOT enqueue re-discovery', async () => {
    const deadUrl = 'https://dead.example.com/rss';
    const aliveUrl = 'https://alive.example.com/rss';
    const sourcesKey = 'sources:aws';
    const healthKey = `source_health:${deadUrl}`;

    const initial: Record<string, string> = {
      [sourcesKey]: JSON.stringify({
        feeds: [
          { name: 'Dead Feed', url: deadUrl, kind: 'rss' },
          { name: 'Alive Feed', url: aliveUrl, kind: 'rss' },
        ],
        discovered_at: Date.now(),
      }),
      [healthKey]: String(CONSECUTIVE_FETCH_FAILURE_LIMIT - 1),
    };
    const { kv } = makeKv(initial, [{ name: sourcesKey }]);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url === deadUrl) {
          return new Response('bad', { status: 500 });
        }
        return new Response('<rss><channel></channel></rss>', {
          status: 200,
          headers: { 'content-type': 'application/rss+xml' },
        });
      }),
    );

    const { db, records } = makeDb();
    const env = makeEnv(db, kv, makeChunksQueue());
    await runCoordinator(env, { scrape_run_id: 'evict-4' });

    const insert = records.find(
      (r) =>
        typeof r.sql === 'string' &&
        r.sql.startsWith('INSERT OR IGNORE INTO pending_discoveries'),
    );
    // No system row enqueued because `alive` URL remains in the feed list.
    expect(insert).toBeUndefined();
  });

  it('REQ-DISC-003: a URL well below the threshold is NOT evicted, sources:{tag} is untouched', async () => {
    const feedUrl = 'https://slow.example.com/rss';
    const sourcesKey = 'sources:rust';
    const healthKey = `source_health:${feedUrl}`;

    const initial: Record<string, string> = {
      [sourcesKey]: JSON.stringify({
        feeds: [{ name: 'Slow Feed', url: feedUrl, kind: 'rss' }],
        discovered_at: Date.now(),
      }),
      // 5 prior failures — nowhere near the 30-failure threshold.
      [healthKey]: '5',
    };
    const { kv, store } = makeKv(initial, [{ name: sourcesKey }]);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url === feedUrl) {
          return new Response('bad', { status: 500 });
        }
        return new Response('<rss><channel></channel></rss>', {
          status: 200,
          headers: { 'content-type': 'application/rss+xml' },
        });
      }),
    );

    const { db, records } = makeDb();
    const env = makeEnv(db, kv, makeChunksQueue());
    await runCoordinator(env, { scrape_run_id: 'no-evict' });

    // URL still present in sources:{tag}.
    const after = store.get(sourcesKey);
    const parsed = JSON.parse(after!) as { feeds: Array<{ url: string }> };
    expect(parsed.feeds.map((f) => f.url)).toContain(feedUrl);

    // No system-owned re-discovery row enqueued.
    const insert = records.find(
      (r) =>
        typeof r.sql === 'string' &&
        r.sql.startsWith('INSERT OR IGNORE INTO pending_discoveries'),
    );
    expect(insert).toBeUndefined();

    // Counter advanced by 1 (prior 5 → 6).
    expect(store.get(healthKey)).toBe('6');
  });

  it('REQ-DISC-003: a successful fetch resets the counter for that URL to zero', async () => {
    const feedUrl = 'https://flaky.example.com/rss';
    // loadDiscoveredSources enumerates via kv.list prefix 'sources:'; if
    // we seed no sources:{tag} entry the URL never enters the fetch
    // fan-out. Add it under a real tag so the coordinator picks it up.
    const sourcesKey = 'sources:flaky-tag';
    const healthKey = `source_health:${feedUrl}`;

    const initial: Record<string, string> = {
      [sourcesKey]: JSON.stringify({
        feeds: [{ name: 'Flaky Feed', url: feedUrl, kind: 'rss' }],
        discovered_at: Date.now(),
      }),
      [healthKey]: '10',
    };
    const { kv, store } = makeKv(initial, [{ name: sourcesKey }]);

    // Success case — every source URL returns a valid empty feed.
    // mockImplementation builds a fresh Response per call so the body
    // stream is not consumed after the first fetch.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response('<rss><channel></channel></rss>', {
            status: 200,
            headers: { 'content-type': 'application/rss+xml' },
          }),
      ),
    );

    const { db } = makeDb();
    const env = makeEnv(db, kv, makeChunksQueue());
    await runCoordinator(env, { scrape_run_id: 'reset-counter' });

    // Counter cleared because the fetch succeeded.
    expect(store.get(healthKey)).toBeUndefined();
  });
});
