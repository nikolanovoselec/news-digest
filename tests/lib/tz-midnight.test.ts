// Tests for src/lib/tz.ts `localMidnightUnixInTz` — REQ-MAIL-001.
//
// The helper returns the unix-seconds timestamp of "00:00 local time" in
// {tz} on the same local date as {now}. The email dispatcher uses it to
// build the SQL cutoff for the "Since midnight: N articles" tag tally,
// so correctness across DST transitions is load-bearing.
//
// Tests are written as property assertions wherever possible:
//   - Round-trip: the returned timestamp's local date matches the input's.
//   - Local-time component is exactly { hour: 0, minute: 0 }.
//   - Idempotence within a local day: two inputs in the same local day
//     produce the same midnight.
// Property style avoids hard-coding unix-second values that are easy to
// off-by-one when the test author miscounts DST offsets.

import { describe, it, expect } from 'vitest';
import {
  localMidnightUnixInTz,
  localDateInTz,
  localHourMinuteInTz,
} from '~/lib/tz';

// 2026-04-22 12:00:00 UTC — same anchor used by the existing tz.test.ts.
const NOON_UTC_2026_04_22 = 1776859200;

// 2026-03-08 12:00:00 UTC — US spring-forward day (2:00 EST → 3:00 EDT
// happens at 07:00 UTC). Noon UTC sits comfortably AFTER the transition,
// so the local date in America/New_York is unambiguously 2026-03-08.
const SPRING_FORWARD_NOON_UTC = Date.UTC(2026, 2, 8, 12, 0, 0) / 1000;

// 2026-10-25 12:00:00 UTC — Europe fall-back day (3:00 CEST → 2:00 CET
// at 01:00 UTC). Noon UTC = 13:00 CET on the same local date.
const FALL_BACK_NOON_UTC_EU = Date.UTC(2026, 9, 25, 12, 0, 0) / 1000;

describe('localMidnightUnixInTz — REQ-MAIL-001', () => {
  it('REQ-MAIL-001: returns 00:00 in UTC for noon-UTC input', () => {
    const midnight = localMidnightUnixInTz(NOON_UTC_2026_04_22, 'UTC');
    // 2026-04-22 00:00:00 UTC.
    expect(midnight).toBe(Date.UTC(2026, 3, 22, 0, 0, 0) / 1000);
  });

  it('REQ-MAIL-001: returns Zurich-local midnight (CEST UTC+2)', () => {
    // 2026-04-22 00:00 CEST = 2026-04-21 22:00 UTC.
    const midnight = localMidnightUnixInTz(NOON_UTC_2026_04_22, 'Europe/Zurich');
    expect(midnight).toBe(Date.UTC(2026, 3, 21, 22, 0, 0) / 1000);
  });

  it('REQ-MAIL-001: returns NY-local midnight (EDT UTC-4)', () => {
    // 2026-04-22 00:00 EDT = 2026-04-22 04:00 UTC.
    const midnight = localMidnightUnixInTz(NOON_UTC_2026_04_22, 'America/New_York');
    expect(midnight).toBe(Date.UTC(2026, 3, 22, 4, 0, 0) / 1000);
  });

  it('REQ-MAIL-001: returned timestamp formats as 00:00 in the same tz', () => {
    for (const tz of ['UTC', 'Europe/Zurich', 'America/New_York', 'Asia/Tokyo']) {
      const midnight = localMidnightUnixInTz(NOON_UTC_2026_04_22, tz);
      expect(localHourMinuteInTz(midnight, tz)).toEqual({ hour: 0, minute: 0 });
    }
  });

  it('REQ-MAIL-001: returned timestamp has the same local date as the input', () => {
    for (const tz of ['UTC', 'Europe/Zurich', 'America/New_York', 'Asia/Tokyo']) {
      const midnight = localMidnightUnixInTz(NOON_UTC_2026_04_22, tz);
      expect(localDateInTz(midnight, tz)).toBe(localDateInTz(NOON_UTC_2026_04_22, tz));
    }
  });

  it('REQ-MAIL-001: handles DST spring-forward in America/New_York', () => {
    // Pick a timestamp comfortably after the 07:00 UTC transition
    // (noon UTC = 08:00 EDT same date).
    const midnight = localMidnightUnixInTz(SPRING_FORWARD_NOON_UTC, 'America/New_York');
    // Local date is 2026-03-08; midnight EST (the wall clock that
    // happened BEFORE the spring-forward) was at 05:00 UTC, since
    // EST is UTC-5 and the gap doesn't span midnight.
    expect(localHourMinuteInTz(midnight, 'America/New_York')).toEqual({ hour: 0, minute: 0 });
    expect(localDateInTz(midnight, 'America/New_York')).toBe('2026-03-08');
  });

  it('REQ-MAIL-001: handles DST fall-back in Europe/Zurich', () => {
    const midnight = localMidnightUnixInTz(FALL_BACK_NOON_UTC_EU, 'Europe/Zurich');
    expect(localHourMinuteInTz(midnight, 'Europe/Zurich')).toEqual({ hour: 0, minute: 0 });
    expect(localDateInTz(midnight, 'Europe/Zurich')).toBe('2026-10-25');
  });

  it('REQ-MAIL-001: returns the SAME midnight for two inputs in the same local day', () => {
    // Two different timestamps within the same Europe/Zurich local day
    // must collapse to the same midnight.
    const morning = NOON_UTC_2026_04_22 - 4 * 3600; // 08:00 UTC = 10:00 CEST
    const evening = NOON_UTC_2026_04_22 + 6 * 3600; // 18:00 UTC = 20:00 CEST
    expect(localMidnightUnixInTz(morning, 'Europe/Zurich')).toBe(
      localMidnightUnixInTz(evening, 'Europe/Zurich'),
    );
  });

  it('REQ-MAIL-001: returned midnight is strictly less than or equal to the input', () => {
    for (const tz of ['UTC', 'Europe/Zurich', 'America/New_York', 'Asia/Tokyo']) {
      const midnight = localMidnightUnixInTz(NOON_UTC_2026_04_22, tz);
      expect(midnight).toBeLessThanOrEqual(NOON_UTC_2026_04_22);
    }
  });
});
