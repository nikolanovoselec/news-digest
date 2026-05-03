// Implements REQ-DISC-001, REQ-DISC-003, REQ-DISC-005
//
// LLM-assisted source discovery for per-tag RSS/Atom/JSON feeds.
//
// Pipeline per tag (REQ-DISC-001):
//   1. One Workers AI call with DISCOVERY_SYSTEM + discoveryUserPrompt(tag).
//   2. Parse strict JSON. Unparseable → empty feed list (treated as failure).
//   3. For every suggested URL, independently:
//       a. isUrlSafe() — HTTPS-only, no private/loopback/link-local ranges
//          (SSRF filter runs BEFORE any fetch — REQ-DISC-005 AC 3/4).
//       b. HTTPS GET with AbortSignal.timeout(5000) and a 1 MB body cap.
//       c. Content-Type must match declared kind (xml/atom for rss/atom,
//          json for json).
//       d. Parse (fast-xml-parser for xml/atom, JSON.parse for json).
//       e. Must yield ≥1 item with both title and url.
//   4. Persist passing feeds to `sources:{tag}` KV with no TTL.
//
// processPendingDiscoveries() is the cron hook: picks up to N distinct
// tags from pending_discoveries, runs discoverTag on each, writes the KV
// entry on success, and tracks consecutive-discovery-failures via KV
// `discovery_failures:{tag}` (counter with 7-day TTL per REQ-DISC-003
// AC 5). After CONSECUTIVE_FAILURE_LIMIT attempts without a usable feed,
// the tag is parked (empty `sources:{tag}` + pending row cleared) so
// REQ-DISC-004 can surface a Re-discover button on the settings page.

import { XMLParser } from 'fast-xml-parser';
import { DISCOVERY_SYSTEM, discoveryUserPrompt, LLM_PARAMS } from '~/lib/prompts';
import { DEFAULT_MODEL_ID } from '~/lib/models';
import { extractResponsePayload, type AIRunResponse } from '~/lib/generate';
import { isUrlSafe } from '~/lib/ssrf';
import { log } from '~/lib/log';
import type { DiscoveredFeed, SourcesCacheValue } from '~/lib/types';
import {
  FEED_FETCH_TIMEOUT_MS,
  FEED_MAX_BODY_BYTES,
} from '~/lib/fetch-policy';
import { hasCuratedSource } from '~/lib/curated-sources';

const FETCH_TIMEOUT_MS = FEED_FETCH_TIMEOUT_MS;
const MAX_BODY_BYTES = FEED_MAX_BODY_BYTES;
/** Evict after 2 consecutive discovery failures. Mirrors the per-feed
 * eviction threshold in REQ-DISC-003 AC 2 applied at the tag level:
 * two attempts without a usable feed and the tag is parked. */
const CONSECUTIVE_FAILURE_LIMIT = 2;
/** 7-day TTL for failure counters to prevent unbounded KV growth. */
const FAILURE_COUNTER_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Shape the Workers AI response is expected to conform to. */
interface LLMDiscoveryPayload {
  feeds?: Array<{
    name?: unknown;
    url?: unknown;
    kind?: unknown;
  }>;
}

/**
 * Run one-shot discovery for {@link tag}. Returns every feed that passed
 * the full validation pipeline. The LLM call is wrapped in try/catch so a
 * transient failure returns an empty array (the cron caller decides what
 * to do with that; this function has no side effects).
 */
export async function discoverTag(tag: string, env: Env): Promise<DiscoveredFeed[]> {
  // 1. Ask the LLM for candidate URLs. The Workers AI `.run` signature
  // varies per model, so we build the params as a plain object and cast
  // through `unknown` to hand it off — the return shape is also model-
  // dependent, so we narrow it at the usage site.
  const userPrompt = discoveryUserPrompt(tag);
  let payloadRaw: unknown;
  try {
    // The `@cf/openai/*` family (incl. the current default
    // gpt-oss-120b) only accepts the chat-completions `messages`
    // shape — calling with `{prompt: "..."}` returns an
    // effectively-empty envelope, which shows up as
    // `empty_llm_response` on every tick. Mirror the chunk consumer
    // (src/queue/scrape-chunk-consumer.ts) and send role-tagged
    // messages so the same call shape works across every model in
    // MODELS.
    const runParams = {
      messages: [
        { role: 'system', content: DISCOVERY_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      ...LLM_PARAMS,
    };
    // Preserve `this` binding — `env.AI.run` may be a method that
    // depends on the receiver. The cast through `unknown` sidesteps
    // Workers AI's per-model overload resolution.
    const ai = env.AI as unknown as {
      run: (model: string, params: Record<string, unknown>) => Promise<AIRunResponse>;
    };
    const result = await ai.run(DEFAULT_MODEL_ID, runParams);
    // Workers AI returns two shapes: flat `{response: "..."}` for
    // Llama/Mistral/Kimi, and the OpenAI envelope
    // `{choices:[{message:{content:"..."}}]}` for every @cf/openai/*
    // model. extractResponsePayload tolerates both.
    payloadRaw = extractResponsePayload(result);
    if (
      payloadRaw === undefined ||
      payloadRaw === null ||
      (typeof payloadRaw === 'string' && payloadRaw === '')
    ) {
      log('warn', 'discovery.completed', {
        tag,
        status: 'empty_llm_response',
      });
      return [];
    }
  } catch (err) {
    log('error', 'discovery.completed', {
      tag,
      status: 'llm_failed',
      detail: String(err).slice(0, 500),
    });
    return [];
  }

  // 2. Normalise to a parsed object. extractResponsePayload can return
  // either the raw JSON string (text-generation models) or an already-
  // parsed object (models that honour `response_format: json_object`
  // by inlining the shape). Accept both paths.
  let payload: LLMDiscoveryPayload;
  if (typeof payloadRaw === 'string') {
    try {
      payload = JSON.parse(payloadRaw) as LLMDiscoveryPayload;
    } catch {
      log('warn', 'discovery.completed', {
        tag,
        status: 'llm_invalid_json',
      });
      return [];
    }
  } else if (typeof payloadRaw === 'object') {
    // The earlier `payloadRaw === null` early-return already excludes
    // null, so the redundant runtime null check that was here was
    // flagged by CodeQL #166 (js/comparison-between-incompatible-types)
    // as comparing a non-nullable type to null.
    payload = payloadRaw as LLMDiscoveryPayload;
  } else {
    log('warn', 'discovery.completed', {
      tag,
      status: 'llm_invalid_json',
    });
    return [];
  }

  // Log the missing-feeds case explicitly so operators see a breadcrumb
  // when the model returns a shaped object with no `feeds` key (e.g.
  // `{feeds_list: [...]}` — a known deviation from the prompt that
  // produced silent no-ops before this guard was added).
  if (!Array.isArray(payload.feeds)) {
    log('warn', 'discovery.completed', {
      tag,
      status: 'llm_missing_feeds_field',
    });
    return [];
  }
  const suggestions = payload.feeds;
  const validated: DiscoveredFeed[] = [];

  // 3. Independently validate each suggestion — a malicious or broken
  // suggestion cannot taint the rest of the batch.
  for (const suggestion of suggestions) {
    const name = typeof suggestion.name === 'string' ? suggestion.name.trim() : '';
    const url = typeof suggestion.url === 'string' ? suggestion.url.trim() : '';
    const kind = suggestion.kind;
    if (name === '' || url === '') continue;
    if (kind !== 'rss' && kind !== 'atom' && kind !== 'json') continue;

    const ok = await validateFeedUrl(url, kind);
    if (ok) {
      validated.push({ name, url, kind });
    }
  }

  return validated;
}

/**
 * Validate a single candidate feed URL. Every step is an independent
 * gate — any failure short-circuits to false. Never throws.
 *
 * - SSRF filter (HTTPS only, no private/loopback/link-local, no userinfo)
 * - HTTP 200 with 5s timeout
 * - Content-Type matches the declared kind
 * - Body size ≤ 1 MB
 * - Parses and yields ≥1 item with title AND url
 */
export async function validateFeedUrl(
  url: string,
  kind: 'rss' | 'atom' | 'json',
): Promise<boolean> {
  // Gate 1 — static SSRF filter (no network call yet).
  if (!isUrlSafe(url)) {
    return false;
  }

  // Gate 2 — GET with 5s timeout.
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'news-digest-discovery' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch {
    return false;
  }

  if (!response.ok) {
    return false;
  }

  // Gate 3 — Content-Type must match the declared kind. The match is
  // lenient on the surrounding MIME noise (charset params, `application/`
  // vs `text/` prefixes); the keyword must appear.
  const contentType = (response.headers.get('Content-Type') ?? '').toLowerCase();
  if (!contentTypeMatches(contentType, kind)) {
    return false;
  }

  // Gate 4 — bounded read. We cannot trust the Content-Length header,
  // so slice the body after reading to the cap.
  let body: string;
  try {
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) {
      return false;
    }
    body = text;
  } catch {
    return false;
  }

  // Gate 5 — parse + item check.
  if (kind === 'json') {
    return hasJsonItem(body);
  }
  return hasXmlItem(body, kind);
}

/** True iff {@link contentType} names the MIME family {@link kind} speaks. */
function contentTypeMatches(contentType: string, kind: 'rss' | 'atom' | 'json'): boolean {
  if (kind === 'json') {
    return contentType.includes('json');
  }
  // RSS is `application/rss+xml`, Atom is `application/atom+xml`.
  // A plain `application/xml` or `text/xml` is also acceptable for both.
  return (
    contentType.includes('xml') ||
    contentType.includes('rss') ||
    contentType.includes('atom')
  );
}

/**
 * Return true iff {@link body} parses as a JSON Feed with at least one
 * entry carrying a non-empty `title` AND a non-empty `url`. Never throws.
 *
 * Accepts the JSON Feed 1.x shape (`{ items: [{ title, url }, ...] }`).
 */
function hasJsonItem(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object') return false;
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return false;
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    const title = (item as { title?: unknown }).title;
    const url = (item as { url?: unknown }).url;
    if (
      typeof title === 'string' &&
      title.trim() !== '' &&
      typeof url === 'string' &&
      url.trim() !== ''
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Return true iff {@link body} parses as RSS 2.0 or Atom 1.0 with at
 * least one item/entry carrying both a title and a link URL. Never
 * throws — unparseable XML is treated as a failure.
 */
function hasXmlItem(body: string, kind: 'rss' | 'atom'): boolean {
  let doc: unknown;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      trimValues: true,
    });
    doc = parser.parse(body);
  } catch {
    return false;
  }

  if (doc === null || typeof doc !== 'object') return false;

  if (kind === 'rss') {
    const rss = (doc as { rss?: unknown }).rss;
    if (rss === null || typeof rss !== 'object') return false;
    const channel = (rss as { channel?: unknown }).channel;
    if (channel === null || typeof channel !== 'object') return false;
    // fast-xml-parser collapses single children to non-arrays; normalise
    // here so the iteration works for both 1-item and N-item feeds.
    const items = asArray((channel as { item?: unknown }).item);
    for (const item of items) {
      if (itemHasTitleAndLink(item, 'rss')) return true;
    }
    return false;
  }

  // Atom 1.0 — top-level <feed><entry>...</entry></feed>.
  const feed = (doc as { feed?: unknown }).feed;
  if (feed === null || typeof feed !== 'object') return false;
  const entries = asArray((feed as { entry?: unknown }).entry);
  for (const entry of entries) {
    if (itemHasTitleAndLink(entry, 'atom')) return true;
  }
  return false;
}

/** Normalise a parser result into an array. `undefined` → `[]`, a single
 * element → `[element]`, an array → unchanged. */
function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

/** True iff an RSS <item> or Atom <entry> carries title AND link URL. */
function itemHasTitleAndLink(item: unknown, kind: 'rss' | 'atom'): boolean {
  if (item === null || typeof item !== 'object') return false;
  const titleRaw = (item as { title?: unknown }).title;
  const title =
    typeof titleRaw === 'string'
      ? titleRaw.trim()
      : titleRaw !== null && typeof titleRaw === 'object'
        ? String((titleRaw as { '#text'?: unknown })['#text'] ?? '').trim()
        : '';
  if (title === '') return false;

  const linkRaw = (item as { link?: unknown }).link;
  if (kind === 'rss') {
    // RSS: <link>https://...</link>
    if (typeof linkRaw === 'string') return linkRaw.trim() !== '';
    // Some RSS feeds encode guid/link as objects with `#text`.
    if (linkRaw !== null && typeof linkRaw === 'object') {
      const txt = (linkRaw as { '#text'?: unknown })['#text'];
      return typeof txt === 'string' && txt.trim() !== '';
    }
    return false;
  }

  // Atom: <link href="..."/> — possibly an array if the entry has
  // multiple links (e.g., alternate + self).
  const linkArr = Array.isArray(linkRaw) ? linkRaw : [linkRaw];
  for (const link of linkArr) {
    if (link === null || typeof link !== 'object') continue;
    const href = (link as { '@_href'?: unknown })['@_href'];
    if (typeof href === 'string' && href.trim() !== '') return true;
  }
  return false;
}

/**
 * Cron worker hook — process up to {@link limit} distinct pending tags.
 *
 * For each tag:
 *   - Run discoverTag().
 *   - On success (≥1 feed): write `sources:{tag}` KV, reset the failure
 *     counter, DELETE the pending rows.
 *   - On failure (0 feeds): increment `discovery_failures:{tag}`. If the
 *     counter has now reached the threshold, DELETE the pending rows
 *     (give up) and write a placeholder `sources:{tag}` with an empty
 *     feeds array so REQ-DISC-004 can surface a "Re-discover" button.
 *     Otherwise leave the pending rows in place so the next cron retries.
 *
 * Returns the tags that resolved one way or the other this invocation —
 * `processed` for tags that produced a sources entry, `failed` for tags
 * that were retried or evicted without producing one.
 */
export async function processPendingDiscoveries(
  env: Env,
  limit = 3,
): Promise<{ processed: string[]; failed: string[] }> {
  const processed: string[] = [];
  const failed: string[] = [];

  // Pick the next `limit` tags by earliest added_at for each tag.
  // GROUP BY tag collapses per-user duplicates so we don't discover the
  // same tag more than once per cron invocation.
  const rows = await env.DB.prepare(
    'SELECT tag FROM pending_discoveries GROUP BY tag ORDER BY MIN(added_at) LIMIT ?1',
  )
    .bind(limit)
    .all<{ tag: string }>();

  const tags = (rows.results ?? []).map((r) => r.tag).filter((t) => typeof t === 'string' && t !== '');

  for (const tag of tags) {
    // REQ-DISC-001 AC 1 — discovery is short-circuited for tags covered
    // by the curated registry. Catch any pending rows that bypassed the
    // user-facing gate (admin paths, pre-fix rows): clear the row and
    // skip the LLM call entirely. Counted as `processed` because the
    // tag has a working source — it's just not coming from discovery.
    if (hasCuratedSource(tag)) {
      await env.DB.prepare('DELETE FROM pending_discoveries WHERE tag = ?1')
        .bind(tag)
        .run();
      processed.push(tag);
      log('info', 'discovery.completed', {
        tag,
        status: 'skipped_curated',
      });
      continue;
    }

    try {
      const feeds = await discoverTag(tag, env);

      if (feeds.length > 0) {
        // Success path — persist, reset counter, clear pending.
        const cacheValue: SourcesCacheValue = {
          feeds,
          discovered_at: Date.now(),
        };
        await env.KV.put(`sources:${tag}`, JSON.stringify(cacheValue));
        await env.KV.delete(`discovery_failures:${tag}`);
        await env.DB.prepare('DELETE FROM pending_discoveries WHERE tag = ?1')
          .bind(tag)
          .run();
        processed.push(tag);
        log('info', 'discovery.completed', {
          tag,
          status: 'success',
          feed_count: feeds.length,
        });
        continue;
      }

      // Failure path — increment the counter.
      const priorRaw = await env.KV.get(`discovery_failures:${tag}`);
      const prior = priorRaw === null ? 0 : Number.parseInt(priorRaw, 10);
      const nextCount = Number.isFinite(prior) && prior >= 0 ? prior + 1 : 1;

      if (nextCount >= CONSECUTIVE_FAILURE_LIMIT) {
        // Give up — write an empty feeds entry so the settings page
        // can surface the Re-discover button, reset the counter, and
        // clear the pending row.
        const emptyCache: SourcesCacheValue = {
          feeds: [],
          discovered_at: Date.now(),
        };
        await env.KV.put(`sources:${tag}`, JSON.stringify(emptyCache));
        await env.KV.delete(`discovery_failures:${tag}`);
        await env.DB.prepare('DELETE FROM pending_discoveries WHERE tag = ?1')
          .bind(tag)
          .run();
        failed.push(tag);
        log('warn', 'discovery.completed', {
          tag,
          status: 'evicted',
          failure_count: nextCount,
        });
      } else {
        await env.KV.put(`discovery_failures:${tag}`, String(nextCount), {
          expirationTtl: FAILURE_COUNTER_TTL_SECONDS,
        });
        failed.push(tag);
        log('warn', 'discovery.completed', {
          tag,
          status: 'retry',
          failure_count: nextCount,
        });
      }
    } catch (err) {
      // Unexpected error at the tag level — count as a retryable failure
      // so we don't lose the pending row on transient infra issues.
      failed.push(tag);
      log('error', 'discovery.completed', {
        tag,
        status: 'error',
        detail: String(err).slice(0, 500),
      });
    }
  }

  return { processed, failed };
}
