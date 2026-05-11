// Implements REQ-PIPE-001
//
// Hard publisher blocklist. Headlines from these publishers are dropped
// at the coordinator before clustering, embedding, or LLM consideration.
// Distinct from same-vendor cosine penalties (which still allow the
// content through) — the blocklist is "this publisher is off-topic for
// an AI-curated tech news product, period."
//
// Most entries are financial / stock-pump aggregators that Google News
// surfaces when a user-configured discovery tag (e.g. "Palo Alto
// Networks") matches a tech vendor's ticker. The articles look like
// tech news to the dedup pipeline but are commentary on share prices.
//
// Two signals are checked because Google News articles arrive with
// `headline.url = news.google.com/rss/articles/CBMi…` (the redirect
// envelope, see {@link src/lib/sources.ts} `extractItemSourceName`)
// while the actual publisher only shows up in `headline.source_name`.
// Until the Google News redirect resolution lands as a follow-up, the
// name-token check is the only reliable signal for Google-News-routed
// content.

import type { Headline } from '~/lib/types';

/** Direct-URL hostnames that are never welcome. Match is on the host
 *  alone (path-agnostic) and uses suffix-match so `finance.yahoo.com`,
 *  `news.yahoo.com`, etc. all hit the `yahoo.com` entry. */
export const BLOCKED_HOSTS: ReadonlySet<string> = new Set([
  'tradingview.com',
  'finance.yahoo.com',
  'yahoo.com',
  'msn.com',
  'seekingalpha.com',
  'marketwatch.com',
  'benzinga.com',
  'fool.com',
  'barrons.com',
  'cnbc.com',
  'investorplace.com',
  'simplywall.st',
  'nasdaq.com',
  'streetinsider.com',
  'zacks.com',
  'investors.com',
  'finance.com',
  'morningstar.com',
  'investing.com',
]);

/** Lowercased substring tokens checked against `headline.source_name`.
 *  Used for Google-News-routed articles whose `headline.url` is the
 *  `news.google.com` redirect — the real publisher only shows up in the
 *  RSS `<source>` text, which lands in `source_name`. */
export const BLOCKED_NAME_TOKENS: readonly string[] = [
  'tradingview',
  'yahoo finance',
  'yahoo! finance',
  'msn',
  'seeking alpha',
  'marketwatch',
  'benzinga',
  'motley fool',
  "barron's",
  'barrons',
  'cnbc',
  'investorplace',
  'simply wall st',
  'street insider',
  'zacks',
  "investor's business daily",
  'morningstar',
  'investing.com',
];

/** Return true when the headline's host matches any entry in
 *  {@link BLOCKED_HOSTS}, treating each entry as a domain suffix so
 *  subdomains hit too. Case-insensitive. Returns false on malformed
 *  URLs — non-URL inputs aren't the blocklist's concern. */
function hostIsBlocked(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === '') return false;
  for (const blocked of BLOCKED_HOSTS) {
    if (host === blocked || host.endsWith('.' + blocked)) return true;
  }
  return false;
}

/** Return true when the headline's source_name contains any token from
 *  {@link BLOCKED_NAME_TOKENS} as a whole-word match. Word boundaries
 *  are needed because short tokens (e.g. "msn", "cnbc") would otherwise
 *  substring-match unrelated publisher names ("Comsnet News",
 *  "Demsnews"). A "word" here is a maximal run of letters/digits, with
 *  punctuation and whitespace acting as separators — so a token like
 *  "yahoo finance" matches "Yahoo Finance" and "Yahoo! Finance" alike
 *  (the bang is a separator between two word-runs). Case-insensitive.
 *  Returns false on null/empty input. */
function nameIsBlocked(sourceName: string | null | undefined): boolean {
  if (sourceName === null || sourceName === undefined || sourceName === '') {
    return false;
  }
  // Normalise the haystack: lowercase + collapse any non-alphanumeric
  // run to a single space, then pad with spaces so all word boundaries
  // become " token " runs detectable by simple substring.
  const haystack = ' ' + sourceName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  for (const token of BLOCKED_NAME_TOKENS) {
    const needle = ' ' + token.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    if (haystack.includes(needle)) return true;
  }
  return false;
}

/** Predicate: should this headline be discarded as off-topic for an
 *  AI-curated tech news product? True if EITHER the URL host or the
 *  RSS-supplied publisher name matches the blocklist. */
export function isBlockedPublisher(headline: Headline): boolean {
  return hostIsBlocked(headline.url) || nameIsBlocked(headline.source_name);
}

/** Drop every headline whose publisher is blocked. Pure: returns a new
 *  array; input is not mutated. */
export function filterBlockedPublishers(
  headlines: readonly Headline[],
): Headline[] {
  return headlines.filter((h) => !isBlockedPublisher(h));
}
