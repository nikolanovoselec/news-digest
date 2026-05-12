// Tests for src/lib/email-html.ts — REQ-MAIL-001 XSS escape + URL-encoded
// href construction. CF-007: the module comment warns "forgetting one
// yields email XSS" and there were previously zero direct unit tests
// against the escape function itself.

import { describe, it, expect } from 'vitest';
import { escapeHtml, headlineRow } from '~/lib/email-html';

describe('escapeHtml', () => {
  it('escapes <script> so the tag cannot survive in HTML', () => {
    const out = escapeHtml('<script>alert(1)</script>');
    expect(out).not.toMatch(/<script>/i);
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes single quote to &#39; (the comment-flagged escape)', () => {
    expect(escapeHtml("o'clock")).toBe('o&#39;clock');
  });

  it('escapes double quote so it cannot break out of an attribute', () => {
    expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('escapes ampersand first so subsequent entities are not double-escaped', () => {
    // If & were escaped last, `<` → `&lt;` then `&` → `&amp;lt;`. The
    // correct output is `&amp;lt;`-once, not `&amp;amp;lt;`.
    expect(escapeHtml('& <')).toBe('&amp; &lt;');
  });

  it('handles a mixed payload combining all five replacements', () => {
    const out = escapeHtml(`<a href="x" data-q='y'>&</a>`);
    expect(out).toBe(
      '&lt;a href=&quot;x&quot; data-q=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('passes through plain text without modification', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('headlineRow', () => {
  it('URL-encodes a slug that contains path-breaking characters', () => {
    // A slug containing `/`, `?`, `#`, `&`, or whitespace must not be
    // able to alter the intended /digest/{id}/{slug} path shape.
    const out = headlineRow({
      appUrlAttr: 'https://example.com',
      id: 'abc',
      slug: 'foo/bar?x=1#frag&y',
      title: 'Some title',
    });
    expect(out).toContain(
      'href="https://example.com/digest/abc/foo%2Fbar%3Fx%3D1%23frag%26y"',
    );
    // None of these raw characters survive in the slug position.
    expect(out).not.toMatch(/digest\/abc\/foo\/bar/);
    expect(out).not.toMatch(/digest\/abc\/[^"]*\?/);
    expect(out).not.toMatch(/digest\/abc\/[^"]*#/);
  });

  it('URL-encodes whitespace in the slug', () => {
    const out = headlineRow({
      appUrlAttr: 'https://example.com',
      id: 'abc',
      slug: 'hello world',
      title: 'T',
    });
    expect(out).toContain('digest/abc/hello%20world');
  });

  it('URL-encodes the id segment as well', () => {
    const out = headlineRow({
      appUrlAttr: 'https://example.com',
      id: 'id/with/slashes',
      slug: 's',
      title: 'T',
    });
    expect(out).toContain('digest/id%2Fwith%2Fslashes/s');
  });

  it('escapes the title so a quote cannot break out of the link body', () => {
    const out = headlineRow({
      appUrlAttr: 'https://example.com',
      id: 'a',
      slug: 'b',
      title: 'A title with "quotes" & <tag>',
    });
    expect(out).toContain(
      'A title with &quot;quotes&quot; &amp; &lt;tag&gt;',
    );
    expect(out).not.toMatch(/<tag>/i);
  });

  it('escapes a title containing the script open tag', () => {
    const out = headlineRow({
      appUrlAttr: 'https://example.com',
      id: 'a',
      slug: 'b',
      title: '<script>alert(1)</script>',
    });
    expect(out).not.toMatch(/<script\b/i);
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('preserves the appUrlAttr prefix verbatim (already escaped by caller)', () => {
    // The contract for `appUrlAttr` is that the caller has already
    // produced a safe attribute string via safeAppUrlAttr (lives in a
    // sibling module). headlineRow concatenates it verbatim — the test
    // documents that contract so a future change does not silently
    // start re-escaping the prefix.
    const out = headlineRow({
      appUrlAttr: 'https://news.example.com',
      id: 'x',
      slug: 'y',
      title: 'T',
    });
    expect(out).toContain('href="https://news.example.com/digest/x/y"');
  });
});
