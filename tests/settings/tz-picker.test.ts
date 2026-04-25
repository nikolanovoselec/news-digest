// Tests for the settings.astro manual timezone picker —
// REQ-SET-007 AC 5 (browser-detected pre-select).
//
// The picker replaces the read-only <output> with a <select> populated
// from the runtime's IANA zone inventory. Server-side pre-select is the
// stored tz; client JS upgrades the selection to the browser-detected
// zone on load when the two differ. Saving the form sends the picked
// value via the existing /api/auth/set-tz POST.

import { describe, it, expect } from 'vitest';
import settingsPage from '../../src/pages/settings.astro?raw';

describe('settings.astro manual tz picker — REQ-SET-007 AC 5', () => {
  it('REQ-SET-007: settings.astro renders a <select> for timezone (not a read-only <output>)', () => {
    // The form must expose a real form control so users can change the
    // value when auto-detect is wrong. Regression guard against the
    // pre-amend read-only <output>.
    expect(settingsPage).toMatch(/<select[\s\S]*?data-tz-select/);
    expect(settingsPage).not.toMatch(/<output[^>]*data-tz-display/);
  });

  it('REQ-SET-007: select options come from Intl.supportedValuesOf("timeZone")', () => {
    // Server-side renders the full IANA inventory so the user sees a
    // complete picker, not a hand-curated short list.
    expect(settingsPage).toContain("Intl.supportedValuesOf('timeZone')");
  });

  it('REQ-SET-007: server-side pre-selects the stored tz on first render', () => {
    // The selected attribute must be tied to the stored tz so users
    // who never trigger client JS still see the correct value.
    expect(settingsPage).toMatch(/selected=\{[^}]*tzValue/);
  });

  it('REQ-SET-007: client JS swaps the selection to the browser-detected zone when it differs', () => {
    // On page load, if the browser tz is valid and not equal to the
    // server-rendered selection, the JS must change select.value to
    // the browser tz so saving the form persists the right answer
    // without requiring the user to scroll the dropdown.
    expect(settingsPage).toContain('data-tz-select');
    expect(settingsPage).toMatch(
      /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone[\s\S]*?\.value/,
    );
  });

  it('REQ-SET-007: form submit reads the picked value from the <select> (not from textContent)', () => {
    // The submitSettings handler must source `tz` from the select's
    // `.value`, not from the old <output>'s textContent. Regression
    // guard against a stale fallback that ignores the user's choice.
    expect(settingsPage).toMatch(/data-tz-select[\s\S]*?\.value/);
  });

  it('REQ-SET-007: settings.astro annotates itself with the REQ id', () => {
    expect(settingsPage).toContain('REQ-SET-007');
  });
});
