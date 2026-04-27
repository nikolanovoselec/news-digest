// Implements REQ-PIPE-001
// Implements REQ-DISC-001
//
// Centralised network policy for the scrape pipeline. CF-043 found
// the same timeout / size cap constants drifting across three modules
// — sources.ts (RSS), discovery.ts (feed discovery), article-fetch.ts
// (article body). One file is easier to keep in sync with origin
// politeness expectations and runtime budgets.
//
// Policy at a glance:
//   - Feed fetches are smaller and faster than article HTML; we cap
//     them tighter to bound a single coordinator tick.
//   - Article body fetches see WAF/CDN that often impose their own
//     5-10s budgets; we sit at 8s so we don't trip a slow-link timeout
//     prematurely while still getting back to the queue handler in
//     under 10s.
//   - 1.5 MB on article HTML covers every legitimate news page (a
//     "long-form" piece is typically <500 KB even with inline assets);
//     larger payloads are almost always tracker/ad bloat.

/** Per-request fetch timeout for RSS / Atom feed pulls (sources.ts +
 *  discovery.ts). 5s is enough for a polite origin and short enough
 *  to keep the coordinator's worker pool moving. */
export const FEED_FETCH_TIMEOUT_MS = 5_000;

/** Per-request fetch timeout for article body fetches
 *  (article-fetch.ts). Slightly longer than feed fetches because
 *  article HTML is heavier and many CDNs add render-tier latency. */
export const ARTICLE_FETCH_TIMEOUT_MS = 8_000;

/** Maximum bytes accepted from a single feed response. Used by
 *  discovery.ts for the candidate-feed sniff. Larger than the typical
 *  feed (50-200 KB) but capped so a misconfigured origin returning a
 *  full HTML site can't drown the worker. */
export const FEED_MAX_BODY_BYTES = 1_048_576; // 1 MiB

/** Maximum bytes accepted from a single article-body response. Caps
 *  pathological pages while admitting realistic long-form journalism. */
export const ARTICLE_MAX_BODY_BYTES = 1_500_000; // ~1.4 MiB
