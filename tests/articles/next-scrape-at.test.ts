// Unit tests for computeNextScrapeAt() — REQ-READ-001.
//
// The dashboard header countdown is derived from this function, not
// from `started_at + 3600`, because the cron changed to `0 */4 * * *`
// (00/04/08/12/16/20 UTC). The "is the countdown correct?" bug the
// user hit ("38 minutes left" when the cron is 4-hourly) reduces to
// whether this function returns the right UTC tick for an arbitrary
// clock — so the boundary cases MUST be pinned.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeNextScrapeAt } from '~/pages/api/digest/today';

/** Freeze `Date` at the given UTC time. Returns the unix-seconds of
 *  that frozen clock so the assertions can be computed against it. */
function freezeClock(utcIso: string): number {
  const date = new Date(utcIso);
  vi.useFakeTimers();
  vi.setSystemTime(date);
  return Math.floor(date.getTime() / 1000);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('computeNextScrapeAt — REQ-READ-001 boundary cases', () => {
  it('REQ-READ-001: exactly 04:00:00 UTC rolls forward to 08:00:00 UTC (no zero-delta return)', () => {
    // This is the branch the wider review flagged as untested — the
    // `nextHour <= h` bump-by-4 guard on line ~221 of today.ts. Without
    // it, the countdown would return a timestamp equal to `now` and
    // instantly refetch in a loop.
    const nowSec = freezeClock('2026-04-23T04:00:00.000Z');
    const next = computeNextScrapeAt();
    expect(next).toBe(nowSec + 4 * 3600);
    expect(new Date(next * 1000).getUTCHours()).toBe(8);
    expect(new Date(next * 1000).getUTCMinutes()).toBe(0);
    expect(new Date(next * 1000).getUTCSeconds()).toBe(0);
  });

  it('REQ-READ-001: one millisecond past 04:00:00 UTC still lands on 08:00:00 UTC', () => {
    // Strict-future guard must work even when the ceil(...) arithmetic
    // rounds to the same hour we're sitting on (the "== now" branch).
    freezeClock('2026-04-23T04:00:00.001Z');
    const next = computeNextScrapeAt();
    const d = new Date(next * 1000);
    expect(d.getUTCHours()).toBe(8);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
  });

  it('REQ-READ-001: mid-tick clock (05:30) returns the next quadrant hour (08:00)', () => {
    freezeClock('2026-04-23T05:30:00.000Z');
    const next = computeNextScrapeAt();
    const d = new Date(next * 1000);
    expect(d.getUTCHours()).toBe(8);
    expect(d.getUTCDate()).toBe(23);
  });

  it('REQ-READ-001: 20:01 UTC rolls over to 00:00 UTC *tomorrow*', () => {
    freezeClock('2026-04-23T20:01:00.000Z');
    const next = computeNextScrapeAt();
    const d = new Date(next * 1000);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCDate()).toBe(24);
    expect(d.getUTCMonth()).toBe(3); // April (0-indexed)
  });

  it('REQ-READ-001: exactly 20:00 UTC rolls forward to 00:00 UTC tomorrow', () => {
    freezeClock('2026-04-23T20:00:00.000Z');
    const next = computeNextScrapeAt();
    const d = new Date(next * 1000);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCDate()).toBe(24);
  });

  it('REQ-READ-001: 23:59:59 UTC rolls forward to 00:00 UTC tomorrow (month-spanning)', () => {
    freezeClock('2026-04-30T23:59:59.999Z');
    const next = computeNextScrapeAt();
    const d = new Date(next * 1000);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
    // May 1 — crossed the month boundary correctly.
    expect(d.getUTCMonth()).toBe(4); // May
    expect(d.getUTCDate()).toBe(1);
  });

  it('REQ-READ-001: the returned timestamp is always STRICTLY greater than now', () => {
    // Property test over a spread of clock values — every call must
    // return a tick that's in the future, never equal to now.
    const samples = [
      '2026-04-23T00:00:00.000Z',
      '2026-04-23T00:00:00.001Z',
      '2026-04-23T03:59:59.999Z',
      '2026-04-23T04:00:00.000Z',
      '2026-04-23T07:30:00.000Z',
      '2026-04-23T12:00:00.000Z',
      '2026-04-23T19:59:59.999Z',
      '2026-04-23T20:00:00.000Z',
      '2026-04-23T23:59:59.999Z',
    ];
    for (const iso of samples) {
      const nowSec = freezeClock(iso);
      const next = computeNextScrapeAt();
      expect(next, `should be strictly in the future for ${iso}`).toBeGreaterThan(
        nowSec,
      );
      expect(
        new Date(next * 1000).getUTCHours() % 4,
        `should land on a quadrant hour for ${iso}`,
      ).toBe(0);
      expect(new Date(next * 1000).getUTCMinutes()).toBe(0);
      expect(new Date(next * 1000).getUTCSeconds()).toBe(0);
    }
  });
});
