// Tests for src/lib/discovery.ts#processPendingDiscoveries — REQ-DISC-003
// (consecutive-failure counter) + REQ-DISC-001 AC 5 (DELETE pending on
// resolution).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processPendingDiscoveries } from '~/lib/discovery';

/** Options record the KV mock captures — kept loosely typed so we don't
 * depend on a specific Cloudflare types export. */
interface PutOptions {
  expirationTtl?: number;
  expiration?: number;
  metadata?: unknown;
}

/** Mutable in-memory KV stub — tracks every set/delete for assertions. */
function makeKv(seed: Record<string, string> = {}): {
  kv: KVNamespace;
  store: Record<string, string>;
  puts: Array<{ key: string; value: string; options?: PutOptions }>;
  deletes: string[];
} {
  const store: Record<string, string> = { ...seed };
  const puts: Array<{ key: string; value: string; options?: PutOptions }> = [];
  const deletes: string[] = [];
  const kv = {
    get: vi.fn().mockImplementation(async (key: string) => {
      return store[key] ?? null;
    }),
    put: vi
      .fn()
      .mockImplementation(async (key: string, value: string, options?: PutOptions) => {
        store[key] = value;
        const record: { key: string; value: string; options?: PutOptions } = {
          key,
          value,
        };
        if (options !== undefined) {
          record.options = options;
        }
        puts.push(record);
      }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      delete store[key];
      deletes.push(key);
    }),
  } as unknown as KVNamespace;
  return { kv, store, puts, deletes };
}

/**
 * D1 stub that returns the given pending tags on SELECT, and records
 * every DELETE FROM pending_discoveries call. DELETE results always
 * report changes: 1 so the code path treats it as a successful removal.
 */
function makeDb(pendingTags: string[]): {
  db: D1Database;
  runCalls: Array<{ sql: string; params: unknown[] }>;
} {
  const runCalls: Array<{ sql: string; params: unknown[] }> = [];
  const prepareSpy = vi.fn().mockImplementation((sql: string) => ({
    bind: (...params: unknown[]) => ({
      all: vi.fn().mockResolvedValue({
        results: pendingTags.map((t) => ({ tag: t })),
        success: true,
      }),
      run: vi.fn().mockImplementation(async () => {
        runCalls.push({ sql, params });
        return { success: true, meta: { changes: 1 } };
      }),
    }),
  }));
  const db = { prepare: prepareSpy } as unknown as D1Database;
  return { db, runCalls };
}

/** Build an Env stub with programmable AI.run. Always returns the same
 * JSON response — these tests don't need per-tag branching. */
function makeEnv(db: D1Database, kv: KVNamespace, aiResponse: string): Env {
  const aiRun = vi.fn().mockImplementation(async () => ({ response: aiResponse }));
  return {
    DB: db,
    KV: kv,
    AI: { run: aiRun } as unknown as Ai,
  } as unknown as Env;
}

function rssBody(): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
    <item><title>Hi</title><link>https://ex.com/1</link></item>
  </channel></rss>`;
}

function mockFetchOk(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation(async () => {
    return new Response(rssBody(), {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mockFetchFail(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation(async () => {
    return new Response('', { status: 500 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('processPendingDiscoveries', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('REQ-DISC-001: writes sources:{tag} and DELETEs pending rows on success', async () => {
    mockFetchOk();
    const { db, runCalls } = makeDb(['ai']);
    const { kv, puts, deletes } = makeKv();
    const env = makeEnv(
      db,
      kv,
      JSON.stringify({
        feeds: [{ name: 'Ex', url: 'https://ex.com/feed', kind: 'rss' }],
      }),
    );

    const result = await processPendingDiscoveries(env);

    expect(result.processed).toEqual(['ai']);
    expect(result.failed).toEqual([]);

    // sources:ai was written
    const srcPut = puts.find((p) => p.key === 'sources:ai');
    expect(srcPut).toBeDefined();
    const parsed = JSON.parse(srcPut!.value);
    expect(parsed.feeds).toHaveLength(1);
    expect(typeof parsed.discovered_at).toBe('number');

    // discovery_failures:ai counter was cleared
    expect(deletes).toContain('discovery_failures:ai');

    // pending row was deleted
    const del = runCalls.find(
      (c) => c.sql.startsWith('DELETE FROM pending_discoveries') && c.params[0] === 'ai',
    );
    expect(del).toBeDefined();
  });

  it('REQ-DISC-003: increments discovery_failures counter on first failure (pending row retained)', async () => {
    mockFetchFail();
    const { db, runCalls } = makeDb(['go']);
    const { kv, puts } = makeKv();
    const env = makeEnv(
      db,
      kv,
      JSON.stringify({
        feeds: [{ name: 'Bad', url: 'https://ex.com/feed', kind: 'rss' }],
      }),
    );

    const result = await processPendingDiscoveries(env);

    expect(result.processed).toEqual([]);
    expect(result.failed).toEqual(['go']);

    // Counter incremented to 1 with 7-day TTL.
    const counterPut = puts.find((p) => p.key === 'discovery_failures:go');
    expect(counterPut).toBeDefined();
    expect(counterPut!.value).toBe('1');
    expect(counterPut!.options?.expirationTtl).toBe(7 * 24 * 60 * 60);

    // No sources:go entry yet — we still want retries.
    expect(puts.some((p) => p.key === 'sources:go')).toBe(false);

    // Pending row NOT deleted — the next cron will retry.
    const del = runCalls.find(
      (c) => c.sql.startsWith('DELETE FROM pending_discoveries') && c.params[0] === 'go',
    );
    expect(del).toBeUndefined();
  });

  it('REQ-DISC-003: evicts and DELETEs pending when counter reaches threshold', async () => {
    mockFetchFail();
    const { db, runCalls } = makeDb(['rust']);
    // Seed the counter at 1 — the next failure puts it at the threshold (2).
    const { kv, puts, deletes } = makeKv({ 'discovery_failures:rust': '1' });
    const env = makeEnv(
      db,
      kv,
      JSON.stringify({
        feeds: [{ name: 'Bad', url: 'https://ex.com/feed', kind: 'rss' }],
      }),
    );

    const result = await processPendingDiscoveries(env);

    expect(result.failed).toContain('rust');

    // Empty sources:rust entry written so the settings page can
    // surface the Re-discover button (REQ-DISC-004 AC 1).
    const srcPut = puts.find((p) => p.key === 'sources:rust');
    expect(srcPut).toBeDefined();
    const parsed = JSON.parse(srcPut!.value);
    expect(parsed.feeds).toEqual([]);

    // Counter reset after eviction.
    expect(deletes).toContain('discovery_failures:rust');

    // Pending row deleted on final failure (REQ-DISC-001 AC 5 —
    // "regardless of success").
    const del = runCalls.find(
      (c) => c.sql.startsWith('DELETE FROM pending_discoveries') && c.params[0] === 'rust',
    );
    expect(del).toBeDefined();
  });

  it('REQ-DISC-001: picks up to `limit` distinct tags', async () => {
    mockFetchOk();
    const { db } = makeDb(['ai', 'go', 'rust']);
    const { kv } = makeKv();
    const env = makeEnv(
      db,
      kv,
      JSON.stringify({
        feeds: [{ name: 'Ex', url: 'https://ex.com/feed', kind: 'rss' }],
      }),
    );

    const result = await processPendingDiscoveries(env, 3);

    expect(result.processed).toHaveLength(3);
    expect(new Set(result.processed)).toEqual(new Set(['ai', 'go', 'rust']));
  });

  it('REQ-DISC-001: passes limit into the SELECT query', async () => {
    mockFetchOk();
    const { db } = makeDb([]);
    const { kv } = makeKv();
    const env = makeEnv(db, kv, JSON.stringify({ feeds: [] }));

    const prepareSpy = db.prepare as ReturnType<typeof vi.fn>;
    await processPendingDiscoveries(env, 7);

    const selectCall = prepareSpy.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).startsWith('SELECT tag FROM pending_discoveries'),
    );
    expect(selectCall).toBeDefined();
    // The SELECT must group by tag and use LIMIT with the passed-in value.
    expect(selectCall![0]).toContain('GROUP BY tag');
    expect(selectCall![0]).toContain('LIMIT');
  });

  it('REQ-DISC-003: no pending tags → empty result, no KV writes', async () => {
    mockFetchOk();
    const { db } = makeDb([]);
    const { kv, puts, deletes } = makeKv();
    const env = makeEnv(db, kv, JSON.stringify({ feeds: [] }));

    const result = await processPendingDiscoveries(env);

    expect(result.processed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(puts).toEqual([]);
    expect(deletes).toEqual([]);
  });
});
