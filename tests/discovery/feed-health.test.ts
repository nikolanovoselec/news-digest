// Tests for src/lib/feed-health.ts — REQ-DISC-003.
//
// The counter is an integer stored as a UTF-8 string in KV under
// `source_health:{url}`. recordFetchResult must:
//   - reset to zero (delete the key) on success
//   - increment on failure with a 7-day TTL
//   - report eviction when the post-increment count reaches the
//     CONSECUTIVE_FETCH_FAILURE_LIMIT threshold
//   - never throw on KV errors (cache is best-effort)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CONSECUTIVE_FETCH_FAILURE_LIMIT,
  clearHealth,
  healthKey,
  recordFetchResult,
} from '~/lib/feed-health';

interface KvStub {
  kv: KVNamespace;
  store: Map<string, string>;
  puts: Array<{ key: string; value: string; opts?: { expirationTtl?: number } }>;
  deletes: string[];
  failNext: { read?: boolean; write?: boolean; delete?: boolean };
}

function makeKv(): KvStub {
  const store = new Map<string, string>();
  const puts: KvStub['puts'] = [];
  const deletes: string[] = [];
  const failNext: KvStub['failNext'] = {};

  const kv = {
    get: vi.fn().mockImplementation(async (key: string) => {
      if (failNext.read) {
        failNext.read = false;
        throw new Error('KV get failed');
      }
      return store.get(key) ?? null;
    }),
    put: vi
      .fn()
      .mockImplementation(
        async (key: string, value: string, opts?: { expirationTtl?: number }) => {
          if (failNext.write) {
            failNext.write = false;
            throw new Error('KV put failed');
          }
          puts.push(opts === undefined ? { key, value } : { key, value, opts });
          store.set(key, value);
        },
      ),
    delete: vi.fn().mockImplementation(async (key: string) => {
      if (failNext.delete) {
        failNext.delete = false;
        throw new Error('KV delete failed');
      }
      deletes.push(key);
      store.delete(key);
    }),
  } as unknown as KVNamespace;

  return { kv, store, puts, deletes, failNext };
}

function makeEnv(kv: KVNamespace): Env {
  return { KV: kv } as unknown as Env;
}

describe('feed-health — REQ-DISC-003', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('REQ-DISC-003: healthKey namespaces by URL', () => {
    expect(healthKey('https://feed.example.com/rss')).toBe(
      'source_health:https://feed.example.com/rss',
    );
  });

  it('REQ-DISC-003: eviction threshold is 30 consecutive fetch failures', () => {
    // 6 scrapes/day × 5 days = 30 — fixed by the REQ-DISC-003 spec.
    expect(CONSECUTIVE_FETCH_FAILURE_LIMIT).toBe(30);
  });

  it('REQ-DISC-003: success resets the counter to zero by deleting the key', async () => {
    const { kv, store, deletes } = makeKv();
    store.set('source_health:https://a.example/rss', '5');
    const result = await recordFetchResult(
      makeEnv(kv),
      'https://a.example/rss',
      true,
    );
    expect(result).toEqual({ evicted: false, count: 0 });
    expect(deletes).toContain('source_health:https://a.example/rss');
  });

  it('REQ-DISC-003: first failure increments counter to 1 with 7-day TTL, reports not evicted', async () => {
    const { kv, puts } = makeKv();
    const result = await recordFetchResult(
      makeEnv(kv),
      'https://a.example/rss',
      false,
    );
    expect(result).toEqual({ evicted: false, count: 1 });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe('source_health:https://a.example/rss');
    expect(puts[0]!.value).toBe('1');
    expect(puts[0]!.opts?.expirationTtl).toBe(7 * 24 * 60 * 60);
  });

  it('REQ-DISC-003: subsequent failures keep incrementing, do not evict below threshold', async () => {
    const { kv, store } = makeKv();
    store.set('source_health:https://a.example/rss', '10');
    const result = await recordFetchResult(
      makeEnv(kv),
      'https://a.example/rss',
      false,
    );
    expect(result).toEqual({ evicted: false, count: 11 });
  });

  it('REQ-DISC-003: failure that lands at the eviction threshold reports evicted=true', async () => {
    const { kv, store } = makeKv();
    store.set(
      'source_health:https://a.example/rss',
      String(CONSECUTIVE_FETCH_FAILURE_LIMIT - 1),
    );
    const result = await recordFetchResult(
      makeEnv(kv),
      'https://a.example/rss',
      false,
    );
    expect(result.evicted).toBe(true);
    expect(result.count).toBe(CONSECUTIVE_FETCH_FAILURE_LIMIT);
  });

  it('REQ-DISC-003: failure beyond threshold still reports evicted=true (idempotent signal)', async () => {
    const { kv, store } = makeKv();
    store.set(
      'source_health:https://a.example/rss',
      String(CONSECUTIVE_FETCH_FAILURE_LIMIT + 5),
    );
    const result = await recordFetchResult(
      makeEnv(kv),
      'https://a.example/rss',
      false,
    );
    expect(result.evicted).toBe(true);
    expect(result.count).toBe(CONSECUTIVE_FETCH_FAILURE_LIMIT + 6);
  });

  it('REQ-DISC-003: corrupt counter value (non-integer) restarts at 1 rather than blowing up', async () => {
    const { kv, store } = makeKv();
    store.set('source_health:https://a.example/rss', 'not-a-number');
    const result = await recordFetchResult(
      makeEnv(kv),
      'https://a.example/rss',
      false,
    );
    expect(result.count).toBe(1);
    expect(result.evicted).toBe(false);
  });

  it('REQ-DISC-003: KV read failure is non-fatal and returns count=0 without evicting', async () => {
    const stub = makeKv();
    stub.failNext.read = true;
    const result = await recordFetchResult(
      makeEnv(stub.kv),
      'https://a.example/rss',
      false,
    );
    expect(result).toEqual({ evicted: false, count: 0 });
  });

  it('REQ-DISC-003: KV write failure is non-fatal, still surfaces count', async () => {
    const stub = makeKv();
    stub.failNext.write = true;
    const result = await recordFetchResult(
      makeEnv(stub.kv),
      'https://a.example/rss',
      false,
    );
    // The counter value was computed even though persistence failed.
    expect(result.count).toBe(1);
    expect(result.evicted).toBe(false);
  });

  it('REQ-DISC-003: success with no existing counter is a no-op that never throws', async () => {
    const { kv } = makeKv();
    const result = await recordFetchResult(
      makeEnv(kv),
      'https://a.example/rss',
      true,
    );
    expect(result).toEqual({ evicted: false, count: 0 });
  });

  it('REQ-DISC-003: clearHealth deletes the per-URL counter key', async () => {
    const { kv, store, deletes } = makeKv();
    store.set('source_health:https://a.example/rss', '10');
    await clearHealth(makeEnv(kv), 'https://a.example/rss');
    expect(deletes).toContain('source_health:https://a.example/rss');
  });

  it('REQ-DISC-003: clearHealth swallows KV errors', async () => {
    const stub = makeKv();
    stub.failNext.delete = true;
    await expect(
      clearHealth(makeEnv(stub.kv), 'https://a.example/rss'),
    ).resolves.toBeUndefined();
  });
});
