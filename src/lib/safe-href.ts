// Implements REQ-DISC-005 (render-time defense-in-depth)
//
// CF-021 — render-time scheme guard for URLs read out of D1. The
// coordinator's write-time filter (`isSafeWebUrl` in
// src/queue/scrape-coordinator.ts) and the SSRF guard
// (`isUrlSafe` in src/lib/ssrf.ts) both reject non-https URLs at write
// time, but historic rows in `articles.primary_source_url` and
// `article_sources.source_url` predate that gate. The render path
// must not assume earlier filtering — per the project's
// "validate at every boundary" rule. Anything that doesn't pass this
// check renders as `#` so the link is harmless if a stale http or
// non-web-scheme URL ever sneaks through.

/**
 * Return {@link url} unchanged when it parses as an https URL,
 * otherwise return `'#'`. Used to harden the `href` attribute of
 * links rendered from arbitrary D1 row content.
 */
export function safeHref(url: string | null | undefined): string {
  if (typeof url !== 'string' || url === '') return '#';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return '#';
    return url;
  } catch {
    return '#';
  }
}
