// Tests for src/lib/headline-cache.ts — REQ-GEN-003 (Source fan-out with
// caching). The cache is a thin KV wrapper; we mock the KVNamespace and
// assert key format, TTL, and miss/hit semantics.

import { describe, it, expect, vi } from 'vitest';
import {
  readCachedHeadlines,
  writeCachedHeadlines,
} from '~/lib/headline-cache';
import type { Headline } from '~/lib/types';

/** Minimal mock KV. Only `get` and `put` are used by the cache module. */
function makeKv(): {
  kv: KVNamespace;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn();
  const put = vi.fn().mockResolvedValue(undefined);
  const kv = { get, put } as unknown as KVNamespace;
  return { kv, get, put };
}

describe('headline-cache', () => {
  describe('readCachedHeadlines', () => {
    it('REQ-GEN-003: returns null on cache miss', async () => {
      const { kv, get } = makeKv();
      get.mockResolvedValue(null);
      const result = await readCachedHeadlines(kv, 'hackernews', 'cloudflare');
      expect(result).toBeNull();
      expect(get).toHaveBeenCalledWith('headlines:hackernews:cloudflare', 'text');
    });

    it('REQ-GEN-003: returns parsed headline array on cache hit', async () => {
      const stored: Headline[] = [
        {
          title: 'Workers AI now free',
          url: 'https://blog.cloudflare.com/workers-ai',
          source_name: 'hackernews',
        },
        {
          title: 'D1 GA',
          url: 'https://blog.cloudflare.com/d1',
          source_name: 'hackernews',
        },
      ];
      const { kv, get } = makeKv();
      get.mockResolvedValue(JSON.stringify(stored));
      const result = await readCachedHeadlines(kv, 'hackernews', 'cloudflare');
      expect(result).toEqual(stored);
    });

    it('REQ-GEN-003: returns null on corrupt JSON', async () => {
      const { kv, get } = makeKv();
      get.mockResolvedValue('{{not valid json');
      const result = await readCachedHeadlines(kv, 'googlenews', 'ai');
      expect(result).toBeNull();
    });

    it('REQ-GEN-003: returns null when stored JSON is not an array', async () => {
      const { kv, get } = makeKv();
      get.mockResolvedValue(JSON.stringify({ oops: true }));
      const result = await readCachedHeadlines(kv, 'reddit', 'typescript');
      expect(result).toBeNull();
    });

    it('REQ-GEN-003: key format is headlines:{source}:{tag}', async () => {
      const { kv, get } = makeKv();
      get.mockResolvedValue(null);
      await readCachedHeadlines(kv, 'reddit', 'aws');
      expect(get).toHaveBeenCalledWith('headlines:reddit:aws', 'text');
    });
  });

  describe('writeCachedHeadlines', () => {
    it('REQ-GEN-003: writes JSON-serialised array with expirationTtl: 600', async () => {
      const { kv, put } = makeKv();
      const headlines: Headline[] = [
        {
          title: 'Foo',
          url: 'https://example.com/foo',
          source_name: 'hackernews',
        },
      ];
      await writeCachedHeadlines(kv, 'hackernews', 'cloudflare', headlines);
      expect(put).toHaveBeenCalledTimes(1);
      const [key, value, opts] = put.mock.calls[0] ?? [];
      expect(key).toBe('headlines:hackernews:cloudflare');
      expect(value).toBe(JSON.stringify(headlines));
      expect(opts).toEqual({ expirationTtl: 600 });
    });

    it('REQ-GEN-003: writes an empty array without error', async () => {
      const { kv, put } = makeKv();
      await writeCachedHeadlines(kv, 'reddit', 'mcp', []);
      expect(put).toHaveBeenCalledTimes(1);
      const [key, value, opts] = put.mock.calls[0] ?? [];
      expect(key).toBe('headlines:reddit:mcp');
      expect(value).toBe('[]');
      expect(opts).toEqual({ expirationTtl: 600 });
    });

    it('REQ-GEN-003: swallows KV put errors (cache is best-effort)', async () => {
      const { kv, put } = makeKv();
      put.mockRejectedValue(new Error('kv unavailable'));
      await expect(
        writeCachedHeadlines(kv, 'googlenews', 'ai', []),
      ).resolves.toBeUndefined();
    });
  });
});
