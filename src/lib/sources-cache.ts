// Implements REQ-PIPE-001
//
// Centralized writer for `sources:{tag}` KV entries (CF-001 / AD16).
// Every writer in the system MUST go through this module. The
// invariant the coordinator's eviction recheck relies on — that the
// serialized form of a cache value is byte-equal whenever the logical
// content is identical — is enforced here by a single, explicit
// field order in `serialize()`. The two writer call sites previously
// called `JSON.stringify({ feeds, discovered_at })` inline; a future
// caller using a different destructure order would silently break
// the byte-equal compare that the coordinator's read-modify-write
// race recheck depends on. Centralising fixes this by construction.
//
// `sourcesCacheRawEqual` is byte-only. An earlier draft of this
// helper carried a structural `discovered_at` fallback as
// belt-and-suspenders; review-cycle code-reviewer flagged that two
// writers colliding on the same `Date.now()` millisecond with
// genuinely different feeds would have been treated as equivalent —
// exactly the failure mode the recheck exists to prevent. The byte
// path is sound now that this module is the single canonical writer.
//
// Same anti-pattern AD7 migrated AWAY from for chunk completion. See
// AD16 for the full reasoning + alternatives considered.

import type { SourcesCacheValue } from '~/lib/types';

/** Build the canonical serialised form of a sources cache value.
 *  Field order is load-bearing — the coordinator's eviction recheck
 *  byte-compares the result of this function. */
function serialize(value: SourcesCacheValue): string {
  // Explicit object literal with fixed key order. Do not use spread
  // syntax or computed property names; the runtime is allowed to
  // reorder spread output across engine versions.
  return JSON.stringify({
    feeds: value.feeds,
    discovered_at: value.discovered_at,
  });
}

const KEY_PREFIX = 'sources:';

function key(tag: string): string {
  return `${KEY_PREFIX}${tag}`;
}

/** Write a sources cache entry for {@link tag}.
 *  All callers MUST go through this helper — never `KV.put('sources:...')`
 *  directly. Returns the serialized payload so callers that need to
 *  pair the write with a recheck (the coordinator's
 *  `applyEvictions`) can keep the bytes they wrote. */
export async function writeSourcesCache(
  kv: KVNamespace,
  tag: string,
  value: SourcesCacheValue,
): Promise<string> {
  const raw = serialize(value);
  await kv.put(key(tag), raw);
  return raw;
}

/** Compare two raw sources cache strings for content equality.
 *  The coordinator's eviction recheck uses this to decide whether
 *  another isolate has written a newer cache value while the
 *  eviction pass was computing.
 *
 *  Byte-equal is the only equality path — `writeSourcesCache` is the
 *  centralised, single-writer-per-cache-line entry point with a fixed
 *  field order, so any byte divergence MUST mean a genuinely different
 *  write landed first. A structural fallback that compared only
 *  `discovered_at` would silently treat two writes that happened to
 *  collide on the same millisecond as equivalent and clobber a peer's
 *  distinct feed set — exactly the failure mode the recheck exists
 *  to prevent (the prior implementation of this function had this
 *  flaw and was tightened to byte-only by the same review pass that
 *  introduced the helper). */
export function sourcesCacheRawEqual(a: string, b: string): boolean {
  return a === b;
}
