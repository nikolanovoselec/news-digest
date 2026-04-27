// Tests for src/lib/generate.ts text sanitization — REQ-PIPE-002
// (plaintext output across the full chunk pipeline).
//
// The pipeline guarantees that HTML tags, control characters, and
// collapsed whitespace never reach the articles table. These tests
// pin down sanitizeText at the unit level via the `__test` export —
// full pipeline verification lives in pipeline.test.ts.
//
// CF-017 deleted sanitizeArticles + GeneratedArticle (production no
// longer called the helper — the chunk consumer assembles articles
// inline and only consumes sanitizeText). The dedicated
// sanitizeArticles describe blocks were removed alongside.

import { describe, expect, it } from 'vitest';
import { __test } from '~/lib/generate';

const { sanitizeText } = __test;

describe('sanitizeText', () => {
  it('REQ-PIPE-002: strips simple HTML tags', () => {
    expect(sanitizeText('<b>bold</b>')).toBe('bold');
    expect(sanitizeText('<p>para</p>')).toBe('para');
    expect(sanitizeText('before<br/>after')).toBe('before after');
  });

  it('REQ-PIPE-002: strips nested and attribute-bearing tags', () => {
    expect(sanitizeText('<a href="https://evil/">click</a>')).toBe('click');
    expect(
      sanitizeText('<div class="x"><span>hello</span></div>'),
    ).toBe('hello');
  });

  it('REQ-PIPE-002: strips script/style tag wrappers (content leaks but tags are gone)', () => {
    // Note: <script>alert(1)</script> → the tags go, the literal "alert(1)"
    // text stays (it is no longer executable). Defence in depth — the output
    // is stored as plaintext in D1 and rendered with escaping downstream.
    const out = sanitizeText('<script>alert(1)</script>');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).toContain('alert(1)');
  });

  it('REQ-PIPE-002: handles malformed / unbalanced tags', () => {
    expect(sanitizeText('<b>bold')).toBe('bold');
    expect(sanitizeText('a<x>b</x>c')).toBe('a b c');
    expect(sanitizeText('5 < 10 and x is bigger')).toBe(
      '5 < 10 and x is bigger',
    );
  });

  it('REQ-PIPE-002: strips ASCII control characters', () => {
    expect(sanitizeText('a\x00b\x01c')).toBe('a b c');
    expect(sanitizeText('a\x07bell\x1B[31mred')).toBe('a bell [31mred');
    expect(sanitizeText('hello\x7fworld')).toBe('hello world');
  });

  it('REQ-PIPE-002: strips Unicode C1 controls (U+0080..U+009F)', () => {
    expect(sanitizeText('abc')).toBe('a b c');
  });

  it('REQ-PIPE-002: collapses runs of whitespace to a single space', () => {
    expect(sanitizeText('a   b')).toBe('a b');
    expect(sanitizeText('a\tb')).toBe('a b');
    expect(sanitizeText('a\nb')).toBe('a b');
    expect(sanitizeText('a\r\nb')).toBe('a b');
    expect(sanitizeText('  multiple   internal   runs  ')).toBe(
      'multiple internal runs',
    );
  });

  it('REQ-PIPE-002: trims leading and trailing whitespace after collapse', () => {
    expect(sanitizeText('   hello   ')).toBe('hello');
    expect(sanitizeText('\n\n  hi  \n')).toBe('hi');
  });

  it('REQ-PIPE-002: combines HTML strip + control strip + whitespace collapse', () => {
    const input = '  <p>Hello\x00\tWorld</p>  ';
    expect(sanitizeText(input)).toBe('Hello World');
  });

  it('REQ-PIPE-002: returns empty string for nullish or non-string input', () => {
    expect(sanitizeText(null)).toBe('');
    expect(sanitizeText(undefined)).toBe('');
    expect(sanitizeText(42)).toBe('');
    expect(sanitizeText({})).toBe('');
    expect(sanitizeText([])).toBe('');
    expect(sanitizeText(true)).toBe('');
  });

  it('REQ-PIPE-002: returns empty string when input sanitizes to nothing', () => {
    expect(sanitizeText('<br/>')).toBe('');
    expect(sanitizeText('<p></p>')).toBe('');
    expect(sanitizeText('   ')).toBe('');
    expect(sanitizeText('\x00\x01\x02')).toBe('');
  });

  it('REQ-PIPE-002: preserves non-ASCII letters and punctuation', () => {
    expect(sanitizeText('café — résumé')).toBe('café — résumé');
    expect(sanitizeText('こんにちは世界')).toBe('こんにちは世界');
    expect(sanitizeText('emoji works too')).toBe('emoji works too');
  });

  it('REQ-PIPE-002: preserves URLs in text form (only stripped if wrapped in <>)', () => {
    expect(sanitizeText('See https://example.com/foo?bar=1 now')).toBe(
      'See https://example.com/foo?bar=1 now',
    );
    expect(
      sanitizeText('<a href="https://example.com">link text</a>'),
    ).toBe('link text');
  });
});
