// Tests for src/lib/tz.ts — REQ-SET-003 (scheduled digest time with timezone)
// and REQ-GEN-001 (scheduled generation via cron dispatcher).
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TZ,
  localDateInTz,
  localHourMinuteInTz,
  isValidTz,
  localeForTz,
} from '~/lib/tz';

// 2026-04-22 12:00:00 UTC — a Wednesday at noon UTC.
// In Europe/Zurich (CEST, UTC+2) this is 14:00 local, same date.
// In America/New_York (EDT, UTC-4) this is 08:00 local, same date.
const NOON_UTC_2026_04_22 = 1776859200;

// 2026-04-22 00:30:00 UTC — early morning UTC.
// In America/New_York (UTC-4) this is 2026-04-21 20:30 — previous local date.
// In Europe/Zurich (UTC+2) this is 02:30 same date.
const EARLY_UTC_2026_04_22 = 1776817800;

// 2026-04-22 23:30:00 UTC.
// In Europe/Zurich (UTC+2) this is 2026-04-23 01:30 — next local date.
// In America/New_York (UTC-4) this is 19:30 same date.
const LATE_UTC_2026_04_22 = 1776900600;

describe('DEFAULT_TZ', () => {
  it('REQ-SET-003: DEFAULT_TZ is UTC', () => {
    expect(DEFAULT_TZ).toBe('UTC');
  });
});

describe('localeForTz', () => {
  // Pins the heuristic that drives 24h-vs-12h selection for both
  // server-rendered ingestion times (digest detail page) and the
  // <input type="time"> widget on /settings. A regression that
  // flips this to always-en-US would silently re-introduce the
  // 12h-on-Europe/Zurich bug fixed in PR6.
  it('REQ-SET-003: America/* zones use en-US (12h)', () => {
    expect(localeForTz('America/Los_Angeles')).toBe('en-US');
    expect(localeForTz('America/New_York')).toBe('en-US');
  });

  it('REQ-SET-003: non-America zones use en-GB (24h)', () => {
    expect(localeForTz('Europe/Zurich')).toBe('en-GB');
    expect(localeForTz('Asia/Tokyo')).toBe('en-GB');
    expect(localeForTz('UTC')).toBe('en-GB');
  });
});

describe('localDateInTz', () => {
  it('REQ-GEN-001: returns YYYY-MM-DD in UTC', () => {
    expect(localDateInTz(NOON_UTC_2026_04_22, 'UTC')).toBe('2026-04-22');
  });

  it('REQ-GEN-001: returns YYYY-MM-DD in Europe/Zurich', () => {
    // 12:00 UTC is 14:00 CEST same day — date unchanged.
    expect(localDateInTz(NOON_UTC_2026_04_22, 'Europe/Zurich')).toBe('2026-04-22');
  });

  it('REQ-GEN-001: returns YYYY-MM-DD in America/New_York', () => {
    // 12:00 UTC is 08:00 EDT same day — date unchanged.
    expect(localDateInTz(NOON_UTC_2026_04_22, 'America/New_York')).toBe('2026-04-22');
  });

  it('REQ-GEN-001: returns previous local date when UTC is early and tz is behind UTC', () => {
    // 00:30 UTC on 2026-04-22 is 20:30 EDT on 2026-04-21.
    expect(localDateInTz(EARLY_UTC_2026_04_22, 'America/New_York')).toBe('2026-04-21');
  });

  it('REQ-GEN-001: returns next local date when UTC is late and tz is ahead of UTC', () => {
    // 23:30 UTC on 2026-04-22 is 01:30 CEST on 2026-04-23.
    expect(localDateInTz(LATE_UTC_2026_04_22, 'Europe/Zurich')).toBe('2026-04-23');
  });

  it('REQ-GEN-001: output is YYYY-MM-DD format (10 chars, two hyphens)', () => {
    const result = localDateInTz(NOON_UTC_2026_04_22, 'UTC');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('localHourMinuteInTz', () => {
  it('REQ-GEN-001: returns hour/minute in UTC', () => {
    expect(localHourMinuteInTz(NOON_UTC_2026_04_22, 'UTC')).toEqual({ hour: 12, minute: 0 });
  });

  it('REQ-GEN-001: returns hour/minute in Europe/Zurich (UTC+2 summer)', () => {
    // 12:00 UTC is 14:00 CEST.
    expect(localHourMinuteInTz(NOON_UTC_2026_04_22, 'Europe/Zurich')).toEqual({ hour: 14, minute: 0 });
  });

  it('REQ-GEN-001: returns hour/minute in America/New_York (UTC-4 summer)', () => {
    // 12:00 UTC is 08:00 EDT.
    expect(localHourMinuteInTz(NOON_UTC_2026_04_22, 'America/New_York')).toEqual({ hour: 8, minute: 0 });
  });

  it('REQ-GEN-001: returns 0 for midnight hour, not 24', () => {
    // 22:00 UTC is 00:00 CEST next day — verify hour is 0, not 24.
    const midnightZurich = 1776895200; // 2026-04-22 22:00 UTC = 2026-04-23 00:00 CEST
    const result = localHourMinuteInTz(midnightZurich, 'Europe/Zurich');
    expect(result.hour).toBe(0);
  });

  it('REQ-GEN-001: preserves minutes across timezone conversion', () => {
    // Timezones that offset in whole hours should preserve minutes.
    const tenFortyFive = 1776854700; // 2026-04-22 10:45 UTC
    const utc = localHourMinuteInTz(tenFortyFive, 'UTC');
    const zurich = localHourMinuteInTz(tenFortyFive, 'Europe/Zurich');
    expect(utc.minute).toBe(45);
    expect(zurich.minute).toBe(45);
  });
});

describe('isValidTz', () => {
  it('REQ-SET-003: accepts UTC', () => {
    expect(isValidTz('UTC')).toBe(true);
  });

  it('REQ-SET-003: accepts Europe/Zurich', () => {
    expect(isValidTz('Europe/Zurich')).toBe(true);
  });

  it('REQ-SET-003: accepts America/New_York', () => {
    expect(isValidTz('America/New_York')).toBe(true);
  });

  it('REQ-SET-003: accepts Asia/Tokyo', () => {
    expect(isValidTz('Asia/Tokyo')).toBe(true);
  });

  it('REQ-SET-003: rejects invented timezone', () => {
    expect(isValidTz('Mars/Olympus_Mons')).toBe(false);
  });

  it('REQ-SET-003: rejects empty string', () => {
    expect(isValidTz('')).toBe(false);
  });

  it('REQ-SET-003: rejects garbage input', () => {
    expect(isValidTz('not-a-timezone')).toBe(false);
    expect(isValidTz('Foo/Bar')).toBe(false);
  });
});
