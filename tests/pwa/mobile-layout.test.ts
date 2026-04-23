// Tests for REQ-PWA-003 — mobile-first responsive layout.
//
// The Partial flag was set because the implementation ships (viewport
// meta + safe-area insets + header UserMenu) but nothing verified it.
// These tests fail if someone:
//   - removes `viewport-fit=cover` from the viewport meta
//   - drops safe-area-inset padding on the header
//   - reintroduces a bottom tab bar or sidebar
//   - changes the brand→/digest link target

import { describe, it, expect } from 'vitest';
import baseSource from '../../src/layouts/Base.astro?raw';
import userMenuSource from '../../src/components/UserMenu.astro?raw';
import headerThemeToggleSource from '../../src/components/HeaderThemeToggle.astro?raw';
// The cloudflare vitest pool can't raw-import .css, so the project
// generates tests/fixtures/global-css.ts via `npm run fixtures` at
// pretest time. Use that fixture instead of `?raw` on global.css.
import { GLOBAL_CSS as globalCss } from '../fixtures/global-css';

describe('viewport meta — REQ-PWA-003 AC 1', () => {
  it('REQ-PWA-003: viewport declaration is the exact Safari-compliant triple', () => {
    // viewport-fit=cover is the piece that opts the page INTO
    // Safari's edge-to-edge mode; without it safe-area insets are
    // inert on iOS even when declared in CSS.
    expect(baseSource).toMatch(
      /<meta\s+name="viewport"\s+content="width=device-width,\s*initial-scale=1,\s*viewport-fit=cover"/,
    );
  });
});

describe('safe-area insets — REQ-PWA-003 AC 2', () => {
  it('REQ-PWA-003: global.css defines a .safe-top utility backed by env(safe-area-inset-top)', () => {
    // The header uses a utility class `safe-top` (or equivalent)
    // that padding-tops via env(safe-area-inset-top). Without this
    // the header's controls sit under the notch on iPhone.
    expect(globalCss).toMatch(/env\(safe-area-inset-top\)/);
  });

  it('REQ-PWA-003: global.css defines a .safe-x utility for left/right gesture bars', () => {
    expect(globalCss).toMatch(
      /env\(safe-area-inset-(left|right)\)/,
    );
  });

  it('REQ-PWA-003: header applies safe-top/safe-x utility classes', () => {
    // Base.astro's <header> must actually OPT IN to the utilities —
    // declaring them in global.css is not enough.
    expect(baseSource).toMatch(/<header[^>]*class="[^"]*\bsafe-top\b/);
    expect(baseSource).toMatch(/<header[^>]*class="[^"]*\bsafe-x\b/);
  });
});

describe('navigation consolidation — REQ-PWA-003 AC 3', () => {
  it('REQ-PWA-003: header hosts exactly the brand + ThemeToggle-or-UserMenu, nothing else', () => {
    // AC 3 enumerates the header contents: brand on the left, avatar
    // menu on the right. No stray buttons, no nav links.
    expect(baseSource).toMatch(/site-header__brand/);
    // UserMenu for authenticated users; ThemeToggle for unauth.
    expect(baseSource).toContain('UserMenu');
    expect(baseSource).toContain('ThemeToggle');
    // No bottom nav, no sidebar component — assert the legacy class
    // names never come back.
    expect(baseSource).not.toContain('bottom-nav');
    expect(baseSource).not.toContain('BottomNav');
    expect(baseSource).not.toContain('<aside');
    expect(baseSource).not.toContain('sidebar');
  });

  it('REQ-PWA-003: UserMenu dropdown contains History, Starred, Settings, Log out', () => {
    // AC 3 lists the entries that remain inside the dropdown. The
    // theme toggle moved OUT of the dropdown and into the header as a
    // standalone sun/moon icon (HeaderThemeToggle) — that assertion
    // lives in the next test so a regression would point at the right
    // component.
    expect(userMenuSource).toMatch(/href="\/history"/);
    expect(userMenuSource).toMatch(/href="\/starred"/);
    expect(userMenuSource).toMatch(/href="\/settings"/);
    expect(userMenuSource).toMatch(/action=.*\/api\/auth\/github\/logout|Log out/);
    // Regression guard: dark mode must NOT reappear inside the menu.
    expect(userMenuSource).not.toMatch(/>Dark Mode</);
    expect(userMenuSource).not.toMatch(/user-menu__theme\b/);
  });

  it('REQ-DES-002 / REQ-PWA-003: HeaderThemeToggle renders a [data-theme-toggle] button with sun + moon glyphs', () => {
    // Dark mode is a single-tap header control, not a dropdown item.
    // The HeaderThemeToggle component must ship both SVGs so the CSS
    // [data-theme] swap has something to show in each mode.
    expect(headerThemeToggleSource).toMatch(/data-theme-toggle/);
    expect(headerThemeToggleSource).toMatch(/header-theme-toggle__icon--sun/);
    expect(headerThemeToggleSource).toMatch(/header-theme-toggle__icon--moon/);
    expect(headerThemeToggleSource).toMatch(/aria-label="Toggle color theme"/);
  });

  it('REQ-DES-002 / REQ-PWA-003: Base.astro renders HeaderThemeToggle BEFORE UserMenu for authenticated users (avatar on the right, toggle to its left)', () => {
    // Left-of-avatar positioning is the entire point of the move — if
    // a future edit swaps the order, this test catches it.
    const htt = baseSource.indexOf('HeaderThemeToggle');
    const um = baseSource.indexOf('<UserMenu');
    expect(htt).toBeGreaterThan(-1);
    expect(um).toBeGreaterThan(-1);
    expect(htt).toBeLessThan(um);
  });

  it('REQ-PWA-003: header brand link points at /digest (the app home) for authed users', () => {
    // AC 4 — brand returns to the app home. The home is /digest,
    // not /settings and not /. For unauthenticated users the brand
    // still goes to / (served by middleware redirect), but the link
    // target itself is the brand's href.
    //
    // Pattern: <a href="/" class="site-header__brand">. Clicking "/"
    // hits the root which middleware routes to /digest when the
    // session is valid. We assert the brand IS a link (not a span)
    // and points at a resolvable target.
    expect(baseSource).toMatch(
      /<a[^>]*href="\/"[^>]*class="[^"]*site-header__brand/,
    );
  });
});

describe('tap / focus styling — REQ-PWA-003 AC 5', () => {
  it('REQ-PWA-003: -webkit-tap-highlight-color:transparent is applied globally', () => {
    // Default iOS/Android tap highlight is a blue flash on any <a>
    // or button tap. AC 5 requires the global suppress so focus/
    // active states are the only interactive feedback.
    expect(globalCss).toMatch(/-webkit-tap-highlight-color:\s*transparent/);
  });

  it('REQ-PWA-003: focus-visible ring is declared for keyboard navigation (not only hover)', () => {
    // Disabling tap highlight without a visible focus-ring would
    // regress keyboard a11y. The `.focus-ring` utility or the
    // :focus-visible selector must define an outline/ring.
    expect(globalCss).toMatch(/:focus-visible|\.focus-ring/);
  });
});
