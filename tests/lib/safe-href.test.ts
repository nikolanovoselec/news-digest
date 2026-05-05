// Tests for src/lib/safe-href.ts — REQ-DISC-005 render-time guard
// (CF-021: render-time defense-in-depth for URLs read out of D1).
import { describe, it, expect } from 'vitest';
import { safeHref } from '~/lib/safe-href';

describe('safeHref', () => {
  it('returns the URL unchanged for an https URL', () => {
    expect(safeHref('https://example.com/article')).toBe(
      'https://example.com/article',
    );
  });

  it('returns # for an http URL', () => {
    expect(safeHref('http://example.com/article')).toBe('#');
  });

  it('returns # for javascript: pseudo-scheme', () => {
    expect(safeHref('javascript:alert(1)')).toBe('#');
  });

  it('returns # for data: pseudo-scheme', () => {
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBe('#');
  });

  it('returns # for unparseable input', () => {
    expect(safeHref('not a url')).toBe('#');
    expect(safeHref('')).toBe('#');
    expect(safeHref(null)).toBe('#');
    expect(safeHref(undefined)).toBe('#');
  });
});
