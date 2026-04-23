// Implements REQ-PIPE-001
//
// KV-backed, 10-minute shared cache for per-source / per-tag headline
// fetches. When many users share the same hashtag, the fan-out pipeline
// (`sources.ts` / the generation consumer) checks this cache first so
// a single network round-trip per {source,tag} is amortised across the
// cron window.
//
// Key format:  `headlines:{source_name}:{tag}`
// Value:       JSON-serialised `Headline[]`
// TTL:         600 seconds (10-minute amortisation window)
//
// Contracts:
//  - `readCachedHeadlines` returns `null` on miss, on corrupt JSON, or
//    when the value parses to anything that is not an array. Callers
//    must treat `null` as "cache miss" and fall through to a live fetch.
//  - `writeCachedHeadlines` never throws to the caller on KV failure;
//    the cache is an optimisation, not a correctness requirement. A
//    failed write is logged by the caller (if at all) and the digest
//    continues.
//  - No mutation of the passed-in array. The cache stores a JSON-stringified
//    snapshot, so callers may continue to mutate their working copy freely.

import type { Headline } from '~/lib/types';

/** TTL applied to every cache write, in seconds. */
const HEADLINE_CACHE_TTL_SECONDS = 600;

/**
 * Build the canonical KV key for a {source, tag} pair. Centralising the
 * format here means a key rename only touches this file.
 */
function headlineCacheKey(source: string, tag: string): string {
  return `headlines:${source}:${tag}`;
}

/**
 * Read the cached headlines for {source, tag} from KV.
 *
 * Returns the parsed `Headline[]` on hit, or `null` on any of:
 *  - missing key
 *  - stored JSON that does not parse
 *  - parsed value that is not an array
 *
 * The type-guard is intentionally permissive on the inner shape: the
 * writer already produced valid headlines, and the digest pipeline will
 * tolerate extra fields. Overvalidating here would slow down every
 * cache-hit read with no defensive value.
 */
export async function readCachedHeadlines(
  kv: KVNamespace,
  source: string,
  tag: string,
): Promise<Headline[] | null> {
  const key = headlineCacheKey(source, tag);
  const raw = await kv.get(key, 'text');
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed as Headline[];
  } catch {
    return null;
  }
}

/**
 * Write `headlines` to the cache under `headlines:{source}:{tag}` with a
 * 10-minute TTL. Errors from KV are swallowed — the cache is best-effort.
 */
export async function writeCachedHeadlines(
  kv: KVNamespace,
  source: string,
  tag: string,
  headlines: Headline[],
): Promise<void> {
  const key = headlineCacheKey(source, tag);
  try {
    await kv.put(key, JSON.stringify(headlines), {
      expirationTtl: HEADLINE_CACHE_TTL_SECONDS,
    });
  } catch {
    // Best-effort: never fail a digest because the cache write failed.
  }
}
