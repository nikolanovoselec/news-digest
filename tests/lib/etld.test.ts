// Tests for src/lib/etld.ts — REQ-PIPE-003 same-vendor recognition.

import { describe, it, expect } from 'vitest';
import { etldPlusOne, sameVendor } from '~/lib/etld';

describe('etldPlusOne', () => {
  it('returns registrable domain for two-label hosts', () => {
    expect(etldPlusOne('workos.com')).toBe('workos.com');
    expect(etldPlusOne('openai.com')).toBe('openai.com');
  });

  it('strips subdomains for three-label hosts', () => {
    expect(etldPlusOne('cloud.google.com')).toBe('google.com');
    expect(etldPlusOne('blog.workos.com')).toBe('workos.com');
    expect(etldPlusOne('news.google.com')).toBe('google.com');
  });

  it('handles two-level country TLDs', () => {
    expect(etldPlusOne('bbc.co.uk')).toBe('bbc.co.uk');
    expect(etldPlusOne('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(etldPlusOne('example.com.au')).toBe('example.com.au');
  });

  it('lowercases the result', () => {
    expect(etldPlusOne('WorkOS.COM')).toBe('workos.com');
    expect(etldPlusOne('Cloud.Google.com')).toBe('google.com');
  });

  it('returns IPv4 untouched', () => {
    expect(etldPlusOne('127.0.0.1')).toBe('127.0.0.1');
    expect(etldPlusOne('192.168.1.10')).toBe('192.168.1.10');
  });

  it('returns IPv6 untouched', () => {
    expect(etldPlusOne('::1')).toBe('::1');
    expect(etldPlusOne('2001:db8::1')).toBe('2001:db8::1');
  });

  it('handles edge inputs gracefully', () => {
    expect(etldPlusOne('')).toBe('');
    expect(etldPlusOne('localhost')).toBe('localhost');
  });
});

describe('sameVendor', () => {
  it('returns true for same eTLD+1 across publisher subdomains', () => {
    expect(
      sameVendor(
        'https://blog.workos.com/best-mcp-server',
        'https://workos.com/blog/another',
      ),
    ).toBe(true);
    expect(
      sameVendor(
        'https://cloud.google.com/blog/foo',
        'https://research.google.com/papers/bar',
      ),
    ).toBe(true);
  });

  it('returns true for identical hosts', () => {
    expect(
      sameVendor(
        'https://openai.com/index/gpt-5-5-instant',
        'https://openai.com/index/gpt-5-5-instant-system-card',
      ),
    ).toBe(true);
  });

  it('returns false for different eTLD+1', () => {
    expect(
      sameVendor(
        'https://thehackernews.com/2026/05/muddywater.html',
        'https://www.theregister.com/security/2026/05/06/iran-cyberspies',
      ),
    ).toBe(false);
    expect(
      sameVendor(
        'https://crowdstrike.com/blog/foo',
        'https://cloud.google.com/blog/bar',
      ),
    ).toBe(false);
  });

  it('returns false when EITHER URL is on news.google.com (aggregator)', () => {
    // news.google.com wraps redirect URLs to many distinct publishers
    // — applying the same-vendor cosine penalty between two GN
    // redirect URLs missed the 2026-05-07 Palo Alto duplicate cluster
    // (cosine 0.83 dropped to 0.78, on the auto-merge edge under the
    // pre-2026-05-07 threshold of 0.85; even after the threshold drop
    // to 0.78, treating GN-vs-GN as same-vendor would still wrongly
    // penalise legitimate cross-publisher pairs that both arrived via
    // the GN redirect).
    expect(
      sameVendor(
        'https://news.google.com/rss/articles/CBMi-aaa',
        'https://news.google.com/rss/articles/CBMi-bbb',
      ),
    ).toBe(false);
    // Cross-pairs with a real publisher on the other side are also
    // safe to leave as different vendors — the GN side carries no
    // identity signal at the URL level.
    expect(
      sameVendor(
        'https://news.google.com/rss/articles/CBMi-aaa',
        'https://cloud.google.com/blog/foo',
      ),
    ).toBe(false);
  });

  it('returns false for malformed URLs', () => {
    expect(sameVendor('not-a-url', 'https://example.com')).toBe(false);
    expect(sameVendor('https://example.com', '')).toBe(false);
  });
});
