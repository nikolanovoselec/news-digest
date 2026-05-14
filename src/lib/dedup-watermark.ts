// Implements REQ-PIPE-009
//
// Persists the timestamp of the most recent successful auto-sweep run.
// The sweep's rerank pass uses this watermark to skip LLM calls on
// pairs whose articles both predate the prior sweep — their same-event
// verdict was already recorded by that earlier run and re-asking the
// model at temperature=0 returns the same answer (wasted spend).
//
// Storage: single KV key. KV is already provisioned for cache + discovery
// state; no migration. A missing key (cold start, post-invalidation)
// reads as 0, which makes the pair-skip predicate `selfTime < 0 AND
// matchTime < 0` always false — i.e. behaviour falls back to the
// pre-watermark "always rerank" path.
//
// Invalidation: cleared by `/api/admin/embed-backfill?reembed=1` because
// re-embedding changes cosine geometry, so all prior verdicts are
// suspect. Operator-triggered `/api/admin/historical-dedup` bypasses
// the watermark via a `bypassWatermark` flag rather than clearing the
// key (the operator wants to re-check everything but the next
// auto-sweep should still benefit from the watermark).

const WATERMARK_KEY = 'dedup:auto_sweep_watermark';

/**
 * Read the last-successful-auto-sweep watermark as seconds-since-epoch.
 * Returns 0 when the key is absent or unparseable so callers can use a
 * single `< watermark` comparison without null-guarding.
 */
export async function readWatermark(env: Pick<Env, 'KV'>): Promise<number> {
  const raw = await env.KV.get(WATERMARK_KEY);
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * Write the watermark. Called by the sweep consumer when a sweep batch
 * flips its audit row to `status='done'` (terminal completion).
 */
export async function writeWatermark(
  env: Pick<Env, 'KV'>,
  seconds: number,
): Promise<void> {
  await env.KV.put(WATERMARK_KEY, String(Math.floor(seconds)));
}

/**
 * Delete the watermark. Called by the embed-backfill reembed path to
 * invalidate prior verdicts after the embedding geometry changes.
 */
export async function clearWatermark(env: Pick<Env, 'KV'>): Promise<void> {
  await env.KV.delete(WATERMARK_KEY);
}
