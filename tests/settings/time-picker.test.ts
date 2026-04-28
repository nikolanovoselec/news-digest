// Tests for the settings.astro digest-time picker — REQ-SET-003.
//
// The picker uses two <select>s named `hour` (00..23) and `minute`
// (00, 05, ..., 55) instead of `<input type="time">`. Native time
// inputs render in 12h on Chromium and Safari whenever the device
// locale is en-US, ignoring the `lang` attribute and any CSS hint.
// A user in Europe/Zagreb on an en-US Android still saw "08:00 AM"
// because of this — see commit history for the reproduction.
//
// <select> options are literal strings, so 24h text always renders
// 24h regardless of browser, OS, or device locale.

import { describe, it, expect } from 'vitest';
import settingsPage from '../../src/pages/settings.astro?raw';

describe('settings.astro digest-time picker — REQ-SET-003', () => {
  it('REQ-SET-003: replaces native <input type="time"> with two <select>s', () => {
    // Hard regression guard: native time-input UI is unreliable across
    // platforms, so the picker must NOT use it. The bare strings
    // catch even attribute-reordered variants.
    expect(settingsPage).not.toMatch(/<input[^>]*type=["']time["']/);
    expect(settingsPage).toMatch(/<select[\s\S]*?data-hour-select/);
    expect(settingsPage).toMatch(/<select[\s\S]*?data-minute-select/);
  });

  it('REQ-SET-003: hour <select> exposes 24 options (00 through 23)', () => {
    // The HOUR_OPTIONS array drives the render. Pin its full coverage
    // to the page source so a regression that shrinks it (e.g. to
    // "8am-10pm only") is caught immediately.
    const hourArrayMatch = settingsPage.match(
      /HOUR_OPTIONS[\s\S]*?Array\.from\(\{[\s]*length:[\s]*24/,
    );
    expect(hourArrayMatch).not.toBeNull();
  });

  it('REQ-SET-003: hour labels switch to 12h AM/PM for America/* timezones', () => {
    // US/Canada/Mexico users culturally expect AM/PM; rest of the
    // world uses 24h. The submitted form value remains the canonical
    // 0-23 integer regardless of label format. Pin both the
    // tz-startsWith heuristic and the 12h-label generator.
    expect(settingsPage).toMatch(/displayHour12\s*=\s*tzValue\.startsWith\(['"]America\//);
    expect(settingsPage).toContain("'12 AM'");
    expect(settingsPage).toContain("'12 PM'");
    // option value stays the canonical 24h string regardless of label
    expect(settingsPage).toMatch(/<option[\s\S]*?value=\{h\.value\}[\s\S]*?\{h\.label\}/);
  });

  it('REQ-SET-003: minute <select> uses 5-minute increments', () => {
    // The cron runs every 5 minutes — finer granularity adds nothing
    // and clutters the picker. Pin the step.
    const minuteArrayMatch = settingsPage.match(
      /MINUTE_STEP_OPTIONS[\s\S]*?Array\.from\(\{[\s]*length:[\s]*12[\s\S]*?\* 5/,
    );
    expect(minuteArrayMatch).not.toBeNull();
  });

  it('REQ-SET-003: hour + minute selects submit as separate form fields', () => {
    // The native form-POST fallback (REQ-AUTH-003 compatible) parses
    // form.get('hour') and form.get('minute') — not a single
    // form.get('time'). The two-select layout requires both names to
    // appear on the controls.
    expect(settingsPage).toMatch(/<select[^>]*\bname=["']hour["']/);
    expect(settingsPage).toMatch(/<select[^>]*\bname=["']minute["']/);
  });

  it('REQ-SET-003: stored non-step minute is preserved as an extra option', () => {
    // Legacy users may have any minute 0-59 stored; we render their
    // exact value as an additional option so saving doesn't silently
    // snap it to the nearest 5-minute slot.
    expect(settingsPage).toMatch(
      /MINUTE_STEP_OPTIONS\.includes\(storedMinuteStr\)/,
    );
  });

  it('REQ-SET-003: client submit handler reads digest_hour from data-hour-select', () => {
    // The PUT /api/settings JSON body builder must source the hour
    // from the new <select> data attribute, not from a removed time
    // input.
    expect(settingsPage).toMatch(/data-hour-select[\s\S]*?\.value/);
    expect(settingsPage).toMatch(/data-minute-select[\s\S]*?\.value/);
  });

  it('REQ-SET-003: removes the obsolete timeLangForTz heuristic', () => {
    // The 'lang' hint never worked on Chromium and is no longer
    // referenced now that the picker is locale-immune. Catch any
    // accidental revert that re-introduces the dead branch.
    expect(settingsPage).not.toContain('timeLangForTz');
    expect(settingsPage).not.toMatch(/lang=\{timeInputLang\}/);
  });
});
