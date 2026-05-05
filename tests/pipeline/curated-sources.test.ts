// Tests for src/lib/curated-sources.ts — REQ-PIPE-004.
//
// The registry is the pipeline's single source of what to fetch every
// hour. These invariants guard against silent drift:
//   - size floor so we keep candidate pool diversity
//   - tag coverage so every default hashtag returns at least some news
//   - feed_url / kind shape so the coordinator's parser-dispatch never
//     sees a surprise value
//   - unique slugs so cache keys and log fields stay collision-free

import { describe, it, expect } from 'vitest';
import {
  CURATED_SOURCES,
  googleNewsSourceForTag,
  hasCuratedGoogleNews,
} from '~/lib/curated-sources';
import { DEFAULT_HASHTAGS } from '~/lib/default-hashtags';

describe('curated-sources — REQ-PIPE-004', () => {
  it('REQ-PIPE-004: registry has ≥50 entries', () => {
    expect(CURATED_SOURCES.length).toBeGreaterThanOrEqual(50);
  });

  it('REQ-PIPE-004: every DEFAULT_HASHTAGS tag has ≥1 source', () => {
    // Build a set of every tag that appears in any source's tags array,
    // then verify each default hashtag is a member. Any missing tag is
    // reported by name so the failure message is actionable.
    const covered = new Set<string>();
    for (const source of CURATED_SOURCES) {
      for (const tag of source.tags) {
        covered.add(tag);
      }
    }
    const missing = DEFAULT_HASHTAGS.filter((t) => !covered.has(t));
    expect(missing).toEqual([]);
  });

  it('REQ-PIPE-004: every source has ≥1 tag', () => {
    for (const source of CURATED_SOURCES) {
      expect(source.tags.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('REQ-PIPE-004: every feed_url is https', () => {
    for (const source of CURATED_SOURCES) {
      expect(source.feed_url.startsWith('https://')).toBe(true);
    }
  });

  it('REQ-PIPE-004: every kind is rss|atom|json', () => {
    const allowed = new Set(['rss', 'atom', 'json']);
    for (const source of CURATED_SOURCES) {
      expect(allowed.has(source.kind)).toBe(true);
    }
  });

  it('REQ-PIPE-004: every slug is unique', () => {
    const slugs = CURATED_SOURCES.map((s) => s.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it('REQ-PIPE-004: every slug is lowercase-kebab', () => {
    const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const source of CURATED_SOURCES) {
      expect(source.slug).toMatch(slugPattern);
    }
  });

  it('REQ-PIPE-004: every name is a non-empty trimmed string', () => {
    for (const source of CURATED_SOURCES) {
      expect(source.name.length).toBeGreaterThan(0);
      expect(source.name).toBe(source.name.trim());
    }
  });
});

describe('googleNewsSourceForTag — auto-synthesised per-tag GN feeds', () => {
  it('builds a Google News query-RSS source for an uncovered tag with dashes converted to spaces and URL-encoded', () => {
    const synth = googleNewsSourceForTag('supply-chain-security');
    expect(synth).not.toBeNull();
    expect(synth!.slug).toBe('google-news-auto-supply-chain-security');
    expect(synth!.name).toBe('Google News: supply-chain-security');
    expect(synth!.kind).toBe('rss');
    expect(synth!.tags).toEqual(['supply-chain-security']);
    // Dashes become spaces in the query, then URL-encoded as `+` or `%20`.
    expect(synth!.feed_url).toContain('q=supply%20chain%20security');
    expect(synth!.feed_url.startsWith('https://news.google.com/rss/search?')).toBe(true);
  });

  it('returns null for tags already served by a bespoke `google-news-*` curated entry', () => {
    // anthropic-ish tags are covered by `google-news-anthropic` (tags:
    // ['ai-agents','generative-ai']). pqc by `google-news-pqc`.
    expect(googleNewsSourceForTag('ai-agents')).toBeNull();
    expect(googleNewsSourceForTag('generative-ai')).toBeNull();
    expect(googleNewsSourceForTag('pqc')).toBeNull();
    expect(googleNewsSourceForTag('coding-agents')).toBeNull();
    expect(googleNewsSourceForTag('openziti')).toBeNull();
  });

  it('returns null for empty / malformed tag input (defence against KV corruption)', () => {
    expect(googleNewsSourceForTag('')).toBeNull();
    expect(googleNewsSourceForTag('Has Spaces')).toBeNull();
    expect(googleNewsSourceForTag('UPPERCASE')).toBeNull();
    expect(googleNewsSourceForTag('with/slash')).toBeNull();
    expect(googleNewsSourceForTag('quote"injection')).toBeNull();
  });

  it('hasCuratedGoogleNews mirrors the bespoke `google-news-*` tag set derived from CURATED_SOURCES', () => {
    // Derive ground truth from the same registry the production helper
    // reads — fails if a future curated entry adds GN coverage for a
    // new tag without the helper picking it up.
    const expected = new Set(
      CURATED_SOURCES
        .filter((s) => s.slug.startsWith('google-news-'))
        .flatMap((s) => s.tags),
    );
    for (const tag of expected) {
      expect(hasCuratedGoogleNews(tag)).toBe(true);
    }
    // Every DEFAULT tag NOT in `expected` must NOT be flagged as covered.
    for (const tag of DEFAULT_HASHTAGS) {
      if (!expected.has(tag)) {
        expect(hasCuratedGoogleNews(tag)).toBe(false);
      }
    }
  });

  it('every DEFAULT_HASHTAGS tag is either bespoke-GN-covered OR auto-synthesisable (no tag falls through both)', () => {
    for (const tag of DEFAULT_HASHTAGS) {
      const covered = hasCuratedGoogleNews(tag);
      const synth = googleNewsSourceForTag(tag);
      // Exactly one of: covered by bespoke entry, OR a synth source builds.
      expect(covered === (synth === null)).toBe(true);
    }
  });
});
