// Regression test: when an RSS item carries a `<source>` element,
// the headline's source_name uses the per-item publisher rather than
// the feed-level adapter name. This is critical for Google News
// auto-synth feeds (REQ-PIPE-001 AC 9) where the feed-level name is
// "Google News: <tag>" — without the per-item override, every article
// from the GN feed would carry the same generic label and the
// alt-source picker on the article-detail page would show two rows
// labelled identically that link to different publishers.

import { describe, it, expect } from 'vitest';
import { adaptersForDiscoveredFeeds } from '~/lib/sources';

function gnExtractor() {
  const adapters = adaptersForDiscoveredFeeds(
    [{ name: 'Google News: mcp', url: 'https://news.google.com/rss/search?q=mcp', kind: 'rss' }],
    { trusted: true },
  );
  const a = adapters[0];
  if (a === undefined) throw new Error('synthetic GN adapter not built');
  return a.extract;
}

describe('RSS per-item <source> override', () => {
  const extract = gnExtractor();

  it('uses per-item <source> publisher when fxp emits a string', () => {
    const parsed = {
      rss: {
        channel: {
          item: {
            title: 'One in four MCP servers expose code execution risk',
            link: 'https://news.google.com/articles/CCAi-helpnetsec',
            pubDate: 'Mon, 05 May 2026 04:30:00 GMT',
            // fxp without attribute-aware parsing emits a bare string.
            source: 'Help Net Security',
          },
        },
      },
    };
    const [head] = extract(parsed);
    expect(head).toBeDefined();
    expect(head?.source_name).toBe('Help Net Security');
  });

  it('uses per-item <source> publisher when fxp emits an object with #text + url attribute', () => {
    const parsed = {
      rss: {
        channel: {
          item: {
            title: 'Security audit finds RCE risks in 6.2% of MCP servers',
            link: 'https://news.google.com/articles/CCAi-hackernoon',
            pubDate: 'Mon, 05 May 2026 04:30:00 GMT',
            source: { '#text': 'HackerNoon', url: 'https://hackernoon.com/' },
          },
        },
      },
    };
    const [head] = extract(parsed);
    expect(head?.source_name).toBe('HackerNoon');
  });

  it('falls back to the feed-level adapter name when <source> is absent', () => {
    const parsed = {
      rss: {
        channel: {
          item: {
            title: 'A feed without per-item source',
            link: 'https://example.com/no-source',
            pubDate: 'Mon, 05 May 2026 04:30:00 GMT',
          },
        },
      },
    };
    const [head] = extract(parsed);
    expect(head?.source_name).toBe('Google News: mcp');
  });

  it('falls back to feed-level name when <source> is empty string', () => {
    const parsed = {
      rss: {
        channel: {
          item: {
            title: 'Empty source',
            link: 'https://example.com/empty-src',
            pubDate: 'Mon, 05 May 2026 04:30:00 GMT',
            source: '   ',
          },
        },
      },
    };
    const [head] = extract(parsed);
    expect(head?.source_name).toBe('Google News: mcp');
  });

  it('two GN-feed items with different <source> values yield two distinct source_names (the bug fix)', () => {
    const parsed = {
      rss: {
        channel: {
          item: [
            {
              title: 'First story from publisher A',
              link: 'https://news.google.com/articles/aaa',
              pubDate: 'Mon, 05 May 2026 04:30:00 GMT',
              source: 'Help Net Security',
            },
            {
              title: 'Second story from publisher B',
              link: 'https://news.google.com/articles/bbb',
              pubDate: 'Mon, 05 May 2026 04:30:00 GMT',
              source: 'HackerNoon',
            },
          ],
        },
      },
    };
    const heads = extract(parsed);
    expect(heads).toHaveLength(2);
    expect(heads.map((h) => h.source_name)).toEqual(['Help Net Security', 'HackerNoon']);
  });
});
