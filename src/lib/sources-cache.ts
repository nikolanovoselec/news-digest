// Implements REQ-PIPE-001
//
// Centralized read/write of `sources:{tag}` KV entries (CF-001 / AD16).
// Every writer in the system MUST go through this module. The
// invariant the coordinator's eviction recheck relies on — that the
// serialized form of a cache value is byte-equal whenever the logical
// content is identical — is enforced here by:
//
//   1. A single, explicit field order in `serialize()`. The two
//      writer call sites previously called `JSON.stringify({ feeds,
//      discovered_at })` inline; a future caller using a different
//      destructure order would silently break the byte-equal compare
//      that the coordinator's read-modify-write race recheck depends
//      on. Centralizing fixes this by construction.
//
//   2. A `discovered_at` field on every cache entry. The coordinator
//      now performs a STRUCTURAL recheck against this monotonic
//      timestamp instead of a raw byte compare — belt-and-suspenders.
//      Even if two writers diverge on serialization order, the race
//      detection still catches the collision.
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

/** Read a sources cache entry. Returns `null` when the key is absent
 *  or the stored bytes do not parse to a valid SourcesCacheValue. */
export async function readSourcesCache(
  kv: KVNamespace,
  tag: string,
): Promise<{ value: SourcesCacheValue; raw: string } | null> {
  const raw = await kv.get(key(tag), 'text');
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as SourcesCacheValue;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray(parsed.feeds) &&
      typeof parsed.discovered_at === 'number'
    ) {
      return { value: parsed, raw };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Compare two raw sources cache strings for content equality, with a
 *  STRUCTURAL fallback. The coordinator's eviction recheck uses this
 *  to decide whether another isolate has written a newer cache value
 *  while the eviction pass was computing.
 *
 *  Byte-equal is the fast path. When bytes differ, parse both sides
 *  and compare `discovered_at`; if discovered_at matches, the writes
 *  are logically equivalent (same fan-out tick) even if serialization
 *  drifted. This guards against the failure mode AD16 documents. */
export function sourcesCacheRawEqual(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const aParsed = JSON.parse(a) as SourcesCacheValue;
    const bParsed = JSON.parse(b) as SourcesCacheValue;
    return aParsed.discovered_at === bParsed.discovered_at;
  } catch {
    return false;
  }
}
