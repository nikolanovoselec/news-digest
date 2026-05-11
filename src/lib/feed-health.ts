// Implements REQ-DISC-003
//
// Per-feed fetch-health counter for the self-healing discovery loop.
//
// Every feed fetch in the scrape pipeline reports its outcome here. A
// successful fetch clears the counter; a failure increments it. When a
// URL reaches `CONSECUTIVE_FETCH_FAILURE_LIMIT` consecutive failures the
// coordinator boundary treats the counter result as an eviction signal -
// the URL is removed from its `sources:{tag}` KV entry, and if that was
// the last feed for the tag the tag is re-queued to `pending_discoveries`
// so a fresh LLM discovery pass replaces it.
//
// The counter is stored in KV under `source_health:{url}` as a UTF-8
// integer string with a 7-day TTL. The TTL prevents unbounded KV growth
// while being generous enough that counters are never wiped between
// scrapes (cron fires every 4 hours - 6 ticks/day × 7 days = 42 ticks
// of breathing room).
//
// Math on the threshold: scrape cadence is 6 ticks/day (every 4 hours).
// `CONSECUTIVE_FETCH_FAILURE_LIMIT = 30` means a feed must fail for
// ~5 consecutive days before it is evicted. That window absorbs
// day-long outages, DNS blips, and certificate rotations without
// thrashing the cache, while still surfacing genuinely dead URLs on
// a timeline a human operator would accept.

import { log } from '~/lib/log';

/** Evict after this many consecutive fetch failures.
 *  6 scrapes/day × ~5 days = 30. */
export const CONSECUTIVE_FETCH_FAILURE_LIMIT = 30;

/** 7-day TTL on the per-URL counter so stale entries self-expire. */
const HEALTH_COUNTER_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Shape returned by {@link recordFetchResult}. Callers that care about
 * eviction (the coordinator at the end of the fetch phase) branch on
 * `evicted === true`; callers that don't (individual source fetchers)
 * can ignore the return value. */
// CF-020: not exported - only consumed as the return type of
// recordFetchResult below. Callers destructure the object inline.
interface FeedHealthResult {
  /** True iff this call pushed the counter to the eviction threshold.
   * Transitions from false → true exactly once per URL per bad streak;
   * subsequent failed calls keep returning `true` but the caller is
   * expected to have already acted on the first signal. */
  evicted: boolean;
  /** The counter value after this call. 0 on success, `prior + 1` on
   * failure. Exposed for telemetry and tests. */
  count: number;
}

/** KV key for a feed's per-URL health counter. Exported for tests and
 * for the coordinator eviction path, which deletes this key after the
 * URL is removed from its sources:{tag} entry. */
export function healthKey(url: string): string {
  return `source_health:${url}`;
}

/**
 * Record a feed fetch outcome and return the resulting health state.
 *
 * On success: deletes the counter (next call starts from zero).
 * On failure: increments the counter with a 7-day TTL. When the post-
 * increment count reaches {@link CONSECUTIVE_FETCH_FAILURE_LIMIT}, the
 * caller should evict the URL from its tag cache and (if that was the
 * last feed) re-queue the tag for discovery.
 *
 * Never throws - KV errors are logged and treated as a no-op success
 * (the alternative, treating them as failures, would let a transient
 * KV outage evict every URL in the registry).
 */
export async function recordFetchResult(
  env: Env,
  url: string,
  success: boolean,
): Promise<FeedHealthResult> {
  const key = healthKey(url);
  if (success) {
    try {
      await env.KV.delete(key);
    } catch (err) {
      log('warn', 'source.fetch.failed', {
        url,
        status: 'health_reset_failed',
        detail: String(err).slice(0, 200),
      });
    }
    return { evicted: false, count: 0 };
  }

  let prior = 0;
  try {
    const raw = await env.KV.get(key);
    if (raw !== null) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        prior = parsed;
      }
    }
  } catch (err) {
    log('warn', 'source.fetch.failed', {
      url,
      status: 'health_read_failed',
      detail: String(err).slice(0, 200),
    });
    return { evicted: false, count: 0 };
  }

  const next = prior + 1;
  try {
    await env.KV.put(key, String(next), {
      expirationTtl: HEALTH_COUNTER_TTL_SECONDS,
    });
  } catch (err) {
    log('warn', 'source.fetch.failed', {
      url,
      status: 'health_write_failed',
      detail: String(err).slice(0, 200),
    });
    return { evicted: false, count: next };
  }

  return {
    evicted: next >= CONSECUTIVE_FETCH_FAILURE_LIMIT,
    count: next,
  };
}

/**
 * Delete a URL's counter. Called by the coordinator's eviction path
 * after the URL has been removed from its `sources:{tag}` KV entry, so
 * a re-discovered feed at the same URL (rare but possible - the LLM
 * might suggest it again) starts from zero rather than inheriting the
 * old fail streak.
 */
export async function clearHealth(env: Env, url: string): Promise<void> {
  try {
    await env.KV.delete(healthKey(url));
  } catch (err) {
    log('warn', 'source.fetch.failed', {
      url,
      status: 'health_clear_failed',
      detail: String(err).slice(0, 200),
    });
  }
}
