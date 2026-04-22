// Tests for src/lib/generate.ts text sanitization — REQ-GEN-005 (plaintext
// output) and REQ-GEN-006 AC #4 (sanitization of title/one_liner/details
// before insert).
//
// The pipeline guarantees that HTML tags, control characters, and collapsed
// whitespace never reach the articles table. These tests pin down that
// behaviour at the unit level via the `__test` export — full pipeline
// verification lives in pipeline.test.ts.

import { describe, expect, it } from 'vitest';
import { __test } from '~/lib/generate';

const { sanitizeText, sanitizeArticles } = __test;

describe('sanitizeText', () => {
  it('REQ-GEN-006: strips simple HTML tags', () => {
    expect(sanitizeText('<b>bold</b>')).toBe('bold');
    expect(sanitizeText('<p>para</p>')).toBe('para');
    expect(sanitizeText('before<br/>after')).toBe('before after');
  });

  it('REQ-GEN-006: strips nested and attribute-bearing tags', () => {
    expect(sanitizeText('<a href="https://evil/">click</a>')).toBe('click');
    expect(
      sanitizeText('<div class="x"><span>hello</span></div>'),
    ).toBe('hello');
  });

  it('REQ-GEN-006: strips script/style tag wrappers (content leaks but tags are gone)', () => {
    // Note: <script>alert(1)</script> → the tags go, the literal "alert(1)"
    // text stays (it is no longer executable). Defence in depth — the output
    // is stored as plaintext in D1 and rendered with escaping downstream.
    const out = sanitizeText('<script>alert(1)</script>');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).toContain('alert(1)');
  });

  it('REQ-GEN-006: handles malformed / unbalanced tags', () => {
    // A complete `<b>` is stripped; the content "bold" survives.
    expect(sanitizeText('<b>bold')).toBe('bold');
    // Tag replacement inserts a space to avoid word-concatenation
    // ("before<br/>after" → "before after", not "beforeafter").
    // Multiple collapsing spaces normalise to one.
    expect(sanitizeText('a<x>b</x>c')).toBe('a b c');
    // A `<` with NO `>` anywhere later in the string is preserved — the
    // regex matches only a complete `<...>` pair.
    expect(sanitizeText('5 < 10 and x is bigger')).toBe(
      '5 < 10 and x is bigger',
    );
  });

  it('REQ-GEN-006: strips ASCII control characters', () => {
    expect(sanitizeText('a\x00b\x01c')).toBe('a b c');
    expect(sanitizeText('a\x07bell\x1B[31mred')).toBe('a bell [31mred');
    expect(sanitizeText('hello\x7fworld')).toBe('hello world');
  });

  it('REQ-GEN-006: strips Unicode C1 controls (U+0080..U+009F)', () => {
    expect(sanitizeText('a\u0080b\u009Fc')).toBe('a b c');
  });

  it('REQ-GEN-006: collapses runs of whitespace to a single space', () => {
    expect(sanitizeText('a   b')).toBe('a b');
    expect(sanitizeText('a\tb')).toBe('a b');
    expect(sanitizeText('a\nb')).toBe('a b');
    expect(sanitizeText('a\r\nb')).toBe('a b');
    expect(sanitizeText('  multiple   internal   runs  ')).toBe(
      'multiple internal runs',
    );
  });

  it('REQ-GEN-006: trims leading and trailing whitespace after collapse', () => {
    expect(sanitizeText('   hello   ')).toBe('hello');
    expect(sanitizeText('\n\n  hi  \n')).toBe('hi');
  });

  it('REQ-GEN-006: combines HTML strip + control strip + whitespace collapse', () => {
    const input = '  <p>Hello\x00\tWorld</p>  ';
    expect(sanitizeText(input)).toBe('Hello World');
  });

  it('REQ-GEN-006: returns empty string for nullish or non-string input', () => {
    expect(sanitizeText(null)).toBe('');
    expect(sanitizeText(undefined)).toBe('');
    expect(sanitizeText(42)).toBe('');
    expect(sanitizeText({})).toBe('');
    expect(sanitizeText([])).toBe('');
    expect(sanitizeText(true)).toBe('');
  });

  it('REQ-GEN-006: returns empty string when input sanitizes to nothing', () => {
    expect(sanitizeText('<br/>')).toBe('');
    expect(sanitizeText('<p></p>')).toBe('');
    expect(sanitizeText('   ')).toBe('');
    expect(sanitizeText('\x00\x01\x02')).toBe('');
  });

  it('REQ-GEN-006: preserves non-ASCII letters and punctuation', () => {
    expect(sanitizeText('café — résumé')).toBe('café — résumé');
    expect(sanitizeText('こんにちは世界')).toBe('こんにちは世界');
    expect(sanitizeText('emoji works too')).toBe('emoji works too');
  });

  it('REQ-GEN-006: preserves URLs in text form (only stripped if wrapped in <>)', () => {
    expect(sanitizeText('See https://example.com/foo?bar=1 now')).toBe(
      'See https://example.com/foo?bar=1 now',
    );
    // Wrapped in `<a>` tags: text survives, tags do not.
    expect(
      sanitizeText('<a href="https://example.com">link text</a>'),
    ).toBe('link text');
  });
});

describe('sanitizeArticles', () => {
  it('REQ-GEN-005: sanitizes title, one_liner, and every bullet in details', () => {
    const out = sanitizeArticles({
      articles: [
        {
          title: '<b>  Hot   News  </b>',
          url: 'https://example.com/a',
          one_liner: 'A\x00quick\ttake\n',
          details: [
            '<p>First bullet</p>',
            'Second\u0080bullet',
            'Third    bullet',
          ],
        },
      ],
    });
    expect(out).toHaveLength(1);
    const article = out[0]!;
    expect(article.title).toBe('Hot News');
    expect(article.one_liner).toBe('A quick take');
    expect(article.details).toEqual([
      'First bullet',
      'Second bullet',
      'Third bullet',
    ]);
    expect(article.url).toBe('https://example.com/a');
  });

  it('REQ-GEN-006: drops articles whose title sanitizes to empty', () => {
    const out = sanitizeArticles({
      articles: [
        {
          title: '<p></p>',
          url: 'https://example.com/a',
          one_liner: 'hi',
          details: ['a', 'b', 'c'],
        },
        {
          title: 'Valid title',
          url: 'https://example.com/b',
          one_liner: 'hi',
          details: ['a', 'b', 'c'],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('Valid title');
  });

  it('REQ-GEN-006: drops articles missing a url', () => {
    const out = sanitizeArticles({
      articles: [
        {
          title: 'No URL',
          url: '',
          one_liner: 'hi',
          details: ['a', 'b', 'c'],
        },
        {
          title: 'Has URL',
          url: 'https://example.com/a',
          one_liner: 'hi',
          details: ['a', 'b', 'c'],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('Has URL');
  });

  it('REQ-GEN-006: drops articles whose one_liner sanitizes to empty', () => {
    const out = sanitizeArticles({
      articles: [
        {
          title: 'Good',
          url: 'https://example.com/a',
          one_liner: '<br/>',
          details: ['a', 'b', 'c'],
        },
      ],
    });
    expect(out).toHaveLength(0);
  });

  it('REQ-GEN-006: silently drops empty bullets but keeps valid ones', () => {
    const out = sanitizeArticles({
      articles: [
        {
          title: 'Good',
          url: 'https://example.com/a',
          one_liner: 'one-liner',
          details: ['<br/>', 'Bullet 1', '   ', 'Bullet 2'],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.details).toEqual(['Bullet 1', 'Bullet 2']);
  });

  it('REQ-GEN-006: handles completely empty article list', () => {
    expect(sanitizeArticles({ articles: [] })).toEqual([]);
    expect(sanitizeArticles({})).toEqual([]);
  });

  it('REQ-GEN-006: drops non-object entries in articles', () => {
    const out = sanitizeArticles({
      // Deliberately malformed entries alongside one good one.
      articles: [
        null as unknown as { title?: unknown },
        'string entry' as unknown as { title?: unknown },
        42 as unknown as { title?: unknown },
        {
          title: 'OK',
          url: 'https://example.com',
          one_liner: 'hi',
          details: ['x', 'y', 'z'],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('OK');
  });

  it('REQ-GEN-006: non-array details produces empty details (not a crash)', () => {
    const out = sanitizeArticles({
      articles: [
        {
          title: 'Good',
          url: 'https://example.com/a',
          one_liner: 'hi',
          details: 'not an array' as unknown as unknown[],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.details).toEqual([]);
  });

  it('REQ-GEN-005: strips inline links from one_liner (title/details get same treatment)', () => {
    // REQ-GEN-005 forbids inline links in plaintext. Once the prompt has
    // done its job, sanitization is the backstop: `<a>` tags go, the text
    // survives.
    const out = sanitizeArticles({
      articles: [
        {
          title: 'Story',
          url: 'https://example.com/a',
          one_liner: 'Read <a href="https://evil/x">here</a> now',
          details: ['See <a href="https://evil/x">source</a> for details'],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.one_liner).toBe('Read here now');
    expect(out[0]?.details).toEqual(['See source for details']);
  });
});
