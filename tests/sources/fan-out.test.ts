// Tests for src/lib/sources.ts fan-out — REQ-GEN-003 (cache-first fetch,
// global concurrency cap, per-source error tolerance) and REQ-GEN-004
// (canonical-URL dedupe across combined pool) with the REQ-GEN-005
// 100-headline cap respected by the upstream caller.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fanOutForTags, fetchFromSource } from '~/lib/sources';
import type { SourceAdapter } from '~/lib/sources';
import type { Headline } from '~/lib/types';

// --- Helpers --------------------------------------------------------------

interface KvMock {
  kv: KVNamespace;
  getCalls: string[];
  putCalls: { key: string; value: string; opts?: unknown }[];
  /** Pre-load an entry so reads return it. */
  preload: (key: string, value: string) => void;
}

function makeKv(): KvMock {
  const store = new Map<string, string>();
  const getCalls: string[] = [];
  const putCalls: { key: string; value: string; opts?: unknown }[] = [];
  const get = vi.fn(async (key: string) => {
    getCalls.push(key);
    return store.get(key) ?? null;
  });
  const put = vi.fn(async (key: string, value: string, opts?: unknown) => {
    putCalls.push({ key, value, opts });
    store.set(key, value);
    return undefined;
  });
  const kv = { get, put } as unknown as KVNamespace;
  return {
    kv,
    getCalls,
    putCalls,
    preload: (key, value) => {
      store.set(key, value);
    },
  };
}

/** Stub global fetch to return 200 + a JSON body that the adapter's
 * extract() ignores — we only care that fetchFromSource goes through
 * the cache, body-cap, and write path correctly. */
function installFetchStub(
  impl?: (url: string) => Promise<Response> | Response,
): { calls: string[] } {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(url);
    if (impl !== undefined) {
      return impl(url);
    }
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

describe('fetchFromSource', () => {
  let fetchStub: ReturnType<typeof installFetchStub>;
  beforeEach(() => {
    fetchStub = installFetchStub();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('REQ-GEN-003: cache hit skips network entirely', async () => {
    const { kv, preload } = makeKv();
    const cached: Headline[] = [
      { title: 'cached', url: 'https://example.com/cached', source_name: 's1' },
    ];
    preload('headlines:s1:cloudflare', JSON.stringify(cached));

    const urlSpy = vi.fn().mockReturnValue('https://example.com/live');
    const extractSpy = vi.fn().mockReturnValue([]);
    const source: SourceAdapter = {
      name: 's1',
      kind: 'json',
      url: urlSpy,
      extract: extractSpy,
    };

    const result = await fetchFromSource(source, 'cloudflare', kv);
    expect(result).toEqual(cached);
    // Neither URL builder nor extract ran; global fetch untouched.
    expect(urlSpy).not.toHaveBeenCalled();
    expect(extractSpy).not.toHaveBeenCalled();
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('REQ-GEN-003: cache miss fetches + parses + writes cache with TTL 600', async () => {
    const { kv, putCalls } = makeKv();
    fetchStub = installFetchStub(
      () =>
        new Response(JSON.stringify({ hits: [{ title: 't', url: 'https://e/1' }] }), {
          status: 200,
        }),
    );

    const source: SourceAdapter = {
      name: 's-miss',
      kind: 'json',
      url: (_tag) => 'https://e/search',
      extract: (_parsed) => [
        { title: 't', url: 'https://e/1', source_name: 's-miss' },
      ],
    };
    const result = await fetchFromSource(source, 'generative-ai', kv);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe('t');
    expect(fetchStub.calls).toEqual(['https://e/search']);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.key).toBe('headlines:s-miss:ai');
    expect(putCalls[0]?.opts).toEqual({ expirationTtl: 600 });
  });

  it('REQ-GEN-003: non-2xx response yields empty array, no cache write', async () => {
    const { kv, putCalls } = makeKv();
    fetchStub = installFetchStub(() => new Response('nope', { status: 500 }));

    const source: SourceAdapter = {
      name: 's-500',
      kind: 'json',
      url: (_tag) => 'https://e/bad',
      extract: () => [],
    };
    const result = await fetchFromSource(source, 'mcp', kv);
    expect(result).toEqual([]);
    expect(putCalls).toEqual([]);
  });

  it('REQ-GEN-003: parse failure yields empty array, no cache write', async () => {
    const { kv, putCalls } = makeKv();
    fetchStub = installFetchStub(() => new Response('{not json', { status: 200 }));

    const source: SourceAdapter = {
      name: 's-parse',
      kind: 'json',
      url: (_tag) => 'https://e/parse',
      extract: () => [],
    };
    const result = await fetchFromSource(source, 'x', kv);
    expect(result).toEqual([]);
    expect(putCalls).toEqual([]);
  });
});

describe('fanOutForTags', () => {
  let fetchStub: ReturnType<typeof installFetchStub>;
  beforeEach(() => {
    fetchStub = installFetchStub();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('REQ-GEN-003: cache hits skip network for every {source, tag} pair', async () => {
    const { kv, preload } = makeKv();
    // Pre-populate cache for all 3 generic sources × 2 tags so fan-out
    // should do zero network calls.
    const tags = ['cloudflare', 'generative-ai'];
    for (const tag of tags) {
      for (const source of ['hackernews', 'googlenews', 'reddit']) {
        preload(
          `headlines:${source}:${tag}`,
          JSON.stringify([
            {
              title: `${source}-${tag}`,
              url: `https://example.com/${source}/${tag}`,
              source_name: source,
            },
          ]),
        );
      }
    }

    const out = await fanOutForTags(tags, kv, new Map());
    expect(out).toHaveLength(6);
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('REQ-GEN-003: global concurrency cap of 10 is honoured', async () => {
    // Build 30 stub generic jobs (10 tags × 3 generic sources). Track
    // the in-flight count through a shared counter; max observed must
    // stay <= 10.
    const { kv } = makeKv();
    let inflight = 0;
    let maxInflight = 0;

    fetchStub = installFetchStub(async () => {
      inflight++;
      if (inflight > maxInflight) maxInflight = inflight;
      // Let the scheduler actually interleave — a resolved promise
      // microtask yields control so other workers can pick up jobs.
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return new Response(JSON.stringify({ hits: [] }), { status: 200 });
    });

    const tags = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    await fanOutForTags(tags, kv, new Map());
    // Should be <= 10 at all times.
    expect(maxInflight).toBeLessThanOrEqual(10);
    // And should have actually achieved the cap on a 30-job workload.
    expect(maxInflight).toBe(10);
  });

  it('REQ-GEN-004: deduplicates headlines by canonical URL across sources', async () => {
    const { kv, preload } = makeKv();
    // Two sources emit the same canonical URL (http/https + trailing slash).
    preload(
      'headlines:hackernews:ai',
      JSON.stringify([
        {
          title: 'Shared story',
          url: 'http://example.com/story/',
          source_name: 'hackernews',
        },
        {
          title: 'HN unique',
          url: 'https://example.com/hn-unique',
          source_name: 'hackernews',
        },
      ]),
    );
    preload(
      'headlines:googlenews:ai',
      JSON.stringify([
        {
          title: 'Shared story (gn copy)',
          url: 'https://example.com/story',
          source_name: 'googlenews',
        },
      ]),
    );
    preload('headlines:reddit:ai', JSON.stringify([]));

    const out = await fanOutForTags(['generative-ai'], kv, new Map());
    const canonicalTitles = out.map((h) => h.title).sort();
    expect(canonicalTitles).toEqual(['HN unique', 'Shared story']);
  });

  it('REQ-GEN-003: tag-specific discovered feeds come before generic sources in output', async () => {
    const { kv, preload } = makeKv();
    // Discovered feed with 2 items pre-cached.
    preload(
      'headlines:feed:cloudflare-blog:cloudflare',
      JSON.stringify([
        {
          title: 'Discovered 1',
          url: 'https://blog.cloudflare.com/1',
          source_name: 'feed:cloudflare-blog',
        },
        {
          title: 'Discovered 2',
          url: 'https://blog.cloudflare.com/2',
          source_name: 'feed:cloudflare-blog',
        },
      ]),
    );
    // Generic sources all pre-cached too (with their own items).
    for (const source of ['hackernews', 'googlenews', 'reddit']) {
      preload(
        `headlines:${source}:cloudflare`,
        JSON.stringify([
          {
            title: `${source}-item`,
            url: `https://example.com/${source}`,
            source_name: source,
          },
        ]),
      );
    }

    // Build a fake discovered feed adapter that returns pre-cached items
    // (the stubbed extract() is not called because the cache hits).
    const discoveredAdapter: SourceAdapter = {
      name: 'feed:cloudflare-blog',
      kind: 'rss',
      url: () => 'https://blog.cloudflare.com/rss/',
      extract: () => [],
    };
    const discoveredByTag = new Map<string, SourceAdapter[]>([
      ['cloudflare', [discoveredAdapter]],
    ]);

    const out = await fanOutForTags(['cloudflare'], kv, discoveredByTag);
    // First two items must come from the discovered feed.
    expect(out[0]?.source_name).toBe('feed:cloudflare-blog');
    expect(out[1]?.source_name).toBe('feed:cloudflare-blog');
    // Generic-source items follow.
    const genericNames = out.slice(2).map((h) => h.source_name);
    expect(genericNames).toEqual(
      expect.arrayContaining(['hackernews', 'googlenews', 'reddit']),
    );
  });

  it('REQ-GEN-005: combined output capped at 100 headlines (fits 30K-context budget-tier models)', async () => {
    const { kv, preload } = makeKv();
    // 4 tags × 3 sources × 30 items = 360 candidates, 120 after unique URLs
    // per tag. Cap should clamp to 100.
    const tags = ['a', 'b', 'c', 'd'];
    let counter = 0;
    for (const tag of tags) {
      for (const source of ['hackernews', 'googlenews', 'reddit']) {
        const items: Headline[] = [];
        for (let i = 0; i < 30; i++) {
          items.push({
            title: `${tag}-${source}-${i}`,
            url: `https://example.com/${tag}/${source}/${i}-${counter++}`,
            source_name: source,
          });
        }
        preload(`headlines:${source}:${tag}`, JSON.stringify(items));
      }
    }
    const out = await fanOutForTags(tags, kv, new Map());
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toHaveLength(100);
  });

  it('REQ-GEN-003: a failing source does not fail the whole fan-out', async () => {
    const { kv, preload } = makeKv();
    preload(
      'headlines:hackernews:ai',
      JSON.stringify([
        {
          title: 'hn ok',
          url: 'https://example.com/hn',
          source_name: 'hackernews',
        },
      ]),
    );
    preload('headlines:reddit:ai', JSON.stringify([]));
    // googlenews has NO cache → will fall through to live fetch.

    fetchStub = installFetchStub(async (url) => {
      if (url.includes('news.google.com')) {
        return new Response('oops', { status: 500 });
      }
      return new Response(JSON.stringify({ hits: [] }), { status: 200 });
    });

    const out = await fanOutForTags(['generative-ai'], kv, new Map());
    // HN cached item must survive despite Google News 500.
    expect(out.map((h) => h.title)).toContain('hn ok');
  });
});
