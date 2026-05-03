// Tests for src/queue/scrape-coordinator.ts loadDiscoveredSources —
// REQ-DISC-001 / REQ-PIPE-001.
//
// CF-015 — pins the orphan-purge, per-key try/catch, and partial-flag
// contract. Without these tests a regression that breaks the curated-
// shadow detection (sources:{tag} entries piling up for tags that have
// since been promoted to CURATED_SOURCES), or that swallows mid-iteration
// KV failures silently, would ship undetected.

import { describe, it, expect, vi } from 'vitest';
import { loadDiscoveredSources } from '~/queue/scrape-coordinator';
import { hasCuratedSource } from '~/lib/curated-sources';

interface KvBackingValue {
  feeds: Array<{ name: string; url: string; kind: 'rss' | 'atom' | 'json' }>;
}

interface KvKey {
  name: string;
}

/** Build a minimal KVNamespace stub backed by an in-memory Map.
 *  Per-key get/delete failures can be wired by name to model the
 *  partial-failure path. */
function makeKv(opts: {
  store: Map<string, KvBackingValue | string>;
  failGetFor?: Set<string>;
  failListAfter?: number;
}): { kv: KVNamespace; deleted: string[] } {
  const deleted: string[] = [];
  let listCalls = 0;
  const kv = {
    list: vi.fn(async () => {
      listCalls += 1;
      if (opts.failListAfter !== undefined && listCalls > opts.failListAfter) {
        throw new Error('list failed');
      }
      const keys: KvKey[] = Array.from(opts.store.keys())
        .filter((k) => k.startsWith('sources:'))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    }),
    get: vi.fn(async (name: string, _format: 'text') => {
      if (opts.failGetFor?.has(name)) throw new Error(`get failed for ${name}`);
      const v = opts.store.get(name);
      if (v === undefined) return null;
      return typeof v === 'string' ? v : JSON.stringify(v);
    }),
    delete: vi.fn(async (name: string) => {
      deleted.push(name);
      opts.store.delete(name);
    }),
    put: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
  return { kv, deleted };
}

const validFeed = {
  feeds: [{ name: 'Example', url: 'https://example.com/feed.xml', kind: 'rss' as const }],
};

describe('loadDiscoveredSources — REQ-DISC-001 / CF-015', () => {
  it('CF-015: skips and best-effort deletes sources:{tag} entries for curated-promoted tags', async () => {
    // Self-check the test fixture against the live registry — `cloudflare`
    // must remain a curated tag for this test to be meaningful. If the
    // registry ever drops it, the assertion below catches the broken
    // test premise instead of silently passing.
    expect(hasCuratedSource('cloudflare')).toBe(true);
    // The non-curated tag must NOT be in the registry — otherwise both
    // entries get purged and there's nothing to compare against.
    expect(hasCuratedSource('some-rare-tag')).toBe(false);

    const store = new Map<string, KvBackingValue>([
      ['sources:cloudflare', validFeed],
      ['sources:some-rare-tag', validFeed],
    ]);
    const { kv, deleted } = makeKv({ store });

    const out = await loadDiscoveredSources(kv);

    // The orphan was deleted (best-effort) AND skipped — no source row
    // emitted for the curated tag. The non-curated tag's feed survives.
    expect(deleted).toContain('sources:cloudflare');
    expect(deleted).not.toContain('sources:some-rare-tag');
    expect(out.partial).toBe(false);
    expect(out.sources.every((s) => s.discoveredTag !== 'cloudflare')).toBe(true);
    expect(out.sources.some((s) => s.discoveredTag === 'some-rare-tag')).toBe(true);
  });

  it('CF-015: per-key get failure is swallowed and reported via partial=true (other keys still succeed)', async () => {
    // Three entries: one fails on get (partial-failure model), two
    // succeed. The function must NOT abort mid-scan and must report
    // partial=true so the caller can log degraded state instead of
    // silently delivering an under-populated source set.
    const store = new Map<string, KvBackingValue>([
      ['sources:tag-a', validFeed],
      ['sources:tag-broken', validFeed],
      ['sources:tag-b', validFeed],
    ]);
    const { kv } = makeKv({
      store,
      failGetFor: new Set(['sources:tag-broken']),
    });

    const out = await loadDiscoveredSources(kv);

    expect(out.partial).toBe(true);
    // The two successful tags must still appear; the broken one drops
    // silently from the result without aborting the others.
    const tags = out.sources.map((s) => s.discoveredTag);
    expect(tags).toContain('tag-a');
    expect(tags).toContain('tag-b');
    expect(tags).not.toContain('tag-broken');
  });

  it('CF-015: list failure on the first call returns partial=true with whatever was collected (zero here)', async () => {
    const store = new Map<string, KvBackingValue>();
    const { kv } = makeKv({ store, failListAfter: 0 });

    const out = await loadDiscoveredSources(kv);

    expect(out.partial).toBe(true);
    expect(out.sources).toEqual([]);
  });

  it('CF-015: clean run with no orphans and no failures returns partial=false and no deletes', async () => {
    const store = new Map<string, KvBackingValue>([
      ['sources:tag-x', validFeed],
    ]);
    const { kv, deleted } = makeKv({ store });

    const out = await loadDiscoveredSources(kv);

    expect(out.partial).toBe(false);
    expect(deleted).toEqual([]);
    expect(out.sources.map((s) => s.discoveredTag)).toEqual(['tag-x']);
  });
});
