// Tests for src/lib/canonical-url.ts — REQ-GEN-004 (URL canonicalization and dedupe).
import { describe, it, expect } from 'vitest';
import { canonicalize } from '~/lib/canonical-url';

describe('canonicalize', () => {
  describe('scheme upgrade', () => {
    it('REQ-GEN-004: upgrades http:// to https://', () => {
      expect(canonicalize('http://example.com/path')).toBe('https://example.com/path');
    });

    it('REQ-GEN-004: upgrades arXiv http URLs to https', () => {
      expect(canonicalize('http://arxiv.org/abs/2401.12345')).toBe('https://arxiv.org/abs/2401.12345');
    });

    it('REQ-GEN-004: leaves https:// unchanged', () => {
      expect(canonicalize('https://example.com/path')).toBe('https://example.com/path');
    });
  });

  describe('tracking parameter stripping', () => {
    it('REQ-GEN-004: strips utm_* parameters', () => {
      expect(canonicalize('https://example.com/a?utm_source=twitter&utm_medium=social')).toBe(
        'https://example.com/a'
      );
      expect(canonicalize('https://example.com/a?utm_campaign=launch')).toBe('https://example.com/a');
    });

    it('REQ-GEN-004: strips fbclid', () => {
      expect(canonicalize('https://example.com/a?fbclid=abc123')).toBe('https://example.com/a');
    });

    it('REQ-GEN-004: strips gclid', () => {
      expect(canonicalize('https://example.com/a?gclid=xyz')).toBe('https://example.com/a');
    });

    it('REQ-GEN-004: strips ref and ref_src', () => {
      expect(canonicalize('https://example.com/a?ref=nav')).toBe('https://example.com/a');
      expect(canonicalize('https://example.com/a?ref_src=twsrc')).toBe('https://example.com/a');
    });

    it('REQ-GEN-004: strips mc_cid, mc_eid, igshid, si, source', () => {
      expect(canonicalize('https://example.com/a?mc_cid=1&mc_eid=2&igshid=3&si=4&source=rss')).toBe(
        'https://example.com/a'
      );
    });

    it('REQ-GEN-004: preserves non-tracking params', () => {
      expect(canonicalize('https://example.com/a?id=42&utm_source=x')).toBe('https://example.com/a?id=42');
      expect(canonicalize('https://example.com/search?q=cloudflare')).toBe(
        'https://example.com/search?q=cloudflare'
      );
    });

    it('REQ-GEN-004: strips tracking while keeping real params', () => {
      const input = 'https://news.ycombinator.com/item?id=42&utm_source=twitter&fbclid=abc';
      expect(canonicalize(input)).toBe('https://news.ycombinator.com/item?id=42');
    });
  });

  describe('case normalization', () => {
    it('REQ-GEN-004: lowercases scheme', () => {
      expect(canonicalize('HTTPS://example.com/')).toBe('https://example.com');
      expect(canonicalize('HTTP://example.com/')).toBe('https://example.com');
    });

    it('REQ-GEN-004: lowercases hostname', () => {
      expect(canonicalize('https://Example.COM/path')).toBe('https://example.com/path');
      expect(canonicalize('https://BLOG.Cloudflare.COM/rss/')).toBe('https://blog.cloudflare.com/rss');
    });

    it('REQ-GEN-004: preserves case in pathname and query', () => {
      expect(canonicalize('https://example.com/Path/To/Article?Q=CaseSensitive')).toBe(
        'https://example.com/Path/To/Article?Q=CaseSensitive'
      );
    });
  });

  describe('trailing slash handling', () => {
    it('REQ-GEN-004: drops trailing slash from non-root pathname', () => {
      expect(canonicalize('https://example.com/path/')).toBe('https://example.com/path');
      expect(canonicalize('https://example.com/a/b/c/')).toBe('https://example.com/a/b/c');
    });

    it('REQ-GEN-004: preserves root slash', () => {
      // WHATWG URL parses "https://example.com" to have pathname "/".
      // Root pathname must stay "/" in some form; the spec allows the
      // canonical to be either "https://example.com" or "https://example.com/".
      // We pick the no-trailing-slash form consistently — see implementation.
      const result = canonicalize('https://example.com/');
      // Root should render either as the bare origin or with a single slash,
      // but never lose meaning.
      expect(['https://example.com', 'https://example.com/']).toContain(result);
    });

    it('REQ-GEN-004: drops trailing slash when combined with query string', () => {
      expect(canonicalize('https://example.com/path/?id=1')).toBe('https://example.com/path?id=1');
    });
  });

  describe('malformed input', () => {
    it('REQ-GEN-004: returns input unchanged when URL is unparseable', () => {
      expect(canonicalize('not a url')).toBe('not a url');
      expect(canonicalize('://broken')).toBe('://broken');
      expect(canonicalize('')).toBe('');
    });
  });

  describe('combined transformations', () => {
    it('REQ-GEN-004: applies upgrade + strip + lowercase + trailing-slash in one call', () => {
      const input = 'HTTP://Example.COM/Path/?utm_source=twitter&id=42&fbclid=abc';
      expect(canonicalize(input)).toBe('https://example.com/Path?id=42');
    });

    it('REQ-GEN-004: same logical URL canonicalizes identically from different variants', () => {
      const a = canonicalize('http://Example.com/article/?utm_source=rss');
      const b = canonicalize('https://example.com/article');
      const c = canonicalize('HTTPS://EXAMPLE.COM/article?fbclid=xyz');
      expect(a).toBe(b);
      expect(b).toBe(c);
    });
  });
});
