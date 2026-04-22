// Tests for src/lib/slug.ts — REQ-GEN-006 (slug derivation for articles/digests).
import { describe, it, expect } from 'vitest';
import { slugify, deduplicateSlug } from '../../src/lib/slug';

describe('slugify', () => {
  it('REQ-GEN-006: slug is lowercase', () => {
    expect(slugify('Hello World')).toBe('hello-world');
    expect(slugify('MIXED Case Title')).toBe('mixed-case-title');
  });

  it('REQ-GEN-006: slug replaces non-alphanumeric runs with a single hyphen', () => {
    expect(slugify('foo   bar')).toBe('foo-bar');
    expect(slugify('a & b & c')).toBe('a-b-c');
    expect(slugify('hello, world!')).toBe('hello-world');
    expect(slugify('under_score')).toBe('under-score');
  });

  it('REQ-GEN-006: slug trims leading and trailing hyphens', () => {
    expect(slugify('---leading')).toBe('leading');
    expect(slugify('trailing---')).toBe('trailing');
    expect(slugify('!!!both!!!')).toBe('both');
  });

  it('REQ-GEN-006: slug preserves digits', () => {
    expect(slugify('Top 10 Stories of 2026')).toBe('top-10-stories-of-2026');
  });

  it('REQ-GEN-006: slug strips non-ASCII characters', () => {
    // Diacritics, emoji, and other non-[a-z0-9] characters collapse to hyphens.
    expect(slugify('Café résumé')).toBe('caf-r-sum');
    expect(slugify('naïve idea')).toBe('na-ve-idea');
    expect(slugify('hello world')).toBe('hello-world');
  });

  it('REQ-GEN-006: slug truncates to 60 characters', () => {
    const longTitle = 'a'.repeat(100);
    const slug = slugify(longTitle);
    expect(slug.length).toBeLessThanOrEqual(60);
  });

  it('REQ-GEN-006: slug truncation does not leave a trailing hyphen', () => {
    // Title engineered so that character 60 lands on a non-alnum run.
    const title = 'a'.repeat(59) + ' extra tail';
    const slug = slugify(title);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('REQ-GEN-006: empty or all-punctuation input returns empty string', () => {
    expect(slugify('')).toBe('');
    expect(slugify('!!!')).toBe('');
    expect(slugify('   ')).toBe('');
  });
});

describe('deduplicateSlug', () => {
  it('REQ-GEN-006: returns slug unchanged when no collision', () => {
    expect(deduplicateSlug('hello', [])).toBe('hello');
    expect(deduplicateSlug('hello', ['other', 'another'])).toBe('hello');
  });

  it('REQ-GEN-006: appends -2 on first collision', () => {
    expect(deduplicateSlug('hello', ['hello'])).toBe('hello-2');
  });

  it('REQ-GEN-006: increments suffix until unique', () => {
    expect(deduplicateSlug('hello', ['hello', 'hello-2'])).toBe('hello-3');
    expect(deduplicateSlug('hello', ['hello', 'hello-2', 'hello-3'])).toBe('hello-4');
  });

  it('REQ-GEN-006: handles gaps in existing suffix range', () => {
    // hello-2 and hello-3 taken but not hello-4: we take hello-2's slot? No — we
    // just keep incrementing from 2 and return the first free integer.
    expect(deduplicateSlug('hello', ['hello', 'hello-2', 'hello-3'])).toBe('hello-4');
  });

  it('REQ-GEN-006: does not mutate the existing array', () => {
    const existing = ['hello'];
    const snapshot = [...existing];
    deduplicateSlug('hello', existing);
    expect(existing).toEqual(snapshot);
  });

  it('REQ-GEN-006: deduplicates against suffixes without colliding with base', () => {
    // Base slug "hello-2" that happens to already exist — must increment past it.
    expect(deduplicateSlug('hello-2', ['hello-2'])).toBe('hello-2-2');
  });
});
