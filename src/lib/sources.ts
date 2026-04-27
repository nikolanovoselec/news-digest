// Implements REQ-PIPE-001
// Implements REQ-PIPE-002
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
// `source.fetch.failed` but never propagates up — the caller decides
// whether `all sources failed` is a terminal condition.
// URLs are canonicalised with `~/lib/canonical-url` and deduplicated on
// the canonical form, with tag-specific feeds given priority so they
// land first when the 100-item cap is applied upstream.

import { XMLParser } from 'fast-xml-parser';
import { canonicalize } from '~/lib/canonical-url';
import type { DiscoveredFeed, Headline } from '~/lib/types';
import { isUrlSafe } from '~/lib/ssrf';
import { readCachedHeadlines, writeCachedHeadlines } from '~/lib/headline-cache';
import { log } from '~/lib/log';
import { mapConcurrent } from '~/lib/concurrency';
import { stripHtmlToText } from '~/lib/html-text';
import { FEED_FETCH_TIMEOUT_MS as FETCH_TIMEOUT_MS } from '~/lib/fetch-policy';

/** Hard-cap returned by `fanOutForTags`. 300 overflowed
 * llama-3.1-8b-instruct-fp8-fast's 30K token context window: ~24K
 * input tokens left no room for the 16K max_output. 100 keeps the
 * input at ~8K so input + output comfortably fits in 30K with
 * headroom. The LLM still picks the top 6 articles — fewer headlines
 * just means a tighter candidate pool, which raises the bar for what
 * gets summarized. */
const MAX_COMBINED_HEADLINES = 100;
/** 1 MB cap on the decoded body — NOT the same shape as
 *  `FEED_MAX_BODY_BYTES`: this caps the post-decode character count
 *  passed to the parser, not the raw response byte length. Kept
 *  module-local so a future maintainer doesn't silently switch the
 *  semantic during a fetch-policy "completion" pass. */
const FETCH_MAX_BYTES = 1_024 * 1_024;
/** Source-fetch concurrency cap across every {tag × source} pair.
 *  CF-008: renamed from GLOBAL_CONCURRENCY so the constant doesn't
 *  collide with the coordinator's own concurrency cap. */
const SOURCE_FETCH_CONCURRENCY = 10;
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
      // HN Algolia returns `story_text` for self-posts (Ask HN etc.)
      // and `_highlightResult.story_text.value` with HTML matches.
      // Use the plain `story_text` when available.
      const story = asString(hit['story_text']);
      const snippet =
        story !== null && story.length >= 40
          ? htmlSnippetToText(story)
          : null;
      out.push({
        title,
        url,
        source_name: 'hackernews',
        ...(snippet !== null ? { snippet } : {}),
      });
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
      // Reddit has `selftext` (self-posts) and `title` itself can
      // be the whole post. Prefer selftext when long enough.
      const selftext = asString(d['selftext']);
      const snippet =
        selftext !== null && selftext.length >= 40
          ? htmlSnippetToText(selftext)
          : null;
      out.push({
        title,
        url,
        source_name: 'reddit',
        ...(snippet !== null ? { snippet } : {}),
      });
    }
    return out;
  },
};

/** The three generic sources fanned out for every hashtag. */
export const GENERIC_SOURCES: SourceAdapter[] = [HACKER_NEWS, GOOGLE_NEWS, REDDIT];

// ---------- Fetch one source for one tag ---------------------------------

/**
 * Outcome of a single source fetch. `headlines` mirrors the legacy
 * return shape; `success` distinguishes "fetch reached a parseable
 * body" (even if the feed was empty) from "fetch never got there"
 * (HTTP error, network failure, unparseable body). Cache hits are
 * reported as `success: true` with `fetched: false` so the caller can
 * skip health updates when no live fetch took place.
 *
 * Implements REQ-DISC-003 — the coordinator consumes `success` to
 * drive the per-feed health counter.
 */
export interface SourceFetchResult {
  headlines: Headline[];
  /** True iff a live fetch was attempted (cache miss). */
  fetched: boolean;
  /** True iff the fetch reached a parseable response body. */
  success: boolean;
}

/**
 * Fetch headlines for `tag` from `source`, returning both the
 * parsed headline list and the liveness outcome. Cache hits short-
 * circuit with `fetched: false, success: true`. Live fetches report
 * `success` based on whether we reached a parseable body — an empty
 * but valid feed is still a success.
 */
export async function fetchFromSourceWithResult(
  source: SourceAdapter,
  tag: string,
  kv: KVNamespace,
): Promise<SourceFetchResult> {
  const cached = await readCachedHeadlines(kv, source.name, tag);
  if (cached !== null) {
    return { headlines: cached, fetched: false, success: true };
  }

  const url = source.url(tag);
  let response: Response;
  try {
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
    return { headlines: [], fetched: true, success: false };
  }

  if (!response.ok) {
    log('warn', 'source.fetch.failed', {
      source: source.name,
      tag,
      reason: 'http',
      status: response.status,
    });
    return { headlines: [], fetched: true, success: false };
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
    return { headlines: [], fetched: true, success: false };
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
    return { headlines: [], fetched: true, success: false };
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
    return { headlines: [], fetched: true, success: false };
  }

  await writeCachedHeadlines(kv, source.name, tag, headlines);
  return { headlines, fetched: true, success: true };
}

/**
 * Fetch headlines for `tag` from `source`, checking the shared KV cache
 * first. On a cache miss, a live fetch is performed with 5s timeout and
 * 1MB body cap; successful results are written back to the cache with
 * a 10-minute TTL (see `headline-cache.ts`). Errors — network, HTTP,
 * parse, extract — are logged and surfaced as an empty array so the
 * caller can carry on with other sources.
 */

// ---------- Fan-out ------------------------------------------------------

/**
 * Fan out across every {tag × source} combination, respecting a global
 * concurrency cap of 10. `discoveredByTag` provides tag-specific feeds
 * discovered earlier (see `sources:{tag}` in KV) — those headlines are
 * preferred over generic sources when deduplication drops later
 * occurrences of a canonical URL, and they also come first in the
 * returned array so upstream 100-cap truncation keeps them.
 *
 * Returned headlines are deduplicated by canonical URL
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

  // Bounded fan-out across {tag × source} jobs. Results are returned
  // in input order so the dedup pass below sees deterministic precedence.
  type JobResult = {
    kind: 'discovered' | 'generic';
    tag: string;
    headlines: Headline[];
  };
  const results = await mapConcurrent<typeof jobs[number], JobResult>(
    jobs,
    SOURCE_FETCH_CONCURRENCY,
    async (job) => {
      const result = await fetchFromSourceWithResult(job.source, job.tag, kv);
      return { kind: job.kind, tag: job.tag, headlines: result.headlines };
    },
  );

  // Deduplicate by canonical URL. First occurrence wins for title /
  // source_name (tag-specific jobs come first in `jobs`), but the
  // `source_tags` array unions contributions from every tag that
  // produced the same URL — downstream the LLM needs to know that a
  // single canonical article can satisfy multiple user hashtags.
  const seen = new Map<string, Headline>();
  const order: string[] = [];
  for (const r of results) {
    for (const h of r.headlines) {
      const key = canonicalize(h.url);
      const existing = seen.get(key);
      if (existing !== undefined) {
        // CF-011: replace the existing entry with an immutable copy so
        // upstream callers that share a Headline reference (e.g. the
        // chunk consumer reading the same map) cannot observe a
        // half-updated source_tags array mid-iteration.
        const tags = new Set(existing.source_tags ?? []);
        tags.add(r.tag);
        seen.set(key, { ...existing, source_tags: Array.from(tags) });
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
        // Per-feed cap of 20 items for tag-specific sources.
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
    const published_at = parseFeedDate(item['date_published']);
    // JSON Feed 1.1: prefer plaintext `content_text`, fall back to
    // HTML `content_html` stripped, then the `summary` blurb.
    let snippet: string | null = null;
    const ct = asString(item['content_text']);
    if (ct !== null && ct.length >= 40) {
      snippet = htmlSnippetToText(ct);
    } else {
      const ch = asString(item['content_html']);
      if (ch !== null && ch.length >= 40) {
        snippet = htmlSnippetToText(ch);
      } else {
        const sum = asString(item['summary']);
        if (sum !== null && sum.length >= 40) {
          snippet = htmlSnippetToText(sum);
        }
      }
    }
    out.push({
      title,
      url,
      source_name: sourceName,
      ...(published_at !== null ? { published_at } : {}),
      ...(snippet !== null ? { snippet } : {}),
    });
  }
  return out;
}

/**
 * Parse a feed date string into unix seconds. Accepts RFC 2822 (RSS),
 * ISO 8601 (Atom / JSON Feed), and anything else Date.parse()
 * recognises. Returns null when the value is missing, not a string,
 * or unparseable — callers should fall back to ingestion time.
 *
 * Clamp-forward guard: feeds occasionally emit a date in the future
 * (clock skew on the producer, or a scheduled-post placeholder).
 * Accept only dates ≤ now + 1 day so a malformed feed can't backdate
 * a fresh article to last year by coincidence of a "1970" stamp
 * either — reject < 2000-01-01 as invalid and fall back.
 */
function parseFeedDate(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  const sec = Math.floor(ms / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  // Reject obvious garbage: pre-2000 epochs and future-dated > 1 day.
  if (sec < 946_684_800) return null;
  if (sec > nowSec + 86_400) return null;
  return sec;
}

/** fxp emits a single child as an object and multiple as an array. */
function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

/**
 * Extract text from an XML node that might be a string, a record
 * with `#text`, or a CDATA-containing object. `content:encoded`,
 * `description`, and Atom `summary`/`content` can all appear in any
 * of these shapes depending on the feed producer + fxp settings.
 */
function extractNodeText(node: unknown): string | null {
  if (typeof node === 'string') return node;
  if (isRecord(node)) {
    const text = node['#text'];
    if (typeof text === 'string') return text;
    const cdata = node['#cdata'];
    if (typeof cdata === 'string') return cdata;
  }
  return null;
}

/**
 * Strip HTML tags + collapse whitespace + HTML-entity-decode for
 * feed-snippet cleanup before the text lands in the LLM prompt. Caps
 * at 1200 characters so a giant `<content:encoded>` body can't blow
 * up the chunk prompt budget. Wraps the shared `stripHtmlToText`
 * helper in `~/lib/html-text`.
 */
function htmlSnippetToText(raw: string): string {
  return stripHtmlToText(raw, { maxLength: 1200 });
}

/**
 * Pull a usable body-snippet out of an RSS `<item>`. Checks
 * `content:encoded` (the full HTML body when the feed is
 * feature-complete), then `description` (usually a summary).
 * Returns the cleaned text or null if neither field was present.
 */
function rssItemSnippet(item: Record<string, unknown>): string | null {
  const candidates: Array<unknown> = [
    item['content:encoded'],
    item['content'],
    item['description'],
    item['summary'],
  ];
  for (const c of candidates) {
    const text = extractNodeText(c);
    if (text !== null && text !== '') {
      const cleaned = htmlSnippetToText(text);
      if (cleaned.length >= 40) return cleaned;
    }
  }
  return null;
}

/**
 * Atom `<entry>` equivalent: prefer `content` over `summary` (content
 * is the full body; summary is often a 1-line abstract).
 */
function atomEntrySnippet(entry: Record<string, unknown>): string | null {
  const candidates: Array<unknown> = [entry['content'], entry['summary']];
  for (const c of candidates) {
    const text = extractNodeText(c);
    if (text !== null && text !== '') {
      const cleaned = htmlSnippetToText(text);
      if (cleaned.length >= 40) return cleaned;
    }
  }
  return null;
}

function itemToHeadline(item: unknown, sourceName: string): Headline | null {
  if (!isRecord(item)) return null;
  const title = asString(item['title']);
  const link = asString(item['link']);
  if (title === null || link === null) return null;
  // RSS `<pubDate>` is the canonical item-date field (RFC 2822). Some
  // feeds emit ISO via Dublin Core `<dc:date>` — fxp exposes that as
  // `dc:date` in the parsed object. Fall back in order.
  const published_at =
    parseFeedDate(item['pubDate']) ??
    parseFeedDate(item['dc:date']) ??
    parseFeedDate(item['published']);
  const snippet = rssItemSnippet(item);
  return {
    title,
    url: link,
    source_name: sourceName,
    ...(published_at !== null ? { published_at } : {}),
    ...(snippet !== null ? { snippet } : {}),
  };
}

function entryToHeadline(entry: unknown, sourceName: string): Headline | null {
  if (!isRecord(entry)) return null;
  const title = asString(entry['title']);
  // Atom `<link>` can be a string, an object with `href`, or an array
  // of those. Pick the first one with an href (or take the string form).
  const linkNode = entry['link'];
  const url = atomLinkHref(linkNode);
  if (title === null || url === null) return null;
  // Atom: `<published>` is the original publication time;
  // `<updated>` is mandatory but shifts when the post is edited.
  // Prefer published, fall back to updated.
  const published_at =
    parseFeedDate(entry['published']) ?? parseFeedDate(entry['updated']);
  const snippet = atomEntrySnippet(entry);
  return {
    title,
    url,
    source_name: sourceName,
    ...(published_at !== null ? { published_at } : {}),
    ...(snippet !== null ? { snippet } : {}),
  };
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
