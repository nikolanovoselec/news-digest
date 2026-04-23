// Tests for src/styles/global.css + src/layouts/Base.astro — REQ-DES-003
// (single easing curve, three duration tokens, View Transitions handle
// route changes, all motion gated on prefers-reduced-motion: no-preference,
// reduce collapses to instant state changes).

import { describe, it, expect } from 'vitest';
import globalCss from '../../src/styles/global.css?raw';
import baseAstro from '../../src/layouts/Base.astro?raw';

describe('REQ-DES-003: Deliberate motion system', () => {
  it('AC1: defines the single cubic-bezier easing curve as --ease', () => {
    // The canonical "ease-out expo" curve. Same curve used everywhere
    // the product animates — no per-component bespoke easing.
    expect(globalCss).toMatch(
      /--ease\s*:\s*cubic-bezier\s*\(\s*0\.22\s*,\s*1\s*,\s*0\.36\s*,\s*1\s*\)/,
    );
  });

  it('AC1: exposes three duration tokens — 150 ms, 250 ms, 400 ms', () => {
    expect(globalCss).toMatch(/--duration-fast\s*:\s*150ms/);
    expect(globalCss).toMatch(/--duration-base\s*:\s*250ms/);
    expect(globalCss).toMatch(/--duration-slow\s*:\s*400ms/);
  });

  it('AC1: only one cubic-bezier curve is declared (no bespoke easings)', () => {
    // Catches the regression where a later component adds a one-off
    // curve like `cubic-bezier(0.4, 0, 0.2, 1)` instead of using --ease.
    const curves = globalCss.match(/cubic-bezier\s*\([^)]*\)/g) ?? [];
    expect(curves.length).toBeGreaterThanOrEqual(1);
    const unique = new Set(curves.map((c) => c.replace(/\s+/g, '')));
    expect(unique.size).toBe(1);
  });

  it('AC2: Astro View Transitions router is imported into the base layout', () => {
    // <ClientRouter /> turns regular <a href> navigation into a View
    // Transitions swap — 250 ms cross-fade by default per Astro's
    // built-in styling.
    expect(baseAstro).toMatch(
      /import\s*\{\s*ClientRouter\s*\}\s*from\s*['"]astro:transitions['"]/,
    );
    expect(baseAstro).toMatch(/<ClientRouter\s*\/>/);
  });

  it('AC4: transitions on <html> are wrapped in prefers-reduced-motion: no-preference', () => {
    // Without the wrapper, users who set "reduce motion" at the OS
    // level would still get the theme cross-fade. The wrapper is the
    // a11y contract that satisfies AC4.
    const noPrefBlock = globalCss.match(
      /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{([\s\S]*?)\n\}/,
    );
    expect(noPrefBlock).not.toBeNull();
    const body = noPrefBlock?.[1] ?? '';
    expect(body).toMatch(/transition\s*:/);
    expect(body).toMatch(/var\(--duration-fast\)/);
    expect(body).toMatch(/var\(--ease\)/);
  });

  it('AC4: reduce collapses transition-duration and animation-duration to 0s', () => {
    // The global * selector under @media (prefers-reduced-motion: reduce)
    // is the "instant state change" half of the contract — any transition
    // or animation the product uses is clamped to 0s when the user opts
    // out of motion.
    const reduceBlock = globalCss.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/,
    );
    expect(reduceBlock).not.toBeNull();
    const body = reduceBlock?.[1] ?? '';
    expect(body).toMatch(/transition-duration\s*:\s*0s\s*!important/);
    expect(body).toMatch(/animation-duration\s*:\s*0s\s*!important/);
    // Applies to every element + pseudo — catches the case where a
    // component sets a transition on a ::before or ::after.
    expect(body).toMatch(/\*,[\s\S]*\*::before,[\s\S]*\*::after/);
  });
});
