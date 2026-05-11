// Implements REQ-PIPE-001
//
// Verifies the publisher blocklist drops the exact set of off-topic
// publishers seen in production (Palo Alto stock-pump cluster May 6-10
// 2026) while preserving curated tech-news sources. Both signals are
// exercised: direct-URL host match AND RSS-source-name match for items
// routed through the Google News redirect envelope.

import { describe, it, expect } from 'vitest';
import {
  isBlockedPublisher,
  filterBlockedPublishers,
  BLOCKED_HOSTS,
  BLOCKED_NAME_TOKENS,
} from '~/lib/blocked-publishers';
import type { Headline } from '~/lib/types';

const mkHeadline = (overrides: Partial<Headline>): Headline => ({
  title: 't',
  url: 'https://example.com/x',
  source_name: 'Example',
  ...overrides,
});

describe('blocked-publishers — direct URL host match', () => {
  it('blocks tradingview.com', () => {
    expect(
      isBlockedPublisher(
        mkHeadline({ url: 'https://www.tradingview.com/news/abc' }),
      ),
    ).toBe(true);
  });

  it('blocks finance.yahoo.com via the yahoo.com suffix', () => {
    expect(
      isBlockedPublisher(
        mkHeadline({ url: 'https://finance.yahoo.com/news/palo-alto' }),
      ),
    ).toBe(true);
  });

  it('blocks subdomains of msn.com', () => {
    expect(
      isBlockedPublisher(mkHeadline({ url: 'https://www.msn.com/money/x' })),
    ).toBe(true);
  });

  it('blocks seekingalpha.com', () => {
    expect(
      isBlockedPublisher(
        mkHeadline({ url: 'https://seekingalpha.com/article/123' }),
      ),
    ).toBe(true);
  });

  it('does not block a curated tech source', () => {
    expect(
      isBlockedPublisher(
        mkHeadline({
          url: 'https://blog.cloudflare.com/post/x',
          source_name: 'Cloudflare Blog',
        }),
      ),
    ).toBe(false);
  });

  it('does not block techcrunch.com (mainstream tech, kept)', () => {
    expect(
      isBlockedPublisher(
        mkHeadline({
          url: 'https://techcrunch.com/2026/05/10/x',
          source_name: 'TechCrunch',
        }),
      ),
    ).toBe(false);
  });

  it('returns false on malformed URL (defensive)', () => {
    expect(
      isBlockedPublisher(
        mkHeadline({ url: 'not a url at all', source_name: 'OK Publisher' }),
      ),
    ).toBe(false);
  });
});

describe('blocked-publishers — RSS source-name match (Google News redirect case)', () => {
  // These exercise the production case: headline.url is still the
  // Google News redirect envelope, but the RSS `<source>` text revealed
  // the real publisher in headline.source_name.
  const GN = 'https://news.google.com/rss/articles/CBMiX_fakeRedirectToken';

  it('blocks Google-News-routed TradingView article', () => {
    expect(
      isBlockedPublisher(
        mkHeadline({ url: GN, source_name: 'TradingView' }),
      ),
    ).toBe(true);
  });

  it('blocks Google-News-routed Yahoo Finance article', () => {
    expect(
      isBlockedPublisher(
        mkHeadline({ url: GN, source_name: 'Yahoo Finance' }),
      ),
    ).toBe(true);
  });

  it('blocks Google-News-routed MSN article', () => {
    expect(
      isBlockedPublisher(
        mkHeadline({ url: GN, source_name: 'MSN' }),
      ),
    ).toBe(true);
  });

  it('blocks despite trailing publisher suffix ("Yahoo! Finance")', () => {
    expect(
      isBlockedPublisher(
        mkHeadline({ url: GN, source_name: 'Yahoo! Finance' }),
      ),
    ).toBe(true);
  });

  it('keeps Google-News-routed Reuters/legit publishers (only blocklisted ones drop)', () => {
    expect(
      isBlockedPublisher(
        mkHeadline({ url: GN, source_name: 'The Hacker News' }),
      ),
    ).toBe(false);
  });

  it('case-insensitive name match', () => {
    expect(
      isBlockedPublisher(
        mkHeadline({ url: GN, source_name: 'TRADINGVIEW NEWS' }),
      ),
    ).toBe(true);
  });

  it('does NOT block on accidental substring of "msn" (word-boundary match)', () => {
    // Guards against the 3-letter "msn" token false-positiving on
    // unrelated publishers. The token must match a whole word.
    expect(
      isBlockedPublisher(
        mkHeadline({ url: GN, source_name: 'Comsnet News' }),
      ),
    ).toBe(false);
    expect(
      isBlockedPublisher(
        mkHeadline({ url: GN, source_name: 'Amsnews Today' }),
      ),
    ).toBe(false);
  });

  it('does NOT block on accidental substring of "cnbc" inside an unrelated name', () => {
    expect(
      isBlockedPublisher(
        mkHeadline({ url: GN, source_name: 'Cnbcdesktop Software Review' }),
      ),
    ).toBe(false);
  });

  it('blocks "MSN" as a standalone token even with surrounding decoration', () => {
    // Whole-word matching still catches the real cases.
    expect(
      isBlockedPublisher(
        mkHeadline({ url: GN, source_name: 'MSN Money' }),
      ),
    ).toBe(true);
    expect(
      isBlockedPublisher(
        mkHeadline({ url: GN, source_name: '[MSN] Breaking' }),
      ),
    ).toBe(true);
  });
});

describe('blocked-publishers — filterBlockedPublishers', () => {
  it('drops blocked entries and preserves the rest in original order', () => {
    const input: Headline[] = [
      mkHeadline({
        url: 'https://blog.cloudflare.com/a',
        source_name: 'Cloudflare Blog',
      }),
      mkHeadline({
        url: 'https://news.google.com/rss/articles/CBMix',
        source_name: 'TradingView',
      }),
      mkHeadline({
        url: 'https://www.theregister.com/b',
        source_name: 'The Register',
      }),
      mkHeadline({
        url: 'https://finance.yahoo.com/c',
        source_name: 'Yahoo Finance',
      }),
    ];
    const out = filterBlockedPublishers(input);
    expect(out.map((h) => h.source_name)).toEqual([
      'Cloudflare Blog',
      'The Register',
    ]);
    // Input is not mutated.
    expect(input.length).toBe(4);
  });

  it('returns empty array when every input is blocked', () => {
    const input: Headline[] = [
      mkHeadline({ url: 'https://tradingview.com/a', source_name: 'TradingView' }),
      mkHeadline({ url: 'https://www.msn.com/b', source_name: 'MSN' }),
    ];
    expect(filterBlockedPublishers(input)).toEqual([]);
  });

  it('returns input unchanged when no entry is blocked', () => {
    const input: Headline[] = [
      mkHeadline({ url: 'https://blog.cloudflare.com/a', source_name: 'CF' }),
      mkHeadline({ url: 'https://techcrunch.com/b', source_name: 'TC' }),
    ];
    expect(filterBlockedPublishers(input).length).toBe(2);
  });
});

describe('blocked-publishers — registry sanity', () => {
  it('blocklist contains the production-observed offenders', () => {
    // Pinned from the May 6-10 2026 Palo Alto stock-pump cluster
    // (article IDs 01KQZW0VABZB5XJTQ6V6PA054X, 01KR3QHTZX..., …)
    expect(BLOCKED_HOSTS.has('tradingview.com')).toBe(true);
    expect(BLOCKED_HOSTS.has('finance.yahoo.com')).toBe(true);
    expect(BLOCKED_HOSTS.has('msn.com')).toBe(true);
    expect(BLOCKED_NAME_TOKENS.includes('tradingview')).toBe(true);
    expect(BLOCKED_NAME_TOKENS.includes('yahoo finance')).toBe(true);
    expect(BLOCKED_NAME_TOKENS.includes('msn')).toBe(true);
  });

  it('every host entry is lowercase (suffix-match correctness)', () => {
    for (const h of BLOCKED_HOSTS) {
      expect(h).toBe(h.toLowerCase());
    }
  });

  it('every name token is lowercase (case-insensitive matching pre-condition)', () => {
    for (const t of BLOCKED_NAME_TOKENS) {
      expect(t).toBe(t.toLowerCase());
    }
  });
});
