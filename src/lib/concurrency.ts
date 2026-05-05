// Implements REQ-PIPE-001
// Implements REQ-PIPE-002
//
// Bounded-concurrency map. Replaces three near-identical worker-pool
// loops in `src/lib/sources.ts`, `src/queue/scrape-coordinator.ts`,
// and `src/lib/article-fetch.ts` (CF-008) — each had the same
// cursor-based semaphore plus an index-preserving result array, with
// subtly different details (some logged failures, some swallowed
// them, some returned `undefined` markers). One implementation is
// easier to reason about and to bound when the runtime gains
// new fan-out sites.
//
// Behavior:
//   - Spawns up to `concurrency` worker promises; each worker pulls
//     the next index off a shared cursor until the items array is
//     exhausted.
//   - Results are written into a fixed-size array at the source
//     index, so the returned array is in the same order as `items`
//     even though network latency reorders completions.
//   - Errors propagate via `Promise.all` — a thrown handler aborts
//     the whole batch. Callers that want to per-item-tolerate errors
//     must catch inside their handler and produce a sentinel value.
//   - When `items.length === 0` the function resolves to `[]`
//     without spawning any workers.

/**
 * CF-027 — Map `fn` over `items` with at most `concurrency` promises
 * in-flight at once. Results are returned in the same order as `items`.
 *
 * **Partial-error semantics:** if `fn` throws for any item, the entire
 * batch rejects via `Promise.all` — there is no per-item suppression.
 * Callers that need per-item tolerance must catch inside `fn` and
 * return a sentinel value instead of throwing.
 *
 * @param items       Items to process; may be empty (resolves to `[]`).
 * @param concurrency Maximum simultaneous promises; must be ≥ 1.
 * @param fn          Async transform; receives the item and its 0-based
 *                    index. Must not mutate `items`.
 * @returns           Array of results in source order.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error(`mapConcurrent: concurrency must be >= 1, got ${concurrency}`);
  }
  const total = items.length;
  if (total === 0) return [];
  const workerCount = Math.min(concurrency, total);
  // CF-028 — pre-size with `R | undefined` instead of the prior
  // `null as unknown as R` cast. Every slot is overwritten by a
  // worker before `Promise.all` resolves, so the post-await assertion
  // below is sound. Type fidelity is recovered without a sentinel
  // that lies about the array's contents.
  const results: Array<R | undefined> = Array.from({ length: total }, () => undefined);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= total) return;
      const item = items[i] as T;
      results[i] = await fn(item, i);
    }
  };
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) workers.push(worker());
  await Promise.all(workers);
  // Every slot was assigned by a worker before Promise.all resolved.
  return results as R[];
}
