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

const { sanitizeText, sanitizeArticles: sanitizeArticlesRaw } = __test;

/** Empty source_name lookup for tests that don't care about the badge column.
 * `sanitizeArticles` resolves each article's `source_name` from this map by
 * canonicalized URL; with an empty map every article ends up with
 * `source_name: null`, which is the same null we'd store for any URL the
 * LLM returns that isn't present in the fan-out headlines. */
const NO_SOURCES = new Map<string, string>();
const NO_SOURCE_TAGS = new Map<string, string[]>();
const NO_USER_HASHTAGS: string[] = [];

// Adapter that lets pre-tags-feature tests keep their two-argument
// call shape. The full 4-arg form is exercised by the dedicated
// "tags" describe block below.
function sanitizeArticles(
  payload: Parameters<typeof sanitizeArticlesRaw>[0],
  sources: Map<string, string>,
  sourceTags: Map<string, string[]> = NO_SOURCE_TAGS,
  userHashtags: string[] = NO_USER_HASHTAGS,
): ReturnType<typeof sanitizeArticlesRaw> {
  return sanitizeArticlesRaw(payload, sources, sourceTags, userHashtags);
}

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
    }, NO_SOURCES);
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
    }, NO_SOURCES);
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
    }, NO_SOURCES);
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
    }, NO_SOURCES);
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
    }, NO_SOURCES);
    expect(out).toHaveLength(1);
    expect(out[0]?.details).toEqual(['Bullet 1', 'Bullet 2']);
  });

  it('REQ-GEN-006: handles completely empty article list', () => {
    expect(sanitizeArticles({ articles: [] }, NO_SOURCES)).toEqual([]);
    expect(sanitizeArticles({}, NO_SOURCES)).toEqual([]);
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
    }, NO_SOURCES);
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
    }, NO_SOURCES);
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
    }, NO_SOURCES);
    expect(out).toHaveLength(1);
    expect(out[0]?.one_liner).toBe('Read here now');
    expect(out[0]?.details).toEqual(['See source for details']);
  });
});

describe('sanitizeArticles — tags validation', () => {
  it('REQ-GEN-005: keeps tags that are in the user\'s hashtag list', () => {
    const out = sanitizeArticles(
      {
        articles: [
          {
            title: 'CF news',
            url: 'https://blog.cloudflare.com/x',
            one_liner: 'one-liner',
            details: ['a', 'b', 'c'],
            tags: ['cloudflare', 'generative-ai'],
          },
        ],
      },
      NO_SOURCES,
      NO_SOURCE_TAGS,
      ['cloudflare', 'generative-ai', 'mcp'],
    );
    expect(out[0]?.tags).toEqual(['cloudflare', 'generative-ai']);
  });

  it('REQ-GEN-005: drops LLM-hallucinated tags not in the user\'s list', () => {
    const out = sanitizeArticles(
      {
        articles: [
          {
            title: 'Mixed tags',
            url: 'https://example.com/x',
            one_liner: 'one-liner',
            details: ['a', 'b', 'c'],
            tags: ['cloudflare', 'unicorns', 'AI'],
          },
        ],
      },
      NO_SOURCES,
      NO_SOURCE_TAGS,
      ['cloudflare', 'generative-ai'],
    );
    // 'unicorns' is not a user hashtag — dropped. 'AI' normalises to
    // lowercase 'generative-ai' and matches.
    expect(out[0]?.tags).toEqual(['cloudflare', 'generative-ai']);
  });

  it('REQ-GEN-005: strips leading # and dedupes tags', () => {
    const out = sanitizeArticles(
      {
        articles: [
          {
            title: 'hashes',
            url: 'https://example.com/y',
            one_liner: 'one-liner',
            details: ['a', 'b', 'c'],
            tags: ['#cloudflare', 'cloudflare', '  #CloudFlare  '],
          },
        ],
      },
      NO_SOURCES,
      NO_SOURCE_TAGS,
      ['cloudflare'],
    );
    expect(out[0]?.tags).toEqual(['cloudflare']);
  });

  it('REQ-GEN-005: falls back to source_tags when LLM returns no valid tags', () => {
    const sourceTags = new Map<string, string[]>([
      ['https://example.com/y', ['generative-ai', 'mcp']],
    ]);
    const out = sanitizeArticles(
      {
        articles: [
          {
            title: 'Fallback',
            url: 'https://example.com/y',
            one_liner: 'one-liner',
            details: ['a', 'b', 'c'],
            tags: ['unicorns', 'rainbows'],
          },
        ],
      },
      NO_SOURCES,
      sourceTags,
      ['generative-ai', 'mcp'],
    );
    expect(out[0]?.tags).toEqual(['generative-ai', 'mcp']);
  });

  it('REQ-GEN-005: tags [] when neither LLM nor source_tags yield a match', () => {
    const out = sanitizeArticles(
      {
        articles: [
          {
            title: 'Untagged',
            url: 'https://example.com/z',
            one_liner: 'one-liner',
            details: ['a', 'b', 'c'],
            // No tags from LLM, no source_tags entry, no user hashtags.
          },
        ],
      },
      NO_SOURCES,
      NO_SOURCE_TAGS,
      [],
    );
    expect(out[0]?.tags).toEqual([]);
  });
});
