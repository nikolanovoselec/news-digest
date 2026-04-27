// Tests for src/lib/html-text.ts — REQ-PIPE-001 / REQ-PIPE-002.
//
// Pins the entity-decoding contract for the scrape pipeline. The
// most load-bearing assertion is the &amp;-LAST ordering that
// closes CodeQL alert #170 (js/double-escaping): decoding &amp; first
// would let an input like &amp;lt; cascade into a real `<` on the
// next pass. The literal text "&lt;" (representing the characters
// `&`, `l`, `t`, `;`) MUST survive the round-trip intact.

import { describe, it, expect } from 'vitest';
import { decodeHtmlEntities, stripHtmlToText } from '~/lib/html-text';

describe('decodeHtmlEntities — REQ-PIPE-001', () => {
  it('decodes the common named entity set', () => {
    expect(decodeHtmlEntities('foo&nbsp;bar')).toBe('foo bar');
    expect(decodeHtmlEntities('a&lt;b')).toBe('a<b');
    expect(decodeHtmlEntities('a&gt;b')).toBe('a>b');
    expect(decodeHtmlEntities('&quot;hi&quot;')).toBe('"hi"');
    expect(decodeHtmlEntities('it&#39;s')).toBe("it's");
    expect(decodeHtmlEntities('it&apos;s')).toBe("it's");
    expect(decodeHtmlEntities('a&mdash;b')).toBe('a—b');
    expect(decodeHtmlEntities('a&ndash;b')).toBe('a–b');
    expect(decodeHtmlEntities('he said&hellip;')).toBe('he said…');
  });

  it('decodes a bare &amp; to a single ampersand', () => {
    expect(decodeHtmlEntities('AT&amp;T')).toBe('AT&T');
  });

  it('decodes decimal numeric references', () => {
    expect(decodeHtmlEntities('&#65;&#66;&#67;')).toBe('ABC');
  });

  it('decodes hex numeric references', () => {
    expect(decodeHtmlEntities('&#x41;&#x42;')).toBe('AB');
  });

  it('replaces control-codepoints and non-BMP refs with a space', () => {
    // Below 32 → space.
    expect(decodeHtmlEntities('a&#1;b')).toBe('a b');
    // Above 0xFFFF → space.
    expect(decodeHtmlEntities('a&#x10000;b')).toBe('a b');
  });

  // CodeQL js/double-escaping #170 — the &amp;-LAST contract.
  // If &amp; were decoded first, &amp;lt; would become &lt; and then
  // the next pass would convert it to `<`. Decoding &amp; last keeps
  // the literal text intact.
  it('preserves literal "&lt;" when input is "&amp;lt;" (CodeQL #170)', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeHtmlEntities('&amp;gt;')).toBe('&gt;');
    expect(decodeHtmlEntities('&amp;quot;')).toBe('&quot;');
  });

  it('preserves literal "&#39;" when input is "&amp;#39;" (no double-decode)', () => {
    // Numeric refs must also run before &amp; — otherwise &amp;#39;
    // would collapse all the way to an apostrophe.
    expect(decodeHtmlEntities('&amp;#39;')).toBe('&#39;');
    expect(decodeHtmlEntities('&amp;#x41;')).toBe('&#x41;');
  });

  it('preserves "&amp;amp;" → "&amp;" (single-pass decode)', () => {
    // Each call is one decode pass. Double-encoded ampersand decodes
    // exactly one level.
    expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;');
  });
});

describe('stripHtmlToText — REQ-PIPE-002', () => {
  it('strips tags, decodes entities, and collapses whitespace', () => {
    expect(stripHtmlToText('<p>hello&nbsp;<b>world</b></p>')).toBe(
      'hello world',
    );
  });

  it('truncates to maxLength when supplied', () => {
    expect(stripHtmlToText('<p>abcdefghij</p>', { maxLength: 5 })).toBe(
      'abcde',
    );
  });

  it('returns the trimmed full text when shorter than maxLength', () => {
    expect(stripHtmlToText('<p>abc</p>', { maxLength: 100 })).toBe('abc');
  });
});
