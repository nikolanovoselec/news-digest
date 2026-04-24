// Implements REQ-PIPE-001
//
// Coordinator for the hourly global-feed scrape. Receives one message
// per :00 cron tick containing `{scrape_run_id}`; fans out across
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
  fetchFromSource,
  type SourceAdapter,
} from '~/lib/sources';
import { canonicalize } from '~/lib/canonical-url';
import { clusterByCanonical, type Candidate } from '~/lib/dedupe';
import { finishRun } from '~/lib/scrape-run';
import { log } from '~/lib/log';
import type { DiscoveredFeed, SourcesCacheValue, Headline } from '~/lib/types';

/** Max candidates per chunk. Matches the LLM's ~8K input-token budget
 * at the gpt-oss-20b default: ~50 candidate headlines per chunk
 * leaves per-article budget at ~1K output tokens (enough for the
 * 200-250-word prompt contract at ~350 toks/article + JSON
 * overhead), plus headroom for PROCESS_CHUNK_SYSTEM. Was 100 at
 * Gemma; 50 at gpt-oss-20b gives more per-article breathing
 * room without exploding the chunk count. The chunk size isn't
 * the primary lever on output length — the INPUT snippet length
 * is. A model with 300 chars of source material can't honestly
 * write 250 words regardless of how much output budget you give
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

/** Every `scrape-coordinator` queue message. Enqueued by the hourly
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
    })),
    ...discoveredSources,
  ];

  // --- Step 2: Fetch all sources in parallel (10-worker semaphore) ----
  const rawHeadlines = await fetchAllSources(env.KV, allSources);

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
  for (const row of rawHeadlines) {
    if (!isSafeWebUrl(row.headline.url)) continue;
    const canonical = canonicalize(row.headline.url);
    if (!isSafeWebUrl(canonical)) continue;
    const pub =
      typeof row.headline.published_at === 'number' &&
      row.headline.published_at > 0
        ? row.headline.published_at
        : nowSec;
    if (pub < staleCutoff) {
      droppedStale += 1;
      continue;
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
  if (droppedStale > 0) {
    log('info', 'digest.generation', {
      op: 'coordinator_drop_stale',
      scrape_run_id,
      dropped_stale_backlog: droppedStale,
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
  // the next hourly tick (the existing-URL filter keeps tick-N+1 from
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

/** A source entry ready for fetchFromSource — pairs an adapter with the
 * pretty name that will land in `articles.primary_source_name`. */
interface SourceForFetch {
  adapter: SourceAdapter;
  sourceName: string;
}

/** Convert a CuratedSource entry to a SourceAdapter that
 * fetchFromSource() can drive. The adapter's URL is constant (it
 * ignores the `tag` argument) and the extract routes into the same
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
        const adapters = adaptersForDiscoveredFeeds(discoveredFeeds);
        for (let i = 0; i < adapters.length; i++) {
          const adapter = adapters[i];
          const feed = discoveredFeeds[i];
          if (adapter === undefined || feed === undefined) continue;
          out.push({ adapter, sourceName: feed.name });
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
 * whole pass never rejects. */
async function fetchAllSources(
  kv: KVNamespace,
  sources: SourceForFetch[],
): Promise<Array<{ headline: Headline }>> {
  const jobs: Array<SourceForFetch & { idx: number }> = sources.map(
    (s, idx) => ({ ...s, idx }),
  );
  // Index-addressed so a straggling source doesn't reorder the pool.
  const results: Array<Array<{ headline: Headline }> | undefined> = [];
  for (let i = 0; i < jobs.length; i++) results.push(undefined);

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
      try {
        const headlines = await fetchFromSource(job.adapter, '', kv);
        const capped = headlines.slice(0, PER_SOURCE_ITEM_CAP).map((h) => ({
          headline: {
            ...h,
            source_name: job.sourceName,
          },
        }));
        results[i] = capped;
      } catch (err) {
        log('warn', 'source.fetch.failed', {
          source_name: job.sourceName,
          detail: String(err).slice(0, 200),
        });
        results[i] = [];
      }
    }
  };

  const workerCount = Math.min(GLOBAL_CONCURRENCY, jobs.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) workers.push(worker());
  await Promise.all(workers);

  const out: Array<{ headline: Headline }> = [];
  for (const r of results) {
    if (r === undefined) continue;
    for (const entry of r) out.push(entry);
  }
  return out;
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
