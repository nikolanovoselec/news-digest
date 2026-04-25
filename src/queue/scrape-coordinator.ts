// Implements REQ-PIPE-001
// Implements REQ-DISC-003
//
// Coordinator for the global-feed scrape (every-4-hours cron `0 */4 * * *`).
// Receives one message per cron tick containing `{scrape_run_id}`; fans out across
// CURATED_SOURCES + discovered-tag feeds; canonical-dedupes the pool;
// filters out articles already present in `articles.canonical_url`;
// chunks survivors into slices of ≤100; and enqueues one
// `scrape-chunks` message per chunk. The per-run KV counter
// `scrape_run:{id}:chunks_remaining` is set to the chunk count before
// enqueue so the chunk consumer can atomically decrement and detect the
// last chunk via counter==0.
//
// Per-source fetch reuses the 10-worker semaphore pattern from
// src/lib/sources.ts (fetchFromSource + KV cache + 5s timeout + 1MB
// cap). Curated sources are trusted (not gated through SSRF), but
// discovered-tag feeds are synthesised on-the-fly via
// adaptersForDiscoveredFeeds so the SSRF gate still fires.

import {
  CURATED_SOURCES,
  type CuratedSource,
} from '~/lib/curated-sources';
import {
  adaptersForDiscoveredFeeds,
  fetchFromSourceWithResult,
  type SourceAdapter,
} from '~/lib/sources';
import { canonicalize } from '~/lib/canonical-url';
import { clusterByCanonical, type Candidate } from '~/lib/dedupe';
import { finishRun } from '~/lib/scrape-run';
import { clearHealth, recordFetchResult } from '~/lib/feed-health';
import { SYSTEM_USER_ID } from '~/lib/system-user';
import { log } from '~/lib/log';
import type { DiscoveredFeed, SourcesCacheValue, Headline } from '~/lib/types';

/** Max candidates per chunk. Matches the LLM's ~8K input-token budget
 * at the gpt-oss-20b default: ~50 candidate headlines per chunk
 * leaves per-article budget at ~800 output tokens (enough for the
 * 150-200-word prompt contract at ~280 toks/article + JSON
 * overhead), plus headroom for PROCESS_CHUNK_SYSTEM. Was 100 at
 * Gemma; 50 at gpt-oss-20b gives more per-article breathing
 * room without exploding the chunk count. The chunk size isn't
 * the primary lever on output length — the INPUT snippet length
 * is. A model with 300 chars of source material can't honestly
 * write 200 words regardless of how much output budget you give
 * it. Body-fetch quality matters more than chunk count. */
const CHUNK_SIZE = 50;

/** 10-worker semaphore cap for the fetch fan-out, mirroring
 * src/lib/sources.ts#GLOBAL_CONCURRENCY. The curated registry (~50
 * entries) plus discovered-tag feeds can easily exceed single-digit
 * parallelism without a cap. */
const GLOBAL_CONCURRENCY = 10;

/** KV counter TTL — 3 hours is generous relative to the 60-minute cron
 * cadence, giving slow chunks ample retry headroom without leaking
 * counter keys forever. */
const COUNTER_TTL_SECONDS = 3 * 3600;

/** Per-query IN-clause batch size for existing-canonical lookups. D1's
 * SQL string length cap (about 100KB compiled) comfortably handles 100
 * parameters per query; 100 keeps the query under the cap with margin. */
const EXISTING_URL_BATCH = 100;

/** Per-source item cap. Curated feeds frequently expose 50+ items;
 * downstream chunking and the global 10× chunk ceiling make a per-feed
 * cap the simplest lever to keep the pool balanced across sources. */
const PER_SOURCE_ITEM_CAP = 10;

/** Upper bound on chunks enqueued per tick. Guards against a discovered-
 * tag explosion inflating the candidate pool to unsafe levels. Normal
 * load: 52 curated × 10 items = 520 candidates / 50 per chunk =
 * 11 chunks. Cap at 40 leaves plenty of headroom for a discovered-
 * tag set without exploding LLM cost. */
const MAX_CHUNKS_PER_TICK = 40;

/** Return true if the URL is a plain http(s) URL. Rejects
 * `javascript:`, `data:`, `file:`, mailto:, etc. at the coordinator
 * layer so those schemes can never reach article_sources / primary_source_url
 * and end up rendered as an `href`. */
function isSafeWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Every `scrape-coordinator` queue message. Enqueued by the every-4-hours
 * cron branch in `src/worker.ts`. */
export interface CoordinatorMessage {
  scrape_run_id: string;
}

/** Queue handler entry point. Loops over each message in the batch;
 * Queues sets `max_batch_size = 1`, so in practice the loop runs once. */
export async function handleCoordinatorBatch(
  batch: MessageBatch<CoordinatorMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await runCoordinator(env, message.body);
      message.ack();
    } catch (err) {
      log('error', 'digest.generation', {
        status: 'coordinator_throw',
        scrape_run_id: message.body.scrape_run_id,
        attempts: message.attempts,
        detail: String(err).slice(0, 500),
      });
      // On final retry, mark the scrape_run as failed so /history and
      // /stats don't render orphans stuck at status='running' forever.
      // Queues uses 1-based attempts and max_retries=3 in wrangler.toml.
      if (message.attempts >= 3) {
        try {
          await finishRun(env.DB, message.body.scrape_run_id, 'failed');
        } catch (finishErr) {
          log('error', 'digest.generation', {
            status: 'coordinator_finish_failed_after_throw',
            scrape_run_id: message.body.scrape_run_id,
            detail: String(finishErr).slice(0, 500),
          });
        }
      }
      message.retry();
    }
  }
}

/** Run one coordinator pass end-to-end. Exported for direct testing
 * without the queue batch envelope. */
export async function runCoordinator(
  env: Env,
  body: CoordinatorMessage,
): Promise<void> {
  const { scrape_run_id } = body;

  // --- Step 0: Race guard — bail if this run already fanned out -------
  //
  // Queue delivery can double-dispatch the same message (retry-after-
  // ack-lost, stuck cron re-enqueue). A second run of the coordinator
  // for the same scrape_run_id would overwrite the KV
  // chunks_remaining counter AFTER the chunk consumer already
  // decremented it, breaking the "last chunk calls finishRun" math
  // and leaving the run stuck as `running` forever.
  //
  // If chunk_count > 0, a prior coordinator pass already fanned out
  // chunks for this run — skip this duplicate dispatch.
  try {
    const existing = await env.DB
      .prepare('SELECT chunk_count FROM scrape_runs WHERE id = ?1')
      .bind(scrape_run_id)
      .first<{ chunk_count: number | null }>();
    if (
      existing !== null &&
      typeof existing.chunk_count === 'number' &&
      existing.chunk_count > 0
    ) {
      log('warn', 'digest.generation', {
        status: 'coordinator_duplicate_dispatch',
        scrape_run_id,
        existing_chunk_count: existing.chunk_count,
      });
      return;
    }
  } catch (err) {
    log('warn', 'digest.generation', {
      status: 'coordinator_race_guard_select_failed',
      scrape_run_id,
      detail: String(err).slice(0, 500),
    });
    // Fall through — race guard is best-effort.
  }

  // --- Step 1: Build the full source list (curated + discovered) -------
  const discoveredSources = await loadDiscoveredSources(env.KV);
  const allSources: SourceForFetch[] = [
    ...CURATED_SOURCES.map((s) => ({
      adapter: curatedToAdapter(s),
      sourceName: s.name,
      feedUrl: s.feed_url,
      discoveredTag: null,
    })),
    ...discoveredSources,
  ];

  // --- Step 2: Fetch all sources in parallel (10-worker semaphore) ----
  // Health accounting (REQ-DISC-003): every per-source fetch records a
  // success or failure against `source_health:{url}` in KV. After the
  // fan-out completes, `fetchAllSources` returns the URLs whose counters
  // crossed the eviction threshold so the coordinator can act on them.
  const { rawHeadlines, evictions } = await fetchAllSources(env, allSources);

  // --- Step 2b: Apply evictions (REQ-DISC-003 AC 2-3) ----------------
  // For each URL that reached the fetch-failure threshold and was
  // attached to a `sources:{tag}` KV entry, remove the URL from that
  // tag's feed list. If the removal empties the feed list, enqueue a
  // system-owned re-discovery row so the next discovery cron repopulates
  // the tag with a fresh LLM suggestion.
  if (evictions.length > 0) {
    await applyEvictions(env, evictions, scrape_run_id);
  }

  // --- Step 3: Build candidate records (canonicalize + carry source) --
  //
  // Scheme gate: only http(s) candidates survive. A feed returning a
  // `javascript:` / `data:` / `file:` URL for an article link would
  // land as an unsafe href on the detail page's "Read at source"
  // button if we passed it through. Dropping at write time is the
  // strongest defence (render-time escaping of a literal `javascript:`
  // value in an href attribute is NOT enough — Astro's escaping
  // prevents HTML injection but a `javascript:` href is valid HTML).
  const candidates: Candidate[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  // Drop candidates whose source pubDate is more than 48 hours old.
  // Cron runs every 4 hours, so anything older than two days has
  // either been seen on a prior tick (and is already in the pool)
  // or is a backlog item the feed happens to still emit. Either way,
  // summarising it wastes LLM budget and clutters the dashboard with
  // 'new ingest, old publish_at' cards that sort below genuinely
  // fresh stories and make the feed look stuck. candidates with an
  // unparsable pubDate (we fall back to nowSec) are kept — a missing
  // date is not the same as a stale date.
  const FRESHNESS_WINDOW_SEC = 48 * 60 * 60;
  const staleCutoff = nowSec - FRESHNESS_WINDOW_SEC;
  let droppedStale = 0;
  let missingPubdateKept = 0;
  for (const row of rawHeadlines) {
    if (!isSafeWebUrl(row.headline.url)) continue;
    const canonical = canonicalize(row.headline.url);
    if (!isSafeWebUrl(canonical)) continue;
    const hasParsedPub =
      typeof row.headline.published_at === 'number' && row.headline.published_at > 0;
    const pub = hasParsedPub ? (row.headline.published_at as number) : nowSec;
    if (hasParsedPub && pub < staleCutoff) {
      droppedStale += 1;
      continue;
    }
    if (!hasParsedPub) {
      // Counter so operators can see how often backlog items with no
      // pubDate slip through the freshness filter — a blind spot of
      // the 'missing date is not stale date' decision.
      missingPubdateKept += 1;
    }
    candidates.push({
      canonical_url: canonical,
      source_url: row.headline.url,
      source_name: row.headline.source_name,
      title: row.headline.title,
      published_at: pub,
      ...(typeof row.headline.snippet === 'string' && row.headline.snippet !== ''
        ? { body_snippet: row.headline.snippet }
        : {}),
    });
  }
  if (droppedStale > 0 || missingPubdateKept > 0) {
    log('info', 'digest.generation', {
      op: 'coordinator_freshness',
      scrape_run_id,
      dropped_stale_backlog: droppedStale,
      missing_pubdate_kept: missingPubdateKept,
      freshness_window_hours: 48,
    });
  }

  // --- Step 4: Canonical cluster (dedupe duplicate URLs across sources) -
  const clusters = clusterByCanonical(candidates);

  // --- Step 5: Filter out canonical URLs already in articles -----------
  const existing = await loadExistingCanonicalUrls(
    env.DB,
    clusters.map((c) => c.primary.canonical_url),
  );
  const survivors = clusters.filter(
    (c) => !existing.has(c.primary.canonical_url),
  );
  // Re-freshen ingested_at for articles that are STILL IN the live
  // feed emission. Without this, a scrape tick that finds nothing
  // net-new leaves the dashboard order frozen on the previous tick's
  // ingestions — so a 4-hour-old article that's still actively
  // trending in its source feed looks "stale" to the user even
  // though it's freshly confirmed as current. Bumping ingested_at
  // lets sort-by-ingest surface whatever the feeds consider current
  // right now, not whatever happened to be ingested first. Batched
  // in groups of 100 to stay inside D1's parameter-count budget.
  const reSeenUrls = clusters
    .map((c) => c.primary.canonical_url)
    .filter((url) => existing.has(url));
  if (reSeenUrls.length > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    const REFRESH_BATCH = 100;
    for (let i = 0; i < reSeenUrls.length; i += REFRESH_BATCH) {
      const slice = reSeenUrls.slice(i, i + REFRESH_BATCH);
      const placeholders = slice.map((_, j) => `?${j + 2}`).join(', ');
      await env.DB
        .prepare(
          `UPDATE articles SET ingested_at = ?1 WHERE canonical_url IN (${placeholders})`,
        )
        .bind(nowSec, ...slice)
        .run();
    }
    log('info', 'digest.generation', {
      status: 'coordinator_refreshed_existing',
      scrape_run_id,
      re_seen: reSeenUrls.length,
    });
  }

  // --- Step 6: Empty-pool guard — close the run immediately -----------
  if (survivors.length === 0) {
    await finishRun(env.DB, scrape_run_id, 'ready');
    log('info', 'digest.generation', {
      status: 'coordinator_empty_pool',
      scrape_run_id,
    });
    return;
  }

  // NOTE: body-fetch was moved OUT of the coordinator into the
  // chunk consumer (src/queue/scrape-chunk-consumer.ts). Running
  // 500+ HTTP fetches inside the coordinator was exhausting its
  // execution budget before the SCRAPE_CHUNKS.send() loop could
  // run — chunks never enqueued, run stayed 'running' forever,
  // no articles ingested. Per-chunk fetch (100 URLs × 5s / 20
  // workers ≈ 25s) fits comfortably inside a chunk consumer's
  // budget and parallelises across chunks.

  // --- Step 7: Flatten clusters into chunk-ready candidates -----------
  const chunkCandidates = survivors.map((c) => {
    const existingSnippet = c.primary.body_snippet ?? '';
    return {
      canonical_url: c.primary.canonical_url,
      source_url: c.primary.source_url,
      source_name: c.primary.source_name,
      title: c.primary.title,
      published_at: c.primary.published_at,
      ...(existingSnippet !== '' ? { body_snippet: existingSnippet } : {}),
      alternatives: c.alternatives.map((alt) => ({
        source_url: alt.source_url,
        source_name: alt.source_name,
      })),
    };
  });

  // --- Step 8: Chunk + prime KV counter + enqueue ---------------------
  const chunks: typeof chunkCandidates[] = [];
  for (let i = 0; i < chunkCandidates.length; i += CHUNK_SIZE) {
    chunks.push(chunkCandidates.slice(i, i + CHUNK_SIZE));
  }
  // Hard cap: a discovered-tag explosion can't expand the per-tick LLM
  // fan-out past MAX_CHUNKS_PER_TICK. Any excess is simply deferred to
  // the next 4-hour tick (the existing-URL filter keeps tick-N+1 from
  // re-processing the chunks we emit this tick).
  const droppedChunks = Math.max(0, chunks.length - MAX_CHUNKS_PER_TICK);
  if (droppedChunks > 0) {
    log('warn', 'digest.generation', {
      status: 'coordinator_chunks_capped',
      scrape_run_id,
      total_chunks: chunks.length,
      kept_chunks: MAX_CHUNKS_PER_TICK,
      dropped_chunks: droppedChunks,
    });
    chunks.length = MAX_CHUNKS_PER_TICK;
  }
  const totalChunks = chunks.length;

  const counterKey = `scrape_run:${scrape_run_id}:chunks_remaining`;
  await env.KV.put(counterKey, String(totalChunks), {
    expirationTtl: COUNTER_TTL_SECONDS,
  });

  // Persist total chunk count on the scrape_runs row so the
  // /api/scrape-status endpoint can compute 'X of Y chunks done'
  // for the in-progress UI. Best-effort; a failure here is logged
  // but doesn't block the fan-out.
  try {
    await env.DB
      .prepare('UPDATE scrape_runs SET chunk_count = ?1 WHERE id = ?2')
      .bind(totalChunks, scrape_run_id)
      .run();
  } catch (err) {
    log('warn', 'digest.generation', {
      status: 'coordinator_chunk_count_update_failed',
      scrape_run_id,
      detail: String(err).slice(0, 500),
    });
  }

  for (let i = 0; i < chunks.length; i++) {
    const candidates = chunks[i] ?? [];
    await env.SCRAPE_CHUNKS.send({
      scrape_run_id,
      chunk_index: i,
      total_chunks: totalChunks,
      candidates,
    });
  }

  log('info', 'digest.generation', {
    status: 'coordinator_enqueued',
    scrape_run_id,
    candidate_pool: candidates.length,
    survivors: survivors.length,
    total_chunks: totalChunks,
  });
}

// ---------- internals ----------------------------------------------------

/** A source entry ready for fetchFromSourceWithResult — pairs an adapter
 * with the pretty name that will land in `articles.primary_source_name`,
 * the feed URL (used as the health-counter key), and the tag that owns
 * the URL in KV (null for curated sources, which have no runtime
 * eviction path). */
interface SourceForFetch {
  adapter: SourceAdapter;
  sourceName: string;
  feedUrl: string;
  /** Non-null only for URLs that originated from a `sources:{tag}` KV
   * entry — the coordinator can remove the URL from that entry if its
   * fetch-failure counter crosses the eviction threshold. */
  discoveredTag: string | null;
}

/** One evicted feed — emitted by fetchAllSources when a URL's health
 * counter crosses the threshold. Only discovered feeds participate
 * (curated URLs have `discoveredTag = null` and are skipped upstream). */
interface FeedEviction {
  tag: string;
  url: string;
  failureCount: number;
}

/** Convert a CuratedSource entry to a SourceAdapter that
 * fetchFromSourceWithResult() can drive. The adapter's URL is constant
 * (it ignores the `tag` argument) and the extract routes into the same
 * XMLParser / JSON-Feed path as discovered feeds. */
function curatedToAdapter(curated: CuratedSource): SourceAdapter {
  // Reuse adaptersForDiscoveredFeeds to get the extract() behaviour for
  // free. A curated source is just a DiscoveredFeed with a stable URL;
  // the SSRF gate inside adaptersForDiscoveredFeeds is a no-op on
  // curated URLs because they're HTTPS-only by invariant.
  const feed: DiscoveredFeed = {
    name: curated.name,
    url: curated.feed_url,
    kind: curated.kind,
  };
  const adapters = adaptersForDiscoveredFeeds([feed]);
  const first = adapters[0];
  if (first !== undefined) return first;
  // Shouldn't happen — if adaptersForDiscoveredFeeds rejects a curated
  // feed, we surface a no-op adapter that returns zero headlines so
  // fetch fan-out continues with the remaining sources.
  return {
    name: `curated:${curated.slug}`,
    kind: curated.kind,
    url: () => curated.feed_url,
    extract: () => [],
  };
}

/** Scan every `sources:{tag}` KV entry and synthesise SourceForFetch
 * rows so the coordinator treats discovered feeds identically to
 * curated ones. SSRF gating happens inside adaptersForDiscoveredFeeds. */
async function loadDiscoveredSources(
  kv: KVNamespace,
): Promise<SourceForFetch[]> {
  const out: SourceForFetch[] = [];
  let cursor: string | undefined;
  try {
    do {
      const result: KVNamespaceListResult<unknown> = await kv.list({
        prefix: 'sources:',
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const key of result.keys) {
        const raw = await kv.get(key.name, 'text');
        if (raw === null) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        if (parsed === null || typeof parsed !== 'object') continue;
        const feeds = (parsed as Partial<SourcesCacheValue>).feeds;
        if (!Array.isArray(feeds)) continue;
        const discoveredFeeds: DiscoveredFeed[] = [];
        for (const f of feeds) {
          if (f === null || typeof f !== 'object') continue;
          const name = (f as { name?: unknown }).name;
          const url = (f as { url?: unknown }).url;
          const kind = (f as { kind?: unknown }).kind;
          if (typeof name !== 'string' || name === '') continue;
          if (typeof url !== 'string' || url === '') continue;
          if (kind !== 'rss' && kind !== 'atom' && kind !== 'json') continue;
          discoveredFeeds.push({ name, url, kind });
        }
        // Key of this KV entry is `sources:{tag}` — strip the prefix
        // to identify which tag owns these feeds, so an evicted URL
        // can be removed from the right entry later.
        const tag = key.name.startsWith('sources:')
          ? key.name.slice('sources:'.length)
          : '';
        if (tag === '') continue;
        const adapters = adaptersForDiscoveredFeeds(discoveredFeeds);
        for (let i = 0; i < adapters.length; i++) {
          const adapter = adapters[i];
          const feed = discoveredFeeds[i];
          if (adapter === undefined || feed === undefined) continue;
          out.push({
            adapter,
            sourceName: feed.name,
            feedUrl: feed.url,
            discoveredTag: tag,
          });
        }
      }
      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor !== undefined);
  } catch (err) {
    log('warn', 'digest.generation', {
      status: 'coordinator_discovered_scan_failed',
      detail: String(err).slice(0, 200),
    });
  }
  return out;
}

/** Fetch every source in parallel, with a 10-worker semaphore to keep
 * the Workers runtime's CPU budget under control. Headlines are tagged
 * with their originating pretty source_name so the canonical-dedupe
 * downstream can preserve it. Fetch failures log and yield []; the
 * whole pass never rejects.
 *
 * Feed-health accounting (REQ-DISC-003): after each per-source fetch,
 * the outcome (`success`) is recorded against the URL via
 * `recordFetchResult`. When a discovered-tag URL crosses the eviction
 * threshold, the URL is emitted as an eviction signal so the
 * coordinator can remove it from its `sources:{tag}` entry and,
 * potentially, re-queue the tag for a fresh discovery pass. Curated
 * URLs run through the same health counter but never emit evictions
 * because there is no runtime path to mutate the hard-coded registry. */
async function fetchAllSources(
  env: Env,
  sources: SourceForFetch[],
): Promise<{
  rawHeadlines: Array<{ headline: Headline }>;
  evictions: FeedEviction[];
}> {
  const kv = env.KV;
  const jobs: Array<SourceForFetch & { idx: number }> = sources.map(
    (s, idx) => ({ ...s, idx }),
  );
  // Index-addressed so a straggling source doesn't reorder the pool.
  const results: Array<Array<{ headline: Headline }> | undefined> = [];
  const evictionSlots: Array<FeedEviction | undefined> = [];
  for (let i = 0; i < jobs.length; i++) {
    results.push(undefined);
    evictionSlots.push(undefined);
  }

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      if (job === undefined) return;
      // Per-source fetch is wrapped in try/catch so a single flaky
      // feed (404/403/timeout/malformed XML) never bubbles up and
      // kills the rest of the pool. Empty result keeps the worker
      // loop going; the logged event gives operators enough signal
      // to swap the URL later.
      // Health tracking only applies to discovered (KV-sourced) feeds
      // — curated URLs can't be runtime-evicted, so writing their
      // counter just burns KV budget without enabling any action.
      const trackHealth = job.discoveredTag !== null && job.discoveredTag !== '';
      try {
        const { headlines, fetched, success } = await fetchFromSourceWithResult(
          job.adapter,
          '',
          kv,
        );
        const capped = headlines.slice(0, PER_SOURCE_ITEM_CAP).map((h) => ({
          headline: {
            ...h,
            source_name: job.sourceName,
          },
        }));
        results[i] = capped;

        // Only record health for live fetches on discovered feeds —
        // cache hits are neither a liveness signal nor a failure.
        if (trackHealth && fetched) {
          const health = await recordFetchResult(env, job.feedUrl, success);
          if (health.evicted) {
            evictionSlots[i] = {
              tag: job.discoveredTag as string,
              url: job.feedUrl,
              failureCount: health.count,
            };
          }
        }
      } catch (err) {
        log('warn', 'source.fetch.failed', {
          source_name: job.sourceName,
          detail: String(err).slice(0, 200),
        });
        results[i] = [];
        // Unexpected throw still counts as a failure against the URL,
        // but only for discovered feeds.
        if (trackHealth) {
          try {
            const health = await recordFetchResult(env, job.feedUrl, false);
            if (health.evicted) {
              evictionSlots[i] = {
                tag: job.discoveredTag as string,
                url: job.feedUrl,
                failureCount: health.count,
              };
            }
          } catch (healthErr) {
            // Persistent KV outage — surface once per job so
            // `wrangler tail` shows the degradation instead of
            // silently dropping signals.
            log('warn', 'source.fetch.failed', {
              source_name: job.sourceName,
              status: 'health_double_throw',
              detail: String(healthErr).slice(0, 200),
            });
          }
        }
      }
    }
  };

  const workerCount = Math.min(GLOBAL_CONCURRENCY, jobs.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) workers.push(worker());
  await Promise.all(workers);

  const rawHeadlines: Array<{ headline: Headline }> = [];
  for (const r of results) {
    if (r === undefined) continue;
    for (const entry of r) rawHeadlines.push(entry);
  }
  const evictions: FeedEviction[] = [];
  for (const e of evictionSlots) {
    if (e !== undefined) evictions.push(e);
  }
  return { rawHeadlines, evictions };
}

/**
 * Apply feed-level evictions: remove each evicted URL from its
 * `sources:{tag}` entry, clear the per-URL health counter, and — if
 * the tag's feed list has been emptied — enqueue a system-owned
 * re-discovery row so the 5-minute discovery cron repopulates the tag.
 *
 * Evictions are coalesced by tag so multiple URLs removed from the
 * same tag only produce one KV write and one re-discovery row.
 * All work is best-effort: a failure on one tag never aborts the rest.
 *
 * Implements REQ-DISC-003 AC 2-3.
 */
async function applyEvictions(
  env: Env,
  evictions: FeedEviction[],
  scrape_run_id: string,
): Promise<void> {
  // Group eviction URLs by tag so each `sources:{tag}` entry is read
  // and rewritten at most once per tick.
  const byTag = new Map<string, Set<string>>();
  for (const ev of evictions) {
    const set = byTag.get(ev.tag) ?? new Set<string>();
    set.add(ev.url);
    byTag.set(ev.tag, set);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  for (const [tag, evictedUrls] of byTag) {
    try {
      const raw = await env.KV.get(`sources:${tag}`, 'text');
      if (raw === null) {
        // Entry already cleared (likely via /api/admin/discovery/retry
        // between ticks); still clear the per-URL counter and move on.
        for (const url of evictedUrls) await clearHealth(env, url);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Corrupt entry — overwrite with an empty feeds list so the
        // tag re-queues rather than staying stuck.
        parsed = null;
      }
      const existingFeeds = Array.isArray((parsed as Partial<SourcesCacheValue>)?.feeds)
        ? (parsed as SourcesCacheValue).feeds
        : [];

      const survivingFeeds: DiscoveredFeed[] = existingFeeds.filter(
        (f) => typeof f?.url === 'string' && !evictedUrls.has(f.url),
      );

      // Re-read sources:{tag} immediately before the write to shrink
      // the read-modify-write race window. KV has no conditional-put,
      // so if the 5-minute discovery cron has already replaced the
      // entry between our initial read and this re-check, we'd
      // otherwise silently clobber its freshly-discovered feeds. Bail
      // on any mismatch — health counters are already cleared above,
      // and the next scrape tick will re-evaluate health against the
      // new feed set.
      const latestRaw = await env.KV.get(`sources:${tag}`, 'text');
      if (latestRaw !== raw) {
        log('info', 'discovery.completed', {
          status: 'eviction_skipped_raced',
          scrape_run_id,
          tag,
        });
        for (const url of evictedUrls) await clearHealth(env, url);
        continue;
      }

      const nextCache: SourcesCacheValue = {
        feeds: survivingFeeds,
        discovered_at: Date.now(),
      };
      await env.KV.put(`sources:${tag}`, JSON.stringify(nextCache));

      // Clear the per-URL health counters so a re-discovered URL at
      // the same address starts from a clean slate.
      for (const url of evictedUrls) await clearHealth(env, url);

      log('warn', 'discovery.completed', {
        status: 'feed_evicted',
        scrape_run_id,
        tag,
        evicted_count: evictedUrls.size,
        remaining_feeds: survivingFeeds.length,
      });

      if (survivingFeeds.length === 0) {
        // Last feed for this tag is gone — enqueue a re-discovery pass.
        // The system-owned row carries `user_id = SYSTEM_USER_ID` so
        // real-user queries (scoped `WHERE user_id = ?`) naturally
        // exclude it, while the discovery cron (which GROUPs BY tag)
        // picks it up on the next invocation.
        try {
          await env.DB
            .prepare(
              'INSERT OR IGNORE INTO pending_discoveries (user_id, tag, added_at) VALUES (?1, ?2, ?3)',
            )
            .bind(SYSTEM_USER_ID, tag, nowSec)
            .run();
          log('warn', 'discovery.queued', {
            status: 'system_requeue',
            scrape_run_id,
            tag,
          });
        } catch (err) {
          log('error', 'discovery.queued', {
            status: 'system_requeue_failed',
            scrape_run_id,
            tag,
            detail: String(err).slice(0, 200),
          });
        }
      }
    } catch (err) {
      log('error', 'discovery.completed', {
        status: 'eviction_failed',
        scrape_run_id,
        tag,
        detail: String(err).slice(0, 200),
      });
    }
  }
}

/** Look up which of the supplied canonical URLs already exist in
 * `articles.canonical_url`. Batched in chunks of EXISTING_URL_BATCH to
 * keep individual queries under D1's string-length cap. */
async function loadExistingCanonicalUrls(
  db: D1Database,
  urls: string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  for (let i = 0; i < urls.length; i += EXISTING_URL_BATCH) {
    const slice = urls.slice(i, i + EXISTING_URL_BATCH);
    if (slice.length === 0) continue;
    const placeholders = slice.map((_, idx) => `?${idx + 1}`).join(', ');
    try {
      const result = await db
        .prepare(
          `SELECT canonical_url FROM articles WHERE canonical_url IN (${placeholders})`,
        )
        .bind(...slice)
        .all<{ canonical_url: string }>();
      for (const row of result.results ?? []) {
        if (typeof row.canonical_url === 'string') {
          existing.add(row.canonical_url);
        }
      }
    } catch (err) {
      log('warn', 'digest.generation', {
        status: 'coordinator_existing_lookup_failed',
        detail: String(err).slice(0, 200),
      });
    }
  }
  return existing;
}
