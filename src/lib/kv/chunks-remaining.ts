// Implements REQ-PIPE-001
//
// KV writer/reader for `scrape_run:{id}:chunks_remaining` — the legacy
// progress counter consumed by /api/scrape-status while a run is in
// flight.
//
// Key format:  `scrape_run:{scrape_run_id}:chunks_remaining`
// Value:       UTF-8 integer string (number of chunks not yet completed)
// TTL:         COUNTER_TTL_SECONDS (3 h) — generous vs the 4-hour cron
//              cadence; gives slow chunks retry headroom without leaking
//              counter keys forever.
//
// Two writers exist:
//   1. The coordinator sets the initial count equal to the number of
//      chunks it enqueues (src/queue/scrape-coordinator.ts).
//   2. Each chunk consumer overwrites the counter with the authoritative
//      D1-derived value after recording its completion
//      (src/queue/scrape-chunk-consumer.ts).
//
// Single reader:
//   /api/scrape-status reads inline (single call site, no helper needed).
//
// AD27: all KV writers for this key family route through this file.

/** TTL for the chunks-remaining counter. 3 h is generous relative to
 *  the 4-hour cron cadence, giving slow chunks ample retry headroom. */
const COUNTER_TTL_SECONDS = 3 * 3600;

/** Build the canonical KV key for a run's chunks-remaining counter. */
function chunksRemainingKey(scrape_run_id: string): string {
  return `scrape_run:${scrape_run_id}:chunks_remaining`;
}

/**
 * Persist the chunks-remaining counter for a scrape run.
 *
 * Called by the coordinator (initial value = total chunks enqueued) and
 * by each chunk consumer (value = D1-authoritative remaining count).
 * Never throws — a write failure here is recoverable: the next chunk
 * consumer will overwrite the counter, and /api/scrape-status falls back
 * to `null` on a miss without breaking the UI.
 */
export async function setChunksRemaining(
  kv: KVNamespace,
  scrape_run_id: string,
  remaining: number,
): Promise<void> {
  await kv.put(chunksRemainingKey(scrape_run_id), String(remaining), {
    expirationTtl: COUNTER_TTL_SECONDS,
  });
}

// `getChunksRemaining` was extracted alongside the writer helpers but
// has no production caller (the only reader, `/api/scrape-status`,
// inlines the KV.get to keep the route handler self-contained).
// Dropped from the public surface. The reader can be reintroduced
// from this module as soon as a second caller appears.
