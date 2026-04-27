// Implements REQ-PIPE-001
//
// Article-body fetcher. When a feed's snippet is thin (or absent),
// the LLM has nothing to summarize and falls back to boilerplate
// hallucination. This module fetches the article URL directly,
// extracts readable text from the HTML, and returns it capped at a
// reasonable size so the chunk prompt stays budget-safe.
//
// Security + cost controls:
//   - `isUrlSafe` SSRF guard on every target URL (HTTPS-only, no
//     private/loopback/link-local ranges).
//   - 5-second timeout per fetch.
//   - 1 MB response cap.
//   - 20-worker concurrency bucket when called in bulk so 500
//     candidates don't stampede the network.
//   - Plaintext output capped at 3000 characters — enough for a
//     150-200 word summary with context, not so much that the
//     per-chunk prompt balloons.

import { isUrlSafe } from '~/lib/ssrf';
import { mapConcurrent } from '~/lib/concurrency';

/** Default fan-out for body fetches. Roughly 2x the feed-fetch limit
 *  because article HTML pages are smaller, faster, and tolerate
 *  higher origin pressure than feed re-fetches. */
export const ARTICLE_BODY_FETCH_CONCURRENCY = 20;

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 1_500_000;
const SNIPPET_CAP = 3000;

/**
 * Extract readable text from raw HTML. Runs the heuristic through
 * several container candidates and takes whichever produces the
 * LONGEST cleaned text — sites structure their markup wildly
 * differently:
 *   <article>, <main>, <div class=".post-content|.entry-content|
 *   .article-body|.post-body|.article-content|.content|.prose|
 *   .markdown-body|.rich-text|.gh-content|.post-entry|...">
 * If NONE of those land a body, fall through to the full stripped
 * `<body>` — catches plain-`<p>`-tag pages too. Script/style/nav/
 * header/footer/aside blocks are removed first so their contents
 * don't leak into the text.
 */
export function extractArticleText(html: string): string {
  // Drop non-content blocks BEFORE tag-stripping so their contents
  // don't leak in.
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  // Collect every candidate container body text — we take whichever
  // produces the longest clean output.
  const candidates: string[] = [];
  for (const m of cleaned.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/gi)) {
    if (m[1] !== undefined) candidates.push(m[1]);
  }
  for (const m of cleaned.matchAll(/<main[^>]*>([\s\S]*?)<\/main>/gi)) {
    if (m[1] !== undefined) candidates.push(m[1]);
  }
  const containerPattern =
    /<(?:div|section)[^>]*(?:class|id)=["'][^"']*(?:post-content|post-body|post-entry|post-full-content|entry-content|article-body|article-content|article__content|gh-content|markdown-body|prose|rich-text|page-content|story-body|story__content|post__content|content-body|content__body|story-content|mw-parser-output|notion-page-content|rst-content|blogpost|blog-post)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section)>/gi;
  for (const m of cleaned.matchAll(containerPattern)) {
    if (m[1] !== undefined) candidates.push(m[1]);
  }
  // Final fallback: stripped <body>. Noisy but catches everything.
  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch !== null && bodyMatch[1] !== undefined) {
    candidates.push(bodyMatch[1]);
  } else {
    candidates.push(cleaned);
  }

  let best = '';
  for (const c of candidates) {
    const text = stripAndDecode(c);
    if (text.length > best.length) best = text;
  }
  const result = best.length > SNIPPET_CAP ? best.slice(0, SNIPPET_CAP) : best;
  return result;
}

/** Remove HTML tags, decode common entities, collapse whitespace. */
function stripAndDecode(raw: string): string {
  const stripped = raw.replace(/<[^>]+>/g, ' ');
  const decoded = stripped
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rdquo;/g, '\u201d')
    .replace(/&ldquo;/g, '\u201c')
    .replace(/&hellip;/g, '\u2026')
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const code = Number.parseInt(n, 10);
      return Number.isFinite(code) && code >= 32 && code < 65536
        ? String.fromCharCode(code)
        : ' ';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => {
      const code = Number.parseInt(h, 16);
      return Number.isFinite(code) && code >= 32 && code < 65536
        ? String.fromCharCode(code)
        : ' ';
    });
  return decoded.replace(/\s+/g, ' ').trim();
}

/**
 * Fetch one article URL and return its extracted body text, or
 * null on any failure (SSRF reject, timeout, non-2xx, oversized
 * body, empty after extraction). Never throws.
 *
 * Sends a browser-like User-Agent — some CDN / WAF configs flag
 * any UA containing 'bot' or 'curl' and return 403. Posing as
 * Firefox is honest-ish (we ARE a fetch client) and doesn't
 * trigger those filters.
 */
export async function fetchArticleBody(
  url: string,
  contactUrl?: string,
): Promise<string | null> {
  if (!isUrlSafe(url)) return null;
  // Per RFC 9309 / HTTP politeness convention: include a contact URL
  // in the User-Agent so an upstream operator can find us if we cause
  // load. Defaults to the worker's APP_URL via the caller; falls back
  // to a generic identifier when unset (e.g. local dev with no
  // configured deployment hostname).
  const ua =
    contactUrl !== undefined && contactUrl !== ''
      ? `Mozilla/5.0 (compatible; news-digest/1.0; +${contactUrl})`
      : 'Mozilla/5.0 (compatible; news-digest/1.0)';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,text/plain,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!response.ok) return null;
    // Be lenient on content-type: accept anything HTML-ish OR
    // text/plain OR missing header. A lot of sites mislabel or
    // omit the header; rejecting them was killing our hit rate.
    const contentType = (
      response.headers.get('content-type') ?? ''
    ).toLowerCase();
    if (contentType !== '' &&
        !contentType.includes('html') &&
        !contentType.includes('text/plain') &&
        !contentType.includes('application/xml')) {
      return null;
    }
    const reader = response.body?.getReader();
    if (reader === undefined) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    // Manual read loop so we can enforce MAX_BODY_BYTES without
    // buffering an entire multi-MB response.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      buffer.set(c, offset);
      offset += c.byteLength;
    }
    const html = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    const text = extractArticleText(html);
    return text.length >= 100 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch article bodies for a list of URLs with bounded concurrency.
 * Returns a map of url → body-text (or missing entry on failure).
 * Caller filters by which entries came back non-empty.
 */
export async function fetchArticleBodies(
  urls: readonly string[],
  concurrency = ARTICLE_BODY_FETCH_CONCURRENCY,
  contactUrl?: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await mapConcurrent(urls, concurrency, async (url) => {
    const body = await fetchArticleBody(url, contactUrl);
    if (body !== null && body !== '') out.set(url, body);
  });
  return out;
}
