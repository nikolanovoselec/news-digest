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

/** Hosts that are aggregator wrappers, not real publishers. Two URLs
 *  on the same aggregator host route to potentially different
 *  underlying publishers; treating them as same-vendor and applying
 *  the dedup cosine penalty inflated false-negatives on Google News
 *  duplicates of the same story (paraphrased headlines, same vendor
 *  host). The 2026-05-07 audit on prod found pair-A
 *  (BTIG / Palo Alto) at cosine 0.9516 and pair-B (Premium-valuation /
 *  Palo Alto) at 0.8615 — the 0.05 same-vendor penalty knocked B
 *  below the 0.85 auto-merge threshold. Aggregator hosts are exempt.
 *
 *  Scope assumption: the curated source registry (`src/lib/curated-
 *  sources.ts`) and the auto-synthesised tag-fallback in
 *  `googleNewsSourceForTag` only emit `news.google.com` URLs today.
 *  If a future feed adds `news.google.co.uk`, Apple News redirects, a
 *  Flipboard wrapper, or any other publisher-aggregator, add the host
 *  here so it benefits from the same exemption. */
const AGGREGATOR_HOSTS = new Set(['news.google.com']);

/** Returns true when both URLs have the same registrable domain.
 *  Treats malformed URLs as different vendors (defensive — better to
 *  leave the cosine alone than to fold an unparseable URL with
 *  anything). Returns false when EITHER URL is on an aggregator host
 *  (see {@link AGGREGATOR_HOSTS}) since the eTLD+1 doesn't carry
 *  publisher signal in that case. */
export function sameVendor(urlA: string, urlB: string): boolean {
  let hostA: string;
  let hostB: string;
  try {
    hostA = new URL(urlA).host.toLowerCase();
    hostB = new URL(urlB).host.toLowerCase();
  } catch {
    return false;
  }
  if (hostA === '' || hostB === '') return false;
  if (AGGREGATOR_HOSTS.has(hostA) || AGGREGATOR_HOSTS.has(hostB)) return false;
  return etldPlusOne(hostA) === etldPlusOne(hostB);
}
