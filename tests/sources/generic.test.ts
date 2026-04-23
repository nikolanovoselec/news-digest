// Tests for src/lib/sources.ts GENERIC_SOURCES — REQ-GEN-003 (each
// adapter's url() formats correctly, extract() parses sample responses).

import { describe, it, expect } from 'vitest';
import { GENERIC_SOURCES } from '~/lib/sources';

function findSource(name: string) {
  const s = GENERIC_SOURCES.find((s) => s.name === name);
  if (s === undefined) {
    throw new Error(`generic source '${name}' not registered`);
  }
  return s;
}

describe('GENERIC_SOURCES', () => {
  it('REQ-GEN-003: registers exactly three generic sources', () => {
    expect(GENERIC_SOURCES).toHaveLength(3);
    const names = GENERIC_SOURCES.map((s) => s.name).sort();
    expect(names).toEqual(['googlenews', 'hackernews', 'reddit']);
  });

  describe('hackernews adapter', () => {
    const hn = findSource('hackernews');

    it('REQ-GEN-003: url() targets HN Algolia search_by_date with hitsPerPage=30', () => {
      const url = hn.url('cloudflare');
      expect(url).toBe(
        'https://hn.algolia.com/api/v1/search_by_date?query=cloudflare&tags=story&hitsPerPage=30',
      );
    });

    it('REQ-GEN-003: url() percent-encodes the tag', () => {
      const url = hn.url('c++');
      expect(url).toContain('query=c%2B%2B');
    });

    it('REQ-GEN-003: kind is json', () => {
      expect(hn.kind).toBe('json');
    });

    it('REQ-GEN-003: does not set a User-Agent header (HN allows any)', () => {
      expect(hn.headers).toBeUndefined();
    });

    it('REQ-GEN-003: extract() pulls title+url from Algolia hits', () => {
      const sample = {
        hits: [
          {
            title: 'Workers AI launch',
            url: 'https://blog.cloudflare.com/workers-ai',
            objectID: '111',
          },
          {
            // story_title fallback path (used by Show HN / Ask HN entries)
            story_title: 'Ask HN: Favourite editor?',
            url: null,
            objectID: '222',
          },
          {
            // Drop entirely when no title is present.
            url: 'https://example.com/no-title',
            objectID: '333',
          },
        ],
      };
      const out = hn.extract(sample);
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({
        title: 'Workers AI launch',
        url: 'https://blog.cloudflare.com/workers-ai',
        source_name: 'hackernews',
      });
      expect(out[1]).toEqual({
        title: 'Ask HN: Favourite editor?',
        url: 'https://news.ycombinator.com/item?id=222',
        source_name: 'hackernews',
      });
    });

    it('REQ-GEN-003: extract() returns [] for malformed payload', () => {
      expect(hn.extract(null)).toEqual([]);
      expect(hn.extract({})).toEqual([]);
      expect(hn.extract({ hits: 'not an array' })).toEqual([]);
    });
  });

  describe('googlenews adapter', () => {
    const gn = findSource('googlenews');

    it('REQ-GEN-003: url() targets news.google.com/rss/search with when:1d filter', () => {
      const url = gn.url('typescript');
      expect(url).toBe(
        'https://news.google.com/rss/search?q=typescript+when%3A1d&hl=en-US&gl=US&ceid=US:en',
      );
    });

    it('REQ-GEN-003: kind is rss', () => {
      expect(gn.kind).toBe('rss');
    });

    it('REQ-GEN-003: extract() parses RSS <item><title>+<link> pairs', () => {
      // Fed the same shape fast-xml-parser produces for RSS 2.0.
      const parsed = {
        rss: {
          channel: {
            item: [
              {
                title: 'TypeScript 6 lands',
                link: 'https://example.com/ts6',
                pubDate: 'Tue, 22 Apr 2026 10:00:00 GMT',
              },
              {
                title: 'Article two',
                link: 'https://example.com/two',
              },
            ],
          },
        },
      };
      const out = gn.extract(parsed);
      expect(out).toHaveLength(2);
      // Assert field-by-field instead of toEqual so future shape
      // additions (published_at, source_tags, etc.) don't require
      // touching this test — the contract it pins is "title + url +
      // source_name survive the extraction."
      expect(out[0]).toMatchObject({
        title: 'TypeScript 6 lands',
        url: 'https://example.com/ts6',
        source_name: 'googlenews',
      });
      // Regression guard for the "every article stamped today" bug:
      // the extractor must thread the feed's <pubDate> through to
      // the Headline so the coordinator doesn't fall back to nowSec.
      expect(out[0]?.published_at).toBe(
        Math.floor(Date.parse('2026-04-22T10:00:00Z') / 1000),
      );
      expect(out[1]).toMatchObject({
        title: 'Article two',
        url: 'https://example.com/two',
        source_name: 'googlenews',
      });
      // Second item omitted pubDate → no published_at field — the
      // coordinator's `?? nowSec` fallback kicks in.
      expect(out[1]?.published_at).toBeUndefined();
    });

    it('REQ-GEN-003: extract() handles a single <item> (non-array shape from fxp)', () => {
      const parsed = {
        rss: {
          channel: {
            item: { title: 'Only one', link: 'https://example.com/one' },
          },
        },
      };
      const out = gn.extract(parsed);
      expect(out).toHaveLength(1);
      expect(out[0]?.title).toBe('Only one');
    });

    it('REQ-GEN-003: extract() drops items missing title or link', () => {
      const parsed = {
        rss: {
          channel: {
            item: [
              { title: 'Has title, no link' },
              { link: 'https://example.com/no-title' },
              { title: 'Good', link: 'https://example.com/good' },
            ],
          },
        },
      };
      const out = gn.extract(parsed);
      expect(out).toHaveLength(1);
      expect(out[0]?.title).toBe('Good');
    });

    it('REQ-GEN-003: extract() returns [] when channel is missing', () => {
      expect(gn.extract({})).toEqual([]);
      expect(gn.extract({ rss: {} })).toEqual([]);
      expect(gn.extract(null)).toEqual([]);
    });
  });

  describe('reddit adapter', () => {
    const rd = findSource('reddit');

    it('REQ-GEN-003: url() targets reddit search.json with t=day, sort=top, limit=25', () => {
      const url = rd.url('mcp');
      expect(url).toBe(
        'https://www.reddit.com/search.json?q=mcp&t=day&sort=top&limit=25',
      );
    });

    it('REQ-GEN-003: sends User-Agent: news-digest/1.0 (Reddit requires UA)', () => {
      expect(rd.headers).toEqual({ 'User-Agent': 'news-digest/1.0' });
    });

    it('REQ-GEN-003: kind is json', () => {
      expect(rd.kind).toBe('json');
    });

    it('REQ-GEN-003: extract() pulls title+url from data.children[].data', () => {
      const sample = {
        data: {
          children: [
            {
              data: {
                title: 'External link post',
                url: 'https://example.com/story',
                permalink: '/r/tech/comments/xxx/external_link_post/',
              },
            },
            {
              data: {
                // self-post edge case: Reddit sometimes returns a bare
                // relative path. We fall back to prepending reddit.com to
                // the permalink so the entry is still usable.
                title: 'Self-post thread',
                url: '/r/tech/comments/yyy/self_post_thread/',
                permalink: '/r/tech/comments/yyy/self_post_thread/',
              },
            },
            {
              data: {
                // missing title — dropped
                url: 'https://example.com/no-title',
              },
            },
          ],
        },
      };
      const out = rd.extract(sample);
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({
        title: 'External link post',
        url: 'https://example.com/story',
        source_name: 'reddit',
      });
      expect(out[1]).toEqual({
        title: 'Self-post thread',
        url: 'https://www.reddit.com/r/tech/comments/yyy/self_post_thread/',
        source_name: 'reddit',
      });
    });

    it('REQ-GEN-003: extract() returns [] on an error payload', () => {
      expect(rd.extract({ error: 429, message: 'Too Many Requests' })).toEqual([]);
      expect(rd.extract(null)).toEqual([]);
    });
  });
});
