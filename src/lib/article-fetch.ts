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
import { stripHtmlToText } from '~/lib/html-text';
import {
  ARTICLE_FETCH_TIMEOUT_MS,
  ARTICLE_MAX_BODY_BYTES,
} from '~/lib/fetch-policy';

/** Default fan-out for body fetches. Roughly 2x the feed-fetch limit
 *  because article HTML pages are smaller, faster, and tolerate
 *  higher origin pressure than feed re-fetches. */
export const ARTICLE_BODY_FETCH_CONCURRENCY = 20;

const FETCH_TIMEOUT_MS = ARTICLE_FETCH_TIMEOUT_MS;
const MAX_BODY_BYTES = ARTICLE_MAX_BODY_BYTES;
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
  //
  // Closing-tag pattern accepts optional whitespace + attribute-shaped
  // garbage between the tag name and `>` (e.g. `</script >`,
  // `</script\n>`, `</script foo>`). The HTML spec is permissive
  // enough that real-world parsers tolerate these forms, and the
  // strict `</script>` literal CodeQL flagged (#142, js/bad-tag-filter)
  // would let an attacker smuggle a `<script>...</script foo>` block
  // past the strip and into the LLM-prompt body.
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav\s*>/gi, ' ')
    .replace(/<header\b[\s\S]*?<\/header\s*>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer\s*>/gi, ' ')
    .replace(/<aside\b[\s\S]*?<\/aside\s*>/gi, ' ')
    .replace(/<form\b[\s\S]*?<\/form\s*>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, ' ');

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
    const text = stripHtmlToText(c);
    if (text.length > best.length) best = text;
  }
  const result = best.length > SNIPPET_CAP ? best.slice(0, SNIPPET_CAP) : best;
  return result;
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
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
