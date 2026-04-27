// Tests for src/lib/slug.ts — REQ-PIPE-002 (slug derivation for articles/digests).
import { describe, it, expect } from 'vitest';
import { slugify } from '../../src/lib/slug';

describe('slugify', () => {
  it('REQ-PIPE-002: slug is lowercase', () => {
    expect(slugify('Hello World')).toBe('hello-world');
    expect(slugify('MIXED Case Title')).toBe('mixed-case-title');
  });

  it('REQ-PIPE-002: slug replaces non-alphanumeric runs with a single hyphen', () => {
    expect(slugify('foo   bar')).toBe('foo-bar');
    expect(slugify('a & b & c')).toBe('a-b-c');
    expect(slugify('hello, world!')).toBe('hello-world');
    expect(slugify('under_score')).toBe('under-score');
  });

  it('REQ-PIPE-002: slug trims leading and trailing hyphens', () => {
    expect(slugify('---leading')).toBe('leading');
    expect(slugify('trailing---')).toBe('trailing');
    expect(slugify('!!!both!!!')).toBe('both');
  });

  it('REQ-PIPE-002: slug preserves digits', () => {
    expect(slugify('Top 10 Stories of 2026')).toBe('top-10-stories-of-2026');
  });

  it('REQ-PIPE-002: slug strips non-ASCII characters', () => {
    // Diacritics, emoji, and other non-[a-z0-9] characters collapse to hyphens.
    expect(slugify('Café résumé')).toBe('caf-r-sum');
    expect(slugify('naïve idea')).toBe('na-ve-idea');
    expect(slugify('hello world')).toBe('hello-world');
  });

  it('REQ-PIPE-002: slug truncates to 60 characters', () => {
    const longTitle = 'a'.repeat(100);
    const slug = slugify(longTitle);
    expect(slug.length).toBeLessThanOrEqual(60);
  });

  it('REQ-PIPE-002: slug truncation does not leave a trailing hyphen', () => {
    // Title engineered so that character 60 lands on a non-alnum run.
    const title = 'a'.repeat(59) + ' extra tail';
    const slug = slugify(title);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('REQ-PIPE-002: empty or all-punctuation input returns empty string', () => {
    expect(slugify('')).toBe('');
    expect(slugify('!!!')).toBe('');
    expect(slugify('   ')).toBe('');
  });
});
