// Implements REQ-AUTH-001 (CF-013) — formatRemaining contract pins.
//
// The /rate-limited page renders a countdown that the browser ticks
// from `formatRemaining(seconds)`. This test pins the format-string
// contract per CF-013: a pure-function unit test on the part that
// actually changes if a regression flips the format. The DOM
// choreography around it is exercised by the Playwright suite.

import { describe, it, expect } from 'vitest';
import { formatRemaining } from '~/scripts/rate-limited';

describe('formatRemaining (REQ-AUTH-001)', () => {
  it('REQ-AUTH-001: renders Hh Mm when at least one hour remains', () => {
    expect(formatRemaining(3661)).toBe('1h 1m');
    expect(formatRemaining(3600)).toBe('1h 0m');
    expect(formatRemaining(7200)).toBe('2h 0m');
    expect(formatRemaining(7321)).toBe('2h 2m');
  });

  it('REQ-AUTH-001: renders Mm Ss when under one hour', () => {
    expect(formatRemaining(65)).toBe('1m 5s');
    expect(formatRemaining(60)).toBe('1m 0s');
    expect(formatRemaining(3599)).toBe('59m 59s');
  });

  it('REQ-AUTH-001: renders 0m 0s at the boundary', () => {
    expect(formatRemaining(0)).toBe('0m 0s');
  });

  it('REQ-AUTH-001: format crosses cleanly at the hour boundary', () => {
    // The sub-hour formatter must not leak through when seconds === 3600.
    // A regression that wrote `if (h > 0)` as `if (h >= 1)` would still
    // pass these — what matters is that 3600 produces 1h 0m, not
    // 60m 0s.
    expect(formatRemaining(3599)).toBe('59m 59s');
    expect(formatRemaining(3600)).toBe('1h 0m');
  });
});
