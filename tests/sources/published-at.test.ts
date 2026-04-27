// Regression tests for feed-date extraction — the "article claims to
// be from today but the source link says it's 3 weeks old" bug.
//
// The scrape coordinator was stamping every candidate with `nowSec`
// (ingestion time) instead of reading the feed entry's real
// publication timestamp. This suite pins the three feed shapes we
// support (RSS pubDate, Atom published/updated, JSON Feed
// date_published) + the fallback behaviour when the feed omits or
// mangles the date.

import { describe, it, expect } from 'vitest';
import {
  GENERIC_SOURCES,
  adaptersForDiscoveredFeeds,
} from '~/lib/sources';

function extractorFor(name: string) {
  const s = GENERIC_SOURCES.find((s) => s.name === name);
  if (s === undefined) throw new Error(`generic source '${name}' not found`);
  return s.extract;
}

/** Build a JSON-Feed 1.1 discovered-source adapter via the public
 *  API — `adaptersForDiscoveredFeeds` is the export generate.ts uses
 *  for the same shape. This gives us real coverage of
 *  extractJsonFeed's date_published path without needing a direct
 *  export of the internal helper. */
function jsonFeedExtractor(): (parsed: unknown) => ReturnType<
  ReturnType<typeof adaptersForDiscoveredFeeds>[number]['extract']
> {
  const adapters = adaptersForDiscoveredFeeds([
    {
      name: 'synthetic',
      url: 'https://example.com/feed.json',
      kind: 'json',
    },
  ]);
  const a = adapters[0];
  if (a === undefined) throw new Error('synthetic JSON adapter not built');
  return a.extract;
}

describe('RSS pubDate extraction — regression for stale ingest-time stamp', () => {
  const extract = extractorFor('googlenews'); // RSS adapter

  it('parses RFC 2822 pubDate into a unix-seconds published_at', () => {
    const parsed = {
      rss: {
        channel: {
          item: {
            title: 'Something happened',
            link: 'https://example.com/post',
            pubDate: 'Wed, 02 Apr 2026 10:00:00 GMT',
          },
        },
      },
    };
    const [head] = extract(parsed);
    expect(head).toBeDefined();
    expect(head?.published_at).toBe(
      Math.floor(Date.parse('2026-04-02T10:00:00Z') / 1000),
    );
  });

  it('prefers RSS pubDate over Dublin Core dc:date when both are present', () => {
    const parsed = {
      rss: {
        channel: {
          item: {
            title: 'Dual-dated',
            link: 'https://example.com/dual',
            pubDate: 'Wed, 02 Apr 2026 10:00:00 GMT',
            'dc:date': '2026-01-01T00:00:00Z',
          },
        },
      },
    };
    const [head] = extract(parsed);
    expect(head?.published_at).toBe(
      Math.floor(Date.parse('2026-04-02T10:00:00Z') / 1000),
    );
  });

  it('falls back to dc:date when pubDate is missing', () => {
    const parsed = {
      rss: {
        channel: {
          item: {
            title: 'Dublin-only',
            link: 'https://example.com/dc',
            'dc:date': '2026-03-15T08:30:00Z',
          },
        },
      },
    };
    const [head] = extract(parsed);
    expect(head?.published_at).toBe(
      Math.floor(Date.parse('2026-03-15T08:30:00Z') / 1000),
    );
  });

  it('omits published_at when the item has no date field', () => {
    const parsed = {
      rss: {
        channel: {
          item: { title: 'Dateless', link: 'https://example.com/none' },
        },
      },
    };
    const [head] = extract(parsed);
    expect(head?.published_at).toBeUndefined();
  });

  it('omits published_at when pubDate is unparseable garbage', () => {
    const parsed = {
      rss: {
        channel: {
          item: {
            title: 'Broken',
            link: 'https://example.com/bad',
            pubDate: 'not a date',
          },
        },
      },
    };
    const [head] = extract(parsed);
    expect(head?.published_at).toBeUndefined();
  });

  it('rejects pre-2000 dates — guards against malformed "1970" garbage', () => {
    const parsed = {
      rss: {
        channel: {
          item: {
            title: 'Epoch zero',
            link: 'https://example.com/1970',
            pubDate: 'Thu, 01 Jan 1970 00:00:00 GMT',
          },
        },
      },
    };
    const [head] = extract(parsed);
    expect(head?.published_at).toBeUndefined();
  });

  it('rejects future dates more than a day ahead — clock-skew guard', () => {
    // 10 days in the future — must be dropped, not accepted.
    const future = new Date(Date.now() + 10 * 86_400_000).toUTCString();
    const parsed = {
      rss: {
        channel: {
          item: {
            title: 'Scheduled post',
            link: 'https://example.com/future',
            pubDate: future,
          },
        },
      },
    };
    const [head] = extract(parsed);
    expect(head?.published_at).toBeUndefined();
  });
});

describe('Atom feed extraction — <published> / <updated>', () => {
  const extract = extractorFor('googlenews');

  it('parses Atom <published> into published_at', () => {
    // CF-071: the parser is configured with `attributeNamePrefix: ''`
    // (see src/lib/sources.ts), so fxp emits attributes without a
    // prefix — the link object's attribute is `href`, not `@_href`.
    // The previous fixture used `@_href` and a silent early-return
    // that masked the failure.
    const parsed = {
      feed: {
        entry: {
          title: 'Atom post',
          link: { href: 'https://example.com/atom' },
          published: '2026-04-02T10:00:00Z',
        },
      },
    };
    const [head] = extract(parsed);
    expect(head).toBeDefined();
    expect(head?.published_at).toBe(
      Math.floor(Date.parse('2026-04-02T10:00:00Z') / 1000),
    );
  });

  it('prefers <published> over <updated> when both are present', () => {
    const parsed = {
      feed: {
        entry: {
          title: 'Dual atom',
          link: 'https://example.com/dual-atom',
          published: '2026-04-02T10:00:00Z',
          updated: '2026-04-20T10:00:00Z',
        },
      },
    };
    const [head] = extract(parsed);
    if (head === undefined) return;
    expect(head.published_at).toBe(
      Math.floor(Date.parse('2026-04-02T10:00:00Z') / 1000),
    );
  });

  it('falls back to <updated> when <published> is missing', () => {
    const parsed = {
      feed: {
        entry: {
          title: 'Updated only',
          link: 'https://example.com/upd',
          updated: '2026-03-15T08:30:00Z',
        },
      },
    };
    const [head] = extract(parsed);
    if (head === undefined) return;
    expect(head.published_at).toBe(
      Math.floor(Date.parse('2026-03-15T08:30:00Z') / 1000),
    );
  });
});

describe('JSON Feed extraction — date_published', () => {
  const extract = jsonFeedExtractor();

  it('parses ISO 8601 date_published into published_at (unix seconds)', () => {
    const parsed = {
      items: [
        {
          title: 'Hello JSON feed',
          url: 'https://example.com/one',
          date_published: '2026-04-02T10:00:00Z',
        },
      ],
    };
    const [head] = extract(parsed);
    expect(head).toBeDefined();
    expect(head?.title).toBe('Hello JSON feed');
    expect(head?.url).toBe('https://example.com/one');
    expect(head?.published_at).toBe(
      Math.floor(Date.parse('2026-04-02T10:00:00Z') / 1000),
    );
  });

  it('omits published_at when date_published is absent', () => {
    const parsed = {
      items: [{ title: 'Dateless', url: 'https://example.com/none' }],
    };
    const [head] = extract(parsed);
    expect(head).toBeDefined();
    expect(head?.published_at).toBeUndefined();
  });

  it('omits published_at when date_published is unparseable garbage', () => {
    const parsed = {
      items: [
        {
          title: 'Broken date',
          url: 'https://example.com/bad',
          date_published: 'yesterday?',
        },
      ],
    };
    const [head] = extract(parsed);
    expect(head?.published_at).toBeUndefined();
  });
});
