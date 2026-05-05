// Implements REQ-DISC-001
//
// KV writer/reader for `discovery_failures:{tag}` — the consecutive-
// failure counter for the LLM-assisted tag discovery loop.
//
// Key format:  `discovery_failures:{tag}`
// Value:       UTF-8 integer string (consecutive failure count)
// TTL:         FAILURE_COUNTER_TTL_SECONDS (7 days) — prevents unbounded
//              KV growth while giving the counter enough lifetime to span
//              many cron ticks.
//
// Writers (all route through this file per AD27):
//   - src/lib/discovery.ts — increments on each discovery failure,
//     deletes on success or eviction.
//   - src/queue/cleanup.ts — deletes when a tag is swept as an orphan.
//   - src/pages/api/admin/discovery/retry.ts — deletes on manual retry.
//   - src/pages/api/admin/discovery/retry-bulk.ts — deletes on bulk retry.
//
// Reader (single inline site — no helper needed per C4 plan):
//   - src/lib/discovery.ts reads the counter before incrementing.
//
// AD27: all KV writers for this key family route through this file.

/** 7-day TTL for failure counters — prevents unbounded KV growth. */
const FAILURE_COUNTER_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Persist the consecutive-failure counter for a discovery tag.
 *
 * Callers pass the NEXT count (prior + 1). A 7-day TTL is applied so
 * stale counters self-expire without requiring explicit cleanup.
 */
export async function recordDiscoveryFailure(
  kv: KVNamespace,
  tag: string,
  nextCount: number,
): Promise<void> {
  await kv.put(`discovery_failures:${tag}`, String(nextCount), {
    expirationTtl: FAILURE_COUNTER_TTL_SECONDS,
  });
}

/**
 * Delete the consecutive-failure counter for a discovery tag.
 *
 * Called on successful discovery, eviction (counter reaches limit), and
 * manual retry via admin routes. A missing key is a no-op in KV, so
 * calling this on a tag with no existing counter is safe.
 */
export async function clearDiscoveryFailure(
  kv: KVNamespace,
  tag: string,
): Promise<void> {
  await kv.delete(`discovery_failures:${tag}`);
}
