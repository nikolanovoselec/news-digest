// Implements REQ-PIPE-003
//
// Naive eTLD+1 helper for the dedup pipeline's same-vendor cosine
// offset. Returns the registrable domain for a host so two URLs from
// the same publisher are recognised even when they differ in
// subdomain (cloud.google.com vs google.com, blog.workos.com vs
// workos.com, etc.).
//
// Scope is intentionally narrow: the corpus is dominated by
// `.com / .org / .io / .net / .dev / .tech / .ai` and one Google
// News redirect host. We do NOT pull in the Public Suffix List for
// this. PSL adds ~250KB of bundle, sub-millisecond lookups, and
// covers `.co.uk`-shaped suffixes the corpus does not have. If the
// corpus ever ingests UK / AU / NZ regional press, swap to PSL.
//
// Behaviour matches what the dedup logic needs: two hosts are
// "same vendor" when this function returns the same string. False
// positives on `.co.uk`-style hosts (would treat `bbc.co.uk` and
// `news.co.uk` as different — actually correct) are acceptable.

const TWO_LEVEL_TLDS = new Set([
  'co.uk',
  'co.jp',
  'co.kr',
  'co.nz',
  'com.au',
  'com.br',
  'com.cn',
  'com.tw',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'ne.jp',
  'or.jp',
]);

/** Returns the registrable domain (eTLD+1) for the given host.
 *  Empty / IP / single-label inputs return as-is. */
export function etldPlusOne(host: string): string {
  const lower = host.toLowerCase().trim();
  if (lower === '') return '';
  // IPv4 / IPv6 left untouched.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(lower) || lower.includes(':')) return lower;
  const parts = lower.split('.');
  if (parts.length < 2) return lower;
  // Try the trailing two-level TLD list first (`bbc.co.uk` -> `bbc.co.uk`).
  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join('.');
    if (TWO_LEVEL_TLDS.has(lastTwo)) {
      return parts.slice(-3).join('.');
    }
  }
  return parts.slice(-2).join('.');
}

/** Returns true when both URLs have the same registrable domain.
 *  Treats malformed URLs as different vendors (defensive — better to
 *  leave the cosine alone than to fold an unparseable URL with
 *  anything). */
export function sameVendor(urlA: string, urlB: string): boolean {
  let hostA: string;
  let hostB: string;
  try {
    hostA = new URL(urlA).host;
    hostB = new URL(urlB).host;
  } catch {
    return false;
  }
  if (hostA === '' || hostB === '') return false;
  return etldPlusOne(hostA) === etldPlusOne(hostB);
}
