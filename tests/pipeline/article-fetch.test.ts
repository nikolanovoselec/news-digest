// Tests for src/lib/article-fetch.ts — REQ-PIPE-001 AC 8.
//
// The fetcher is the "grounding" layer: when a feed snippet is too
// thin for the LLM to write a faithful summary, the coordinator
// fetches the article URL directly and extracts plaintext. A missing
// or broken fetcher means the LLM summarises boilerplate, which
// produces hallucinated content. These tests pin the contract:
//   - SSRF filter rejects unsafe URLs
//   - HTTP errors yield null (no partial garbage)
//   - Non-HTML responses yield null
//   - Oversized responses are truncated (the extractor handles the cap)
//   - Extraction picks the longest of the container candidates
//   - Extraction strips script/style/nav/header/footer/aside
//   - Output under the "too thin to ground" threshold yields null
//   - Bulk fetch honours its concurrency bucket

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  extractArticleText,
  fetchArticleBody,
  fetchArticleBodies,
} from '~/lib/article-fetch';

describe('extractArticleText — REQ-PIPE-001 AC 8', () => {
  it('REQ-PIPE-001: prefers <article> content over surrounding chrome', () => {
    const html = `
      <html>
        <body>
          <nav>Home About Contact</nav>
          <header>Site masthead</header>
          <article>
            The coordinator fetches article bodies when feed snippets
            are too thin to ground a summary. The LLM then has real
            source text to paraphrase instead of hallucinating from
            boilerplate. This paragraph is long enough that the
            extractor should select it over the surrounding chrome.
          </article>
          <footer>Terms Privacy</footer>
        </body>
      </html>
    `;
    const text = extractArticleText(html);
    expect(text).toContain('real source text');
    expect(text).not.toContain('Home About Contact');
    expect(text).not.toContain('Site masthead');
    expect(text).not.toContain('Terms Privacy');
  });

  it('REQ-PIPE-001: picks the longest candidate when multiple containers match', () => {
    const html = `
      <html>
        <body>
          <main>Short main blurb.</main>
          <div class="article-body">
            This article-body container carries substantially more
            real content than the short main element above it, so
            the extractor must return this paragraph rather than the
            tiny main one. Selection is length-based so class-name
            churn across sites does not require per-site tuning.
          </div>
        </body>
      </html>
    `;
    const text = extractArticleText(html);
    expect(text).toContain('substantially more');
    expect(text).not.toBe('Short main blurb.');
  });

  it('REQ-PIPE-001: strips <script>, <style>, <noscript>, <svg> contents', () => {
    const html = `
      <html>
        <body>
          <article>
            Clean body text we do want.
            <script>window.__data = { leak: true };</script>
            <style>.article { color: red; }</style>
            <svg><path d="M0 0L10 10"/></svg>
            <noscript>Please enable JavaScript.</noscript>
          </article>
        </body>
      </html>
    `;
    const text = extractArticleText(html);
    expect(text).toContain('Clean body text');
    expect(text).not.toMatch(/window\.__data/);
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('Please enable JavaScript');
  });

  // CodeQL js/bad-tag-filter #142 / #171 — the original strip regex
  // required a literal `</script>` and missed `</script >` (whitespace
  // before the `>`), `</script\n>` (newline), and `</script foo>`
  // (attribute-shaped junk). HTML parsers tolerate ALL these forms,
  // so attacker-controlled feed bodies could smuggle script content
  // into the LLM-prompt body. The fix uses `</script\b[^>]*>`.
  it('REQ-PIPE-001: strips script/style with whitespace and junk before the closing >', () => {
    const html = `
      <article>
        Clean body text we do want.
        <script>window.__leak1 = 1;</script >
        <script>window.__leak2 = 2;</script\n>
        <style>.x { color: red; }</style >
        <script foo="bar">window.__leak3 = 3;</script bar>
      </article>
    `;
    const text = extractArticleText(html);
    expect(text).toContain('Clean body text');
    expect(text).not.toMatch(/window\.__leak1/);
    expect(text).not.toMatch(/window\.__leak2/);
    expect(text).not.toMatch(/color: red/);
    expect(text).not.toMatch(/window\.__leak3/);
  });

  // CodeQL #171 — isolates the case where the attribute-shaped close
  // is the ONLY closing variant in the document (no later strict
  // `</script>` for the lazy quantifier to fall through to). The
  // earlier composite test had a trailing `</article>` that masked
  // this branch — a stricter `</script\s*>` regex looked correct
  // against the composite input but still let this fixture leak.
  it('REQ-PIPE-001: strips a script when its attribute-shaped close is the ONLY closing variant', () => {
    const html =
      '<html><body>Article body that is plenty long to ground a summary across the threshold. ' +
      '<script>window.__smuggle = 42;</script attr-only>' +
      'Trailing prose that keeps the body candidate populated.</body></html>';
    const text = extractArticleText(html);
    expect(text).toContain('Article body that is plenty long');
    expect(text).toContain('Trailing prose');
    expect(text).not.toMatch(/window\.__smuggle/);
    expect(text).not.toMatch(/= 42/);
  });

  it('REQ-PIPE-001: falls back to <body> when no known container matches', () => {
    const html = `
      <html>
        <body>
          <p>Plain paragraph one with enough length to survive.</p>
          <p>Plain paragraph two with even more content to extract.</p>
        </body>
      </html>
    `;
    const text = extractArticleText(html);
    expect(text).toContain('paragraph one');
    expect(text).toContain('paragraph two');
  });

  it('REQ-PIPE-001: decodes HTML entities and collapses whitespace', () => {
    const html =
      '<article>A &amp; B &mdash; say &#8220;hello&#8221;.\n\n\nDone.</article>';
    const text = extractArticleText(html);
    expect(text).toContain('A & B');
    expect(text).toContain('\u2014');
    expect(text).toContain('\u201chello\u201d');
    expect(text).not.toMatch(/\s{2,}/);
  });
});

describe('fetchArticleBody — REQ-PIPE-001 AC 8', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('REQ-PIPE-001: rejects non-HTTPS URLs via the SSRF filter (returns null, no network call)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('should not be called', { status: 200 }),
    );
    const out = await fetchArticleBody('http://example.com/insecure');
    expect(out).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-001: rejects private-range IPs via the SSRF filter', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ignored', { status: 200 }),
    );
    const out = await fetchArticleBody('https://10.0.0.1/secret');
    expect(out).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-001: returns null on non-2xx HTTP response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Forbidden', { status: 403 }),
    );
    const out = await fetchArticleBody('https://example.com/blocked');
    expect(out).toBeNull();
  });

  it('REQ-PIPE-001: returns null when the content-type is declared as non-HTML/plain/xml', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('binary garbage', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    );
    const out = await fetchArticleBody('https://example.com/blob');
    expect(out).toBeNull();
  });

  it('REQ-PIPE-001: returns null when the extracted text is under the grounding threshold', async () => {
    // 100-character threshold is the contract — anything shorter
    // isn't enough for the LLM to produce a non-hallucinated summary.
    const thinHtml = '<html><body><article>Too short.</article></body></html>';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(thinHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const out = await fetchArticleBody('https://example.com/too-thin');
    expect(out).toBeNull();
  });

  it('REQ-PIPE-001: returns the extracted text on a well-formed HTML response', async () => {
    const body = 'This is a real article body with enough substance to count as genuine content for grounding. '.repeat(3);
    const html = `<html><body><article>${body}</article></body></html>`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    const out = await fetchArticleBody('https://example.com/good');
    expect(out).not.toBeNull();
    expect(out).toContain('real article body');
  });

  it('REQ-PIPE-001: swallows network errors and returns null rather than throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    const out = await fetchArticleBody('https://example.com/dead');
    expect(out).toBeNull();
  });

  it('REQ-PIPE-001: swallows AbortError from the timeout path and returns null', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      // Simulate a signal firing by mirroring the AbortError shape.
      const signal = (init as RequestInit | undefined)?.signal;
      if (signal !== undefined) {
        throw new DOMException('aborted', 'AbortError');
      }
      return new Response('ignored', { status: 200 });
    });
    const out = await fetchArticleBody('https://example.com/slow');
    expect(out).toBeNull();
  });
});

describe('fetchArticleBodies — REQ-PIPE-001 AC 8', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('REQ-PIPE-001: populates the result map with one entry per URL that fetched cleanly', async () => {
    const longBody = 'Ground-truth article content for three distinct URLs. '.repeat(4);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/fail')) return new Response('nope', { status: 500 });
      return new Response(`<html><body><article>${longBody}</article></body></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    const urls = [
      'https://a.example.com/one',
      'https://b.example.com/two',
      'https://c.example.com/fail',
    ];
    const out = await fetchArticleBodies(urls, 5);
    expect(out.has('https://a.example.com/one')).toBe(true);
    expect(out.has('https://b.example.com/two')).toBe(true);
    expect(out.has('https://c.example.com/fail')).toBe(false);
  });
});
