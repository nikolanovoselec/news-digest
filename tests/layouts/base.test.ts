// Tests for src/layouts/Base.astro view-transition wiring.
//
// Pure source-string regression tests (matching the pattern of
// tests/history/page.test.ts and tests/reading/digest-page.test.ts):
// the layout cannot be SSR'd in a vitest worker, so we pin the
// presence of the load-bearing event listeners and CSS rules so a
// future refactor cannot silently undo them.
//
// Two behaviours are pinned:
//   1. preOpenHistoryDayInIncomingDocument — restores the morph
//      animation on /history → /digest/[id]/[slug] → back navigation
//      by opening the saved day's <details> in ev.newDocument BEFORE
//      the View-Transition snapshot is captured.
//   2. data-vt-active flag toggled on documentElement during a view
//      transition + matching CSS that forces the .site-header opaque
//      and drops backdrop-filter so the body cross-fade ghost does
//      not swim through the translucent header on back-nav.

import { describe, it, expect } from 'vitest';

import baseSource from '../../src/layouts/Base.astro?raw';

describe('Base.astro — view-transition wiring (REQ-DES-003 / REQ-HIST-001)', () => {
  it('registers preOpenHistoryDayInIncomingDocument as an astro:before-swap listener', () => {
    // Function definition exists.
    expect(baseSource).toContain('preOpenHistoryDayInIncomingDocument');
    // Function is wired up to before-swap (the event that fires before
    // the snapshot is captured).
    expect(baseSource).toMatch(
      /addEventListener\(\s*['"]astro:before-swap['"]\s*,\s*preOpenHistoryDayInIncomingDocument\s*\)/,
    );
  });

  it('reads the saved sessionStorage day-state key matching history.astro', () => {
    // The on-page restore in history.astro and the pre-open in
    // Base.astro must agree on the storage key — drift would silently
    // make the morph animation disappear again.
    expect(baseSource).toContain("'history:last-day-state'");
  });

  it('toggles the data-vt-active flag on astro:before-preparation and clears it on astro:after-swap', () => {
    // Set on before-preparation so the snapshot is captured with the
    // header already in its opaque state.
    expect(baseSource).toMatch(
      /astro:before-preparation[\s\S]{0,200}vtActive/,
    );
    // Clear on after-swap so normal scroll restores the frosted-glass
    // look. A half-fix that sets but never clears would leave the
    // header solid permanently after the first navigation.
    expect(baseSource).toMatch(
      /astro:after-swap[\s\S]{0,200}delete\s+document\.documentElement\.dataset\[['"]vtActive['"]\]/,
    );
  });

  it('CSS rule [data-vt-active] .site-header forces opaque background + no backdrop-filter', () => {
    expect(baseSource).toContain('[data-vt-active] .site-header');
    // The rule must drop both the standard and the -webkit-prefixed
    // backdrop-filter; iOS Safari only honours the prefixed property
    // in some versions, so the unprefixed override alone would leave
    // the blur in place on Safari and the bug would survive.
    expect(baseSource).toMatch(
      /\[data-vt-active\]\s*\.site-header\s*\{[\s\S]*backdrop-filter:\s*none[\s\S]*-webkit-backdrop-filter:\s*none/,
    );
    expect(baseSource).toMatch(
      /\[data-vt-active\]\s*\.site-header\s*\{[\s\S]*background-color:\s*var\(--bg\)/,
    );
  });
});
