// Implements REQ-GEN-003
//
// Source adapters and fan-out for the digest pipeline. Each generic
// source is a trusted HTTPS endpoint (Hacker News Algolia, Google News
// RSS, Reddit JSON) fetched with a 5-second timeout and a 1 MB body cap.
// Discovered tag-specific feeds are additionally gated through the SSRF
// validator before fetch — they come from an LLM and must be treated as
// untrusted.
//
// The fan-out runs every {tag × source} pair through a semaphore-backed
// concurrency cap of 10. A per-pair fetch failure is logged via
// `source.fetch.failed` but never propagates up — the caller (generate.ts)
// decides whether `all sources failed` triggers `error_code='all_sources_failed'`.
// URLs are canonicalised with `~/lib/canonical-url` and deduplicated on
// the canonical form, with tag-specific feeds given priority so they
// land first when the 100-item cap is applied upstream.

import { XMLParser } from 'fast-xml-parser';
import { canonicalize } from '~/lib/canonical-url';
import type { DiscoveredFeed, Headline } from '~/lib/types';
import { isUrlSafe } from '~/lib/ssrf';
import { readCachedHeadlines, writeCachedHeadlines } from '~/lib/headline-cache';
import { log } from '~/lib/log';

/** Hard-cap returned by `fanOutForTags`. 300 overflowed
 * llama-3.1-8b-instruct-fp8-fast's 30K token context window: ~24K
 * input tokens left no room for the 16K max_output. 100 keeps the
 * input at ~8K so input + output comfortably fits in 30K with
 * headroom. The LLM still picks the top 6 articles — fewer headlines
 * just means a tighter candidate pool, which raises the bar for what
 * gets summarized. */
const MAX_COMBINED_HEADLINES = 100;
/** 5-second per-fetch timeout (REQ-GEN-003, AC #4). */
const FETCH_TIMEOUT_MS = 5_000;
/** 1 MB cap on the response body (REQ-GEN-003, AC #4). */
const FETCH_MAX_BYTES = 1_024 * 1_024;
/** Global concurrency cap across every {tag × source} pair. */
const GLOBAL_CONCURRENCY = 10;
/** Max items pulled from a discovered (tag-specific) feed per tag. */
const DISCOVERED_FEED_ITEM_CAP = 20;

/** Shared XML parser — cheap to construct but re-use anyway for clarity. */
const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: true,
});

/**
 * A pluggable source adapter. Each concrete adapter knows how to build
 * its URL for a given tag, what parser to run on the body, and how to
 * extract the {title, url} pairs from the parsed shape.
 *
 * Trust boundary: generic sources (HN/Google/Reddit) are trusted and
 * NOT gated through the SSRF filter. Discovered feeds are converted to
 * an adapter in `fanOutForTags` and gated before fetch.
 */
export interface SourceAdapter {
  name: string;
  url: (tag: string) => string;
  headers?: Record<string, string>;
  kind: 'json' | 'rss' | 'atom';
  extract: (parsed: unknown) => Headline[];
}

// ---------- Generic sources ----------------------------------------------

/** `tag` is already lowercase, [a-z0-9-]+; percent-encode for safety. */
function q(tag: string): string {
  return encodeURIComponent(tag);
}

/** Hacker News Algolia search — returns newest stories matching the query. */
const HACKER_NEWS: SourceAdapter = {
  name: 'hackernews',
  kind: 'json',
  url: (tag) =>
    `https://hn.algolia.com/api/v1/search_by_date?query=${q(tag)}&tags=story&hitsPerPage=30`,
  extract: (parsed) => {
    if (!isRecord(parsed)) return [];
    const hits = parsed['hits'];
    if (!Array.isArray(hits)) return [];
    const out: Headline[] = [];
    for (const hit of hits) {
      if (!isRecord(hit)) continue;
      const title = asString(hit['title']) ?? asString(hit['story_title']);
      const url =
        asString(hit['url']) ??
        (typeof hit['objectID'] === 'string'
          ? `https://news.ycombinator.com/item?id=${hit['objectID']}`
          : null);
      if (title === null || url === null) continue;
      out.push({ title, url, source_name: 'hackernews' });
    }
    return out;
  },
};

/** Google News RSS — top headlines for the past day. */
const GOOGLE_NEWS: SourceAdapter = {
  name: 'googlenews',
  kind: 'rss',
  url: (tag) =>
    `https://news.google.com/rss/search?q=${q(tag)}+when%3A1d&hl=en-US&gl=US&ceid=US:en`,
  extract: (parsed) => extractRssItems(parsed, 'googlenews'),
};

/** Reddit search — top posts over the past day. Requires a UA header. */
const REDDIT: SourceAdapter = {
  name: 'reddit',
  kind: 'json',
  headers: { 'User-Agent': 'news-digest/1.0' },
  url: (tag) =>
    `https://www.reddit.com/search.json?q=${q(tag)}&t=day&sort=top&limit=25`,
  extract: (parsed) => {
    if (!isRecord(parsed)) return [];
    const data = parsed['data'];
    if (!isRecord(data)) return [];
    const children = data['children'];
    if (!Array.isArray(children)) return [];
    const out: Headline[] = [];
    for (const child of children) {
      if (!isRecord(child)) continue;
      const d = child['data'];
      if (!isRecord(d)) continue;
      const title = asString(d['title']);
      // Prefer the external URL posted to reddit; fall back to the
      // reddit thread itself for self-posts.
      const externalUrl = asString(d['url']) ?? asString(d['url_overridden_by_dest']);
      const permalink = asString(d['permalink']);
      const url =
        externalUrl !== null && !externalUrl.startsWith('/r/')
          ? externalUrl
          : permalink !== null
            ? `https://www.reddit.com${permalink}`
            : null;
      if (title === null || url === null) continue;
      out.push({ title, url, source_name: 'reddit' });
    }
    return out;
  },
};

/** The three generic sources fanned out for every hashtag. */
export const GENERIC_SOURCES: SourceAdapter[] = [HACKER_NEWS, GOOGLE_NEWS, REDDIT];

// ---------- Fetch one source for one tag ---------------------------------

/**
 * Fetch headlines for `tag` from `source`, checking the shared KV cache
 * first. On a cache miss, a live fetch is performed with 5s timeout and
 * 1MB body cap; successful results are written back to the cache with
 * a 10-minute TTL (see `headline-cache.ts`). Errors — network, HTTP,
 * parse, extract — are logged and surfaced as an empty array so the
 * caller can carry on with other sources.
 */
export async function fetchFromSource(
  source: SourceAdapter,
  tag: string,
  kv: KVNamespace,
): Promise<Headline[]> {
  const cached = await readCachedHeadlines(kv, source.name, tag);
  if (cached !== null) {
    return cached;
  }

  const url = source.url(tag);
  let response: Response;
  try {
    // exactOptionalPropertyTypes: passing `headers: undefined` explicitly
    // would be a type error, so only set it when the adapter has one.
    const init: RequestInit =
      source.headers === undefined
        ? { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
        : {
            headers: source.headers,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          };
    response = await fetch(url, init);
  } catch (err) {
    log('warn', 'source.fetch.failed', {
      source: source.name,
      tag,
      reason: 'network',
      detail: String(err).slice(0, 200),
    });
    return [];
  }

  if (!response.ok) {
    log('warn', 'source.fetch.failed', {
      source: source.name,
      tag,
      reason: 'http',
      status: response.status,
    });
    return [];
  }

  let body: string;
  try {
    body = await readBodyCapped(response);
  } catch (err) {
    log('warn', 'source.fetch.failed', {
      source: source.name,
      tag,
      reason: 'body',
      detail: String(err).slice(0, 200),
    });
    return [];
  }

  let parsed: unknown;
  try {
    parsed = source.kind === 'json' ? JSON.parse(body) : XML_PARSER.parse(body);
  } catch (err) {
    log('warn', 'source.fetch.failed', {
      source: source.name,
      tag,
      reason: 'parse',
      detail: String(err).slice(0, 200),
    });
    return [];
  }

  let headlines: Headline[];
  try {
    headlines = source.extract(parsed);
  } catch (err) {
    log('warn', 'source.fetch.failed', {
      source: source.name,
      tag,
      reason: 'extract',
      detail: String(err).slice(0, 200),
    });
    return [];
  }

  await writeCachedHeadlines(kv, source.name, tag, headlines);
  return headlines;
}

// ---------- Fan-out ------------------------------------------------------

/**
 * Fan out across every {tag × source} combination, respecting a global
 * concurrency cap of 10. `discoveredByTag` provides tag-specific feeds
 * discovered earlier (see `sources:{tag}` in KV) — those headlines are
 * preferred over generic sources when deduplication drops later
 * occurrences of a canonical URL, and they also come first in the
 * returned array so upstream 100-cap truncation keeps them.
 *
 * Returned headlines are deduplicated by canonical URL (REQ-GEN-004)
 * and truncated to {@link MAX_COMBINED_HEADLINES}.
 */
export async function fanOutForTags(
  tags: string[],
  kv: KVNamespace,
  discoveredByTag: Map<string, SourceAdapter[]>,
): Promise<Headline[]> {
  // Build a job list with tag-specific jobs ahead of generic jobs; the
  // semaphore preserves submission order for completion ordering too.
  interface Job {
    kind: 'discovered' | 'generic';
    tag: string;
    source: SourceAdapter;
  }
  const jobs: Job[] = [];
  for (const tag of tags) {
    const discovered = discoveredByTag.get(tag) ?? [];
    for (const source of discovered) {
      jobs.push({ kind: 'discovered', tag, source });
    }
  }
  for (const tag of tags) {
    for (const source of GENERIC_SOURCES) {
      jobs.push({ kind: 'generic', tag, source });
    }
  }

  // Simple semaphore: each worker pulls the next job index until the
  // list is exhausted. Results are stored in the same index so ordering
  // is preserved regardless of network latency.
  type JobResult =
    | { kind: 'discovered' | 'generic'; tag: string; headlines: Headline[] }
    | undefined;
  const results: JobResult[] = [];
  for (let i = 0; i < jobs.length; i++) {
    results.push(undefined);
  }
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      if (job === undefined) return;
      const headlines = await fetchFromSource(job.source, job.tag, kv);
      results[i] = { kind: job.kind, tag: job.tag, headlines };
    }
  };

  const workerCount = Math.min(GLOBAL_CONCURRENCY, jobs.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Deduplicate by canonical URL. First occurrence wins for title /
  // source_name (tag-specific jobs come first in `jobs`), but the
  // `source_tags` array unions contributions from every tag that
  // produced the same URL — downstream the LLM needs to know that a
  // single canonical article can satisfy multiple user hashtags.
  const seen = new Map<string, Headline>();
  const order: string[] = [];
  for (const r of results) {
    if (r === undefined) continue;
    for (const h of r.headlines) {
      const key = canonicalize(h.url);
      const existing = seen.get(key);
      if (existing !== undefined) {
        const tags = new Set(existing.source_tags ?? []);
        tags.add(r.tag);
        existing.source_tags = Array.from(tags);
        continue;
      }
      seen.set(key, { ...h, source_tags: [r.tag] });
      order.push(key);
      if (order.length >= MAX_COMBINED_HEADLINES) {
        break;
      }
    }
    if (order.length >= MAX_COMBINED_HEADLINES) break;
  }

  const out: Headline[] = [];
  for (const key of order) {
    const h = seen.get(key);
    if (h !== undefined) out.push(h);
  }
  return out;
}

/**
 * Convert a `DiscoveredFeed` list (from `sources:{tag}` in KV) into a
 * list of `SourceAdapter` jobs, dropping any URL that fails the SSRF
 * gate. Exposed so `generate.ts` can build the `discoveredByTag` map
 * for `fanOutForTags`.
 */
export function adaptersForDiscoveredFeeds(
  feeds: DiscoveredFeed[],
): SourceAdapter[] {
  const adapters: SourceAdapter[] = [];
  for (const feed of feeds) {
    if (!isUrlSafe(feed.url)) {
      log('warn', 'source.fetch.failed', {
        source: feed.name,
        reason: 'ssrf',
        url: feed.url,
      });
      continue;
    }
    const feedUrl = feed.url;
    const sourceName = `feed:${feed.name}`;
    adapters.push({
      name: sourceName,
      kind: feed.kind,
      url: () => feedUrl,
      extract: (parsed) => {
        const all =
          feed.kind === 'json'
            ? extractJsonFeed(parsed, sourceName)
            : extractRssItems(parsed, sourceName);
        // Per-feed cap of 20 items for tag-specific sources (REQ-GEN-003).
        return all.slice(0, DISCOVERED_FEED_ITEM_CAP);
      },
    });
  }
  return adapters;
}

// ---------- Body read with cap -------------------------------------------

/**
 * Read a response body as UTF-8 text, throwing if the resulting string
 * length exceeds {@link FETCH_MAX_BYTES}. The check is on character
 * count which is a conservative upper bound on UTF-8 byte count for
 * ASCII-dominant source bodies. Matches the pattern used in
 * `src/lib/discovery.ts` for consistency.
 */
async function readBodyCapped(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length > FETCH_MAX_BYTES) {
    throw new Error(`response body exceeded ${FETCH_MAX_BYTES} characters`);
  }
  return text;
}

// ---------- Extraction helpers -------------------------------------------

/** Type narrowing for plain-object parses from JSON/XML. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Coerce `v` to a non-empty string or return null. */
function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Pull RSS 2.0 / Atom items out of an fxp parse tree. Works for both
 * `<rss><channel><item>` and `<feed><entry>` shapes since both produce
 * either an object or an array under their parent depending on count.
 */
function extractRssItems(parsed: unknown, sourceName: string): Headline[] {
  if (!isRecord(parsed)) return [];

  // RSS: <rss><channel><item>...
  const rss = parsed['rss'];
  if (isRecord(rss)) {
    const channel = rss['channel'];
    if (isRecord(channel)) {
      const items = toArray(channel['item']);
      return items
        .map((item) => itemToHeadline(item, sourceName))
        .filter((h): h is Headline => h !== null);
    }
  }

  // Atom: <feed><entry>...
  const feed = parsed['feed'];
  if (isRecord(feed)) {
    const entries = toArray(feed['entry']);
    return entries
      .map((entry) => entryToHeadline(entry, sourceName))
      .filter((h): h is Headline => h !== null);
  }

  return [];
}

/**
 * JSON Feed 1.1 (`https://jsonfeed.org`) — the one JSON shape we
 * support for discovered feeds. Minimal: we only care about items with
 * a `url` and a `title`.
 */
function extractJsonFeed(parsed: unknown, sourceName: string): Headline[] {
  if (!isRecord(parsed)) return [];
  const items = parsed['items'];
  if (!Array.isArray(items)) return [];
  const out: Headline[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const title = asString(item['title']);
    const url = asString(item['url']) ?? asString(item['external_url']);
    if (title === null || url === null) continue;
    out.push({ title, url, source_name: sourceName });
  }
  return out;
}

/** fxp emits a single child as an object and multiple as an array. */
function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

function itemToHeadline(item: unknown, sourceName: string): Headline | null {
  if (!isRecord(item)) return null;
  const title = asString(item['title']);
  const link = asString(item['link']);
  if (title === null || link === null) return null;
  return { title, url: link, source_name: sourceName };
}

function entryToHeadline(entry: unknown, sourceName: string): Headline | null {
  if (!isRecord(entry)) return null;
  const title = asString(entry['title']);
  // Atom `<link>` can be a string, an object with `href`, or an array
  // of those. Pick the first one with an href (or take the string form).
  const linkNode = entry['link'];
  const url = atomLinkHref(linkNode);
  if (title === null || url === null) return null;
  return { title, url, source_name: sourceName };
}

function atomLinkHref(node: unknown): string | null {
  if (typeof node === 'string') return asString(node);
  if (Array.isArray(node)) {
    for (const entry of node) {
      const href = atomLinkHref(entry);
      if (href !== null) return href;
    }
    return null;
  }
  if (isRecord(node)) {
    const href = asString(node['href']);
    if (href !== null) return href;
    const text = asString(node['#text']);
    return text;
  }
  return null;
}
