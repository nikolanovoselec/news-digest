// Tests for src/styles/global.css — REQ-DES-001 (Swiss-minimal visual
// language: system fonts, five-size type scale, two-weight body/heading,
// no gradients or drop shadows, iOS 16 px input floor, focus-visible ring,
// 44 × 44 touch targets).
//
// Static-content verification: the REQ promises *tokens* and *rules* that
// must be present in the stylesheet, not runtime behaviour. Reading the
// file text with Vite's ?raw suffix keeps the assertions deterministic
// and free of a browser/jsdom fixture.

import { describe, it, expect } from 'vitest';
import globalCss from '../../src/styles/global.css?raw';
import baseAstro from '../../src/layouts/Base.astro?raw';

describe('REQ-DES-001: Swiss-minimal visual language', () => {
  it('AC1: declares the system font stack as --font-sans', () => {
    expect(globalCss).toMatch(/--font-sans\s*:/);
    expect(globalCss).toContain('-apple-system');
    expect(globalCss).toContain('BlinkMacSystemFont');
    expect(globalCss).toContain("'Segoe UI'");
    expect(globalCss).toContain('Inter');
    expect(globalCss).toContain('sans-serif');
  });

  it('AC1: defines all five type-scale sizes (12, 14, 16, 20, 32 px)', () => {
    expect(globalCss).toMatch(/--text-xs\s*:\s*12px/);
    expect(globalCss).toMatch(/--text-sm\s*:\s*14px/);
    expect(globalCss).toMatch(/--text-base\s*:\s*16px/);
    expect(globalCss).toMatch(/--text-lg\s*:\s*20px/);
    expect(globalCss).toMatch(/--text-2xl\s*:\s*32px/);
  });

  it('AC1: body weight is 400 on <html>', () => {
    // html { … font-weight: 400; } — the body-weight half of the
    // two-weight contract. 600 (headings/labels) is applied per
    // component and is exercised by AC-specific chrome tests.
    expect(globalCss).toMatch(/html\s*\{[^}]*font-weight\s*:\s*400/s);
  });

  it('AC1: 600-weight (headings/labels) is used for chrome', () => {
    // Base.astro renders the brand wordmark at weight 600 — the
    // heading/label half of the two-weight contract.
    expect(baseAstro).toMatch(/font-weight\s*:\s*600/);
  });

  it('AC2: no gradient or drop-shadow declarations appear in global.css', () => {
    // Neutral palette + single accent + no decorative effects. We
    // grep the stylesheet for any `linear-gradient(`, `radial-gradient(`,
    // or `box-shadow:` declaration — the usual ways a gradient or
    // drop shadow sneaks in.
    expect(globalCss).not.toMatch(/linear-gradient\s*\(/);
    expect(globalCss).not.toMatch(/radial-gradient\s*\(/);
    expect(globalCss).not.toMatch(/conic-gradient\s*\(/);
    expect(globalCss).not.toMatch(/box-shadow\s*:/);
    expect(globalCss).not.toMatch(/text-shadow\s*:/);
    expect(globalCss).not.toMatch(/filter\s*:\s*drop-shadow/);
  });

  it('AC2: exposes a single accent token per theme', () => {
    // --accent is defined once in :root (light) and once in
    // [data-theme="dark"] — that is the "single accent per theme"
    // contract.
    const lightAccentMatches = globalCss.match(/:root\s*\{[^}]*--accent\s*:/gs);
    const darkAccentMatches = globalCss.match(/\[data-theme=['"]dark['"]\]\s*\{[^}]*--accent\s*:/gs);
    expect(lightAccentMatches).not.toBeNull();
    expect(darkAccentMatches).not.toBeNull();
  });

  it('AC3: input, textarea, and select set font-size to the 16 px token', () => {
    // Explicit selector block for form controls, bound to --text-base
    // (= 16px). This prevents iOS Safari's automatic zoom-on-focus,
    // which triggers whenever a focused input's computed font-size
    // is below 16 px.
    const match = globalCss.match(
      /input\s*,\s*\n?\s*textarea\s*,\s*\n?\s*select\s*\{[^}]*font-size\s*:\s*var\(--text-base\)/s,
    );
    expect(match).not.toBeNull();
  });

  it('AC4: :focus-visible applies a visible outline ring', () => {
    // Keyboard focus renders a 2 px outline in the accent colour with
    // a 2 px offset. Mouse clicks are intentionally excluded via
    // :focus-visible so the ring doesn't flash on pointer interaction.
    const focusBlock = globalCss.match(/:focus-visible[^{]*\{([^}]*)\}/s);
    expect(focusBlock).not.toBeNull();
    const body = focusBlock?.[1] ?? '';
    expect(body).toMatch(/outline\s*:\s*2px\s+solid\s+var\(--accent\)/);
    expect(body).toMatch(/outline-offset\s*:\s*2px/);
  });

  it('AC5: interactive elements declare the 44 × 44 px touch-target minimum', () => {
    // Selector covers button, a, [role="button"], and input[type=button/submit/reset].
    const block = globalCss.match(
      /button\s*,[\s\S]*?a\s*,[\s\S]*?\[role=['"]button['"]\][\s\S]*?\{([^}]*)\}/,
    );
    expect(block).not.toBeNull();
    const body = block?.[1] ?? '';
    expect(body).toMatch(/min-width\s*:\s*44px/);
    expect(body).toMatch(/min-height\s*:\s*44px/);
  });

  it('AC6: root element fills the mobile viewport height', () => {
    // html, body both declared min-height: 100svh — the small-viewport
    // unit accounts for iOS dynamic toolbars so the background colour
    // reaches the bottom of the viewport on short pages.
    expect(baseAstro).toMatch(/min-height\s*:\s*100svh/);
  });

  it('AC6: safe-area inset helpers exist so content clears notches and home indicators', () => {
    // .safe-top / .safe-bottom / .safe-x use env(safe-area-inset-*) so
    // the header stays clear of the status bar and footers stay clear
    // of the home indicator on iOS.
    expect(globalCss).toMatch(/\.safe-top\s*\{[^}]*env\(safe-area-inset-top\)/s);
    expect(globalCss).toMatch(/\.safe-bottom\s*\{[^}]*env\(safe-area-inset-bottom\)/s);
    expect(globalCss).toMatch(/\.safe-x\s*\{[^}]*env\(safe-area-inset-left\)[\s\S]*env\(safe-area-inset-right\)/s);
  });
});
