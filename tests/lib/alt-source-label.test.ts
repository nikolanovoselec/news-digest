// Tests for src/lib/alt-source-label.ts — REQ-READ-001 AC 7.
//
// The dashboard card's "+N" suffix and its accessibility label come
// from a pure formatter so the contract can be pinned without an
// Astro renderer in the test harness. Each test exercises one
// observable input → output mapping for the suffix string and the
// aria-label sentence shown to assistive technology.

import { describe, it, expect } from 'vitest';
import { formatAltSourceLabel } from '~/lib/alt-source-label';

describe('formatAltSourceLabel — REQ-READ-001 AC 7', () => {
  it('REQ-READ-001 AC 7: returns empty suffix and empty aria-label when altCount is 0 (single-source article — no "+N" rendered)', () => {
    const result = formatAltSourceLabel(0);
    expect(result.suffix).toBe('');
    expect(result.ariaLabel).toBe('');
  });

  it('REQ-READ-001 AC 7: renders "+1" with singular "source" aria-label when there is one alternate', () => {
    const result = formatAltSourceLabel(1);
    expect(result.suffix).toBe(' +1');
    expect(result.ariaLabel).toBe('plus 1 other source');
  });

  it('REQ-READ-001 AC 7: renders "+N" with plural "sources" aria-label when there are multiple alternates', () => {
    const three = formatAltSourceLabel(3);
    expect(three.suffix).toBe(' +3');
    expect(three.ariaLabel).toBe('plus 3 other sources');

    const ten = formatAltSourceLabel(10);
    expect(ten.suffix).toBe(' +10');
    expect(ten.ariaLabel).toBe('plus 10 other sources');
  });

  it('REQ-READ-001 AC 7: defensively returns empty for negative or non-finite inputs (defensive against bad wire data)', () => {
    expect(formatAltSourceLabel(-1)).toEqual({ suffix: '', ariaLabel: '' });
    expect(formatAltSourceLabel(Number.NaN)).toEqual({ suffix: '', ariaLabel: '' });
    expect(formatAltSourceLabel(Number.POSITIVE_INFINITY)).toEqual({
      suffix: '',
      ariaLabel: '',
    });
  });
});
