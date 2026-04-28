// Implements REQ-DES-002: client-side theme toggle logic. Loaded as a module
// script from ThemeToggle.astro. Reads/writes localStorage.theme and toggles
// the `data-theme` attribute on <html>. The no-FOUC first-paint resolution is
// handled by the external `/theme-init.js` script — this file only runs on
// user interaction after hydration.

export type Theme = 'light' | 'dark';

export const STORAGE_KEY = 'theme';
export const DATA_ATTR = 'theme';

export function readStoredTheme(storage: Storage): Theme | null {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === 'light' || raw === 'dark') return raw;
  return null;
}

export function resolveTheme(
  storage: Storage,
  matchMedia: (q: string) => MediaQueryList
): Theme {
  const stored = readStoredTheme(storage);
  if (stored) return stored;
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}

export function nextTheme(current: Theme): Theme {
  return current === 'dark' ? 'light' : 'dark';
}

// Keep the iOS / Android system status-bar colour locked to the
// app-selected theme. Mirrors the same write that /theme-init.js does
// on first paint so a user toggling theme mid-session sees the status
// bar repaint immediately, not on the next navigation.
function applyMetaThemeColor(doc: Document, theme: Theme): void {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta === null) return;
  meta.setAttribute('content', theme === 'dark' ? '#0a0a0a' : '#ffffff');
}

export function applyTheme(doc: Document, theme: Theme): void {
  doc.documentElement.dataset[DATA_ATTR] = theme;
  applyMetaThemeColor(doc, theme);
}

export function persistTheme(storage: Storage, theme: Theme): void {
  storage.setItem(STORAGE_KEY, theme);
}

/**
 * Write a 1-year `theme` cookie with the selected value. The server reads
 * this in Base.astro and sets `data-theme` on the first rendered HTML,
 * eliminating the light-to-dark flash on page load. Safe defaults: no
 * JS-visible path change, no secure flag (the value is non-sensitive UI
 * state), SameSite=Lax so it accompanies cross-site navigations.
 */
export function persistThemeCookie(doc: Document, theme: Theme): void {
  const oneYearSec = 60 * 60 * 24 * 365;
  doc.cookie = `theme=${theme}; Path=/; Max-Age=${oneYearSec}; SameSite=Lax`;
}

// Toggles, persists, and applies. Returns the theme now in effect.
export function toggleTheme(
  doc: Document,
  storage: Storage,
  matchMedia: (q: string) => MediaQueryList
): Theme {
  const current = resolveTheme(storage, matchMedia);
  const next = nextTheme(current);
  applyTheme(doc, next);
  persistTheme(storage, next);
  persistThemeCookie(doc, next);
  return next;
}

// Browser-only: wire the click handler onto the button with the expected data attribute.
// Called from ThemeToggle.astro's inline module script; safe to call multiple times
// because it removes any prior handler via a data-initialized sentinel.
export function initThemeToggle(button: HTMLButtonElement): void {
  if (button.dataset.themeToggleInitialized === 'true') return;
  button.dataset.themeToggleInitialized = 'true';
  button.addEventListener('click', () => {
    toggleTheme(document, localStorage, (q) => window.matchMedia(q));
  });
}
