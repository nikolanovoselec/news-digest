// Implements REQ-GEN-004
// URL canonicalization for cross-source article dedupe.
//
// Rules (string-only — we never follow redirects):
//   1. http: → https:. Many feeds (arXiv especially) return http; the HTTPS
//      version is almost always reachable and lets us dedupe scheme variants.
//   2. Strip known tracking params: utm_*, ref, ref_src, fbclid, gclid,
//      mc_cid, mc_eid, igshid, si, source.
//   3. Lowercase the scheme and the hostname.
//   4. Drop a trailing `/` on a non-root pathname.
//
// Any URL that fails to parse is returned verbatim — deduplication is
// best-effort and must never throw.

const TRACKING_PARAM_PREFIXES = ['utm_'] as const;
const TRACKING_PARAM_EXACT = new Set([
  'ref',
  'ref_src',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'si',
  'source',
]);

/**
 * Canonicalise {@link url} for dedupe. Returns {@link url} unchanged
 * if parsing fails. Never throws.
 */
export function canonicalize(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  // Step 1: scheme upgrade. WHATWG URL stores `protocol` with the trailing
  // colon ("https:"), so compare/assign with that.
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'https:';
  }

  // Bail on non-http(s) schemes — canonicalization is only defined for web URLs.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return url;
  }

  // Step 2: strip tracking params. Mutate a fresh copy of searchParams to
  // avoid iteration-while-deleting aliasing in the underlying map.
  const paramsToDelete: string[] = [];
  for (const key of parsed.searchParams.keys()) {
    if (isTrackingParam(key)) {
      paramsToDelete.push(key);
    }
  }
  for (const key of paramsToDelete) {
    parsed.searchParams.delete(key);
  }

  // Step 3: WHATWG URL already lowercases scheme and host automatically.
  // No extra work needed — `parsed.host` / `parsed.hostname` come out lowercase.

  // Step 4: drop trailing slash from non-root pathname.
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }

  // URL.toString() reconstructs in canonical form. An empty search string
  // collapses to no `?`; an empty pathname stays as `/`.
  let result = parsed.toString();

  // For bare origins like "https://example.com/" the WHATWG spec keeps the
  // trailing slash. Strip it so the no-path form canonicalises to the same
  // output as an explicit "/" path would, tightening dedupe.
  if (parsed.pathname === '/' && parsed.search === '' && parsed.hash === '') {
    if (result.endsWith('/')) {
      result = result.slice(0, -1);
    }
  }

  return result;
}

/** True iff {@link name} matches one of the known tracking-param patterns. */
function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (TRACKING_PARAM_EXACT.has(lower)) return true;
  for (const prefix of TRACKING_PARAM_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}
