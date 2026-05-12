// Tests for src/lib/sources-cache.ts — REQ-PIPE-001 / AD16 / CF-025.
// The coordinator's eviction recheck relies on byte-equal serialised
// output for two logically-identical writes. A future refactor that
// adds a field or reorders the JSON.stringify field list silently
// breaks the recheck. The byte-string assertion here is the regression
// guard.

import { describe, it, expect, vi } from 'vitest';
import {
  sourcesCacheRawEqual,
  writeSourcesCache,
} from '~/lib/sources-cache';
import type { DiscoveredFeed } from '~/lib/types';

function feed(url: string, name = url, kind: DiscoveredFeed['kind'] = 'rss'): DiscoveredFeed {
  return { name, url, kind };
}

function makeKv(): {
  KV: KVNamespace;
  putCalls: Array<[string, string]>;
} {
  const putCalls: Array<[string, string]> = [];
  const fake = {
    put: vi.fn(async (key: string, value: string) => {
      putCalls.push([key, value]);
    }),
    get: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ keys: [], list_complete: true } as never)),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null } as never)),
  } as unknown as KVNamespace;
  return { KV: fake, putCalls };
}

describe('writeSourcesCache', () => {
  it('serialises with a fixed field order (feeds, discovered_at) — byte regression guard', async () => {
    // AD16: the canonical serialised form is byte-load-bearing. If a
    // future change reorders the object literal, this assertion fails
    // loudly so callers do not silently start clobbering peer writes
    // on the recheck.
    const { KV, putCalls } = makeKv();
    const a = feed('https://a.example/feed.xml', 'A');
    const b = feed('https://b.example/feed.xml', 'B');
    await writeSourcesCache(KV, 'cf', {
      feeds: [a, b],
      discovered_at: 1700000000,
    });
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.[0]).toBe('sources:cf');
    expect(putCalls[0]?.[1]).toBe(
      `{"feeds":[${JSON.stringify(a)},${JSON.stringify(b)}],"discovered_at":1700000000}`,
    );
  });

  it('returns the same byte string it wrote (callers pair with recheck)', async () => {
    const { KV } = makeKv();
    const x = feed('https://x.example/feed.xml', 'X');
    const raw = await writeSourcesCache(KV, 'ml', {
      feeds: [x],
      discovered_at: 42,
    });
    expect(raw).toBe(
      `{"feeds":[${JSON.stringify(x)}],"discovered_at":42}`,
    );
  });

  it('preserves feed array order — order is part of the cache contract', async () => {
    // The coordinator orders feeds deterministically before writing;
    // serialise must preserve that order, since `sourcesCacheRawEqual`
    // is a byte compare and any swap would read as a fresh peer write.
    const { KV, putCalls } = makeKv();
    const b = feed('b', 'B');
    const a = feed('a', 'A');
    const c = feed('c', 'C');
    await writeSourcesCache(KV, 'go', {
      feeds: [b, a, c],
      discovered_at: 1,
    });
    expect(putCalls[0]?.[1]).toBe(
      `{"feeds":[${JSON.stringify(b)},${JSON.stringify(a)},${JSON.stringify(c)}],"discovered_at":1}`,
    );
  });

  it('puts under the sources: prefix and the supplied tag', async () => {
    const { KV, putCalls } = makeKv();
    await writeSourcesCache(KV, 'rust', { feeds: [], discovered_at: 0 });
    expect(putCalls[0]?.[0]).toBe('sources:rust');
  });
});

describe('sourcesCacheRawEqual', () => {
  it('returns true for byte-identical strings', () => {
    const a = '{"feeds":["x"],"discovered_at":1}';
    const b = '{"feeds":["x"],"discovered_at":1}';
    expect(sourcesCacheRawEqual(a, b)).toBe(true);
  });

  it('returns false when feeds order differs (per AD16: order is load-bearing)', () => {
    // Two writers cannot produce the same byte string unless they
    // canonicalise feeds the same way. The recheck must classify a
    // reordered payload as "a different write landed first".
    const a = '{"feeds":["a","b"],"discovered_at":1}';
    const b = '{"feeds":["b","a"],"discovered_at":1}';
    expect(sourcesCacheRawEqual(a, b)).toBe(false);
  });

  it('returns false when discovered_at differs', () => {
    const a = '{"feeds":["x"],"discovered_at":1}';
    const b = '{"feeds":["x"],"discovered_at":2}';
    expect(sourcesCacheRawEqual(a, b)).toBe(false);
  });

  it('returns false when a single byte differs', () => {
    const a = '{"feeds":["x"],"discovered_at":1}';
    const b = '{"feeds":["X"],"discovered_at":1}';
    expect(sourcesCacheRawEqual(a, b)).toBe(false);
  });

  it('returns false when JSON key order differs (no structural fallback)', () => {
    // AD16 / module comment explicitly rejected a structural fallback
    // that compared discovered_at independently — two distinct writes
    // could collide on the same millisecond. The comparator is byte
    // only, so the same logical content with a different key order
    // must read as unequal.
    const a = '{"feeds":["x"],"discovered_at":1}';
    const b = '{"discovered_at":1,"feeds":["x"]}';
    expect(sourcesCacheRawEqual(a, b)).toBe(false);
  });

  it('returns false when one side is empty', () => {
    expect(sourcesCacheRawEqual('', '{"feeds":[],"discovered_at":0}')).toBe(false);
  });
});
