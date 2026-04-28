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
import effectsSource from '../../src/scripts/page-effects.ts?raw';
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
    // AC 4 — brand returns to the app home. The href is now an
    // expression: authenticated users get '/digest' directly (no
    // root-redirect round-trip), unauthenticated users still get '/'
    // (the marketing landing). The brand also carries data-brand-home
    // so the page-effects.ts click delegate can intercept self-
    // navigation on /digest and turn it into a scroll-to-top.
    expect(baseSource).toMatch(
      /<a[\s\S]{0,300}href=\{Astro\.locals\.user\s*\?\s*['"]\/digest['"]\s*:\s*['"]\/['"]\}[\s\S]{0,200}site-header__brand/,
    );
    expect(baseSource).toMatch(/data-brand-home/);
  });

  it('REQ-PWA-003 AC 4: brand-link click on /digest (no filter) scrolls to top instead of self-navigating; preserves filter-clear semantics on /digest?tags=...', () => {
    // The page-effects click delegate must (1) intercept self-navigation
    // when the URL is EXACTLY /digest with no query string, (2) bypass
    // intercept when there are query params so /digest?tags=ai
    // navigation to clean /digest still clears the filter, and (3)
    // never preventDefault on modifier-clicks (cmd/ctrl/shift/alt) so
    // "open in new tab" still works.
    expect(effectsSource).toMatch(/closest[\s\S]{0,80}a\[data-brand-home\]/);
    expect(effectsSource).toMatch(
      /window\.location\.pathname\s*!==\s*['"]\/digest['"]/,
    );
    expect(effectsSource).toMatch(
      /window\.location\.search\s*!==\s*['"]['"]/,
    );
    expect(effectsSource).toMatch(/metaKey|ctrlKey|shiftKey|altKey/);
    expect(effectsSource).toMatch(/window\.scrollTo\(\s*\{\s*top:\s*0/);
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

describe('header tap-target minimums — REQ-PWA-003 AC 6', () => {
  // AC 6 — every interactive header control (theme toggle, user
  // menu trigger, anonymous theme toggle) carries the 44×44 CSS-pixel
  // minimum from WCAG 2.5.5 / Apple HIG. Regressing a single one
  // (min-height stripped, compact icon button) breaks one-handed
  // mobile thumbs. The assertions scan the component sources directly
  // so a refactor that drops the rule is visible in CI.

  it('REQ-PWA-003: HeaderThemeToggle trigger has min-width: 44px and min-height: 44px', () => {
    // `<button class="header-theme-toggle">` on every authenticated
    // page. The rule block below declares both — stripping either
    // would shrink the tap target.
    expect(headerThemeToggleSource).toMatch(/min-width:\s*44px/);
    expect(headerThemeToggleSource).toMatch(/min-height:\s*44px/);
  });

  it('REQ-PWA-003: UserMenu trigger (avatar <summary>) has min-width: 44px and min-height: 44px', () => {
    expect(userMenuSource).toMatch(/min-width:\s*44px/);
    expect(userMenuSource).toMatch(/min-height:\s*44px/);
  });

  it('REQ-PWA-003: anonymous ThemeToggle has min-width: 44px and min-height: 44px', async () => {
    // Shown on signed-out pages (landing, auth error). Same control,
    // same tap-target contract so the affordance is identical before
    // and after sign-in.
    const themeToggle = await import('../../src/components/ThemeToggle.astro?raw').then((m) => m.default);
    expect(themeToggle).toMatch(/min-width:\s*44px/);
    expect(themeToggle).toMatch(/min-height:\s*44px/);
  });
});
