// Implements REQ-PIPE-001
// Implements REQ-PIPE-002
//
// Shared HTML-to-text helpers for the scrape pipeline. CF-006 found
// near-duplicate implementations in `sources.ts` (RSS snippet cleanup)
// and `article-fetch.ts` (article body extraction) — same regex shape,
// different entity tables. Centralising fixes by-construction the case
// where one site decodes `&mdash;` but the other doesn't.
//
// Output is plain text suitable for LLM prompts and storage. NOT a
// full HTML sanitiser — never feed this output back into a renderer.

/** Decode the common HTML entity set produced by news feeds and
 *  article HTML. Covers named entities, decimal `&#NNN;`, and hex
 *  `&#xHH;` numeric refs. Codepoints below 32 or above 0xFFFF are
 *  replaced with a single space (control chars + non-BMP — safe for
 *  prompt budgets).
 *
 *  Order matters: `&amp;` is decoded LAST so an input like
 *  `&amp;lt;` (the literal text representation of `&lt;`) does NOT
 *  cascade into a real `<` after a downstream pass. CodeQL's
 *  `js/double-escaping` rule flags the inverse order. Numeric refs
 *  must also run before `&amp;` for the same reason — `&amp;#39;`
 *  preserves its literal form rather than collapsing to an apostrophe.
 */
export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rdquo;/g, '”')
    .replace(/&ldquo;/g, '“')
    .replace(/&hellip;/g, '…')
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
    })
    // `&amp;` LAST — see comment above. CodeQL js/double-escaping #170.
    .replace(/&amp;/g, '&');
}

/** Strip HTML tags, decode entities, collapse runs of whitespace.
 *  Optionally truncates to {@link options.maxLength} characters when
 *  the caller has a downstream prompt budget to honour. */
export function stripHtmlToText(
  raw: string,
  options: { maxLength?: number } = {},
): string {
  const noTags = raw.replace(/<[^>]+>/g, ' ');
  const decoded = decodeHtmlEntities(noTags);
  const collapsed = decoded.replace(/\s+/g, ' ').trim();
  if (
    options.maxLength !== undefined &&
    collapsed.length > options.maxLength
  ) {
    return collapsed.slice(0, options.maxLength);
  }
  return collapsed;
}
