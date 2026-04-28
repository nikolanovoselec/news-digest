// Tests for src/scripts/theme-toggle.ts — REQ-DES-002 (theme persistence,
// localStorage key, data-theme attribute). The module exposes pure helpers
// that take Document/Storage/matchMedia as arguments so these tests don't
// need jsdom — plain mocks suffice under the workerd test pool.

import { describe, it, expect, vi } from 'vitest';
import {
  STORAGE_KEY,
  DATA_ATTR,
  readStoredTheme,
  resolveTheme,
  nextTheme,
  applyTheme,
  persistTheme,
  toggleTheme
} from '../../src/scripts/theme-toggle';

function makeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  const mock: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    }
  };
  return mock;
}

function makeMatchMedia(prefersDark: boolean): (q: string) => MediaQueryList {
  return (query: string) =>
    ({
      matches: prefersDark,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    }) as unknown as MediaQueryList;
}

function makeDoc(): Document {
  const dataset: Record<string, string> = {};
  const style: Record<string, string> = {};
  // Mock <meta name="theme-color"> so applyTheme's status-bar sync
  // path is exercisable without spinning up jsdom. The element only
  // needs the setAttribute hook to record the latest content.
  const metaAttrs: Record<string, string> = {};
  const meta = {
    setAttribute: (k: string, v: string) => {
      metaAttrs[k] = v;
    },
    getAttribute: (k: string) => metaAttrs[k] ?? null,
  };
  const doc = {
    documentElement: {
      dataset,
      style: {
        get backgroundColor(): string {
          return style.backgroundColor ?? '';
        },
        set backgroundColor(v: string) {
          style.backgroundColor = v;
        },
      },
    },
    querySelector: (sel: string) =>
      sel === 'meta[name="theme-color"]' ? meta : null,
  } as unknown as Document;
  return doc;
}

describe('theme-toggle constants', () => {
  it('REQ-DES-002: localStorage key is "theme" to match /theme-init.js', () => {
    expect(STORAGE_KEY).toBe('theme');
  });

  it('REQ-DES-002: the data attribute is "theme" (→ html data-theme)', () => {
    expect(DATA_ATTR).toBe('theme');
  });
});

describe('readStoredTheme', () => {
  it('REQ-DES-002: returns null when nothing is stored', () => {
    const storage = makeStorage();
    expect(readStoredTheme(storage)).toBeNull();
  });

  it('REQ-DES-002: returns "light" or "dark" when a valid value is stored', () => {
    expect(readStoredTheme(makeStorage({ theme: 'light' }))).toBe('light');
    expect(readStoredTheme(makeStorage({ theme: 'dark' }))).toBe('dark');
  });

  it('REQ-DES-002: returns null for any non-light/dark value (defensive)', () => {
    expect(readStoredTheme(makeStorage({ theme: 'blue' }))).toBeNull();
    expect(readStoredTheme(makeStorage({ theme: '' }))).toBeNull();
  });
});

describe('resolveTheme', () => {
  it('REQ-DES-002: stored value wins over system preference', () => {
    const storage = makeStorage({ theme: 'light' });
    expect(resolveTheme(storage, makeMatchMedia(true))).toBe('light');
    const storage2 = makeStorage({ theme: 'dark' });
    expect(resolveTheme(storage2, makeMatchMedia(false))).toBe('dark');
  });

  it('REQ-DES-002: falls back to prefers-color-scheme when no stored value', () => {
    expect(resolveTheme(makeStorage(), makeMatchMedia(true))).toBe('dark');
    expect(resolveTheme(makeStorage(), makeMatchMedia(false))).toBe('light');
  });

  it('REQ-DES-002: queries the correct media query', () => {
    const spy = vi.fn(makeMatchMedia(true));
    resolveTheme(makeStorage(), spy);
    expect(spy).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
  });
});

describe('nextTheme', () => {
  it('REQ-DES-002: light → dark and dark → light', () => {
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('light');
  });
});

describe('applyTheme', () => {
  it('REQ-DES-002: sets html.dataset.theme to the given theme', () => {
    const doc = makeDoc();
    applyTheme(doc, 'dark');
    expect(doc.documentElement.dataset.theme).toBe('dark');
    applyTheme(doc, 'light');
    expect(doc.documentElement.dataset.theme).toBe('light');
  });

  it('REQ-DES-002: also stamps meta[name=theme-color] so the iOS / Android status bar repaints immediately on theme change', () => {
    const doc = makeDoc();
    const meta = doc.querySelector(
      'meta[name="theme-color"]',
    ) as unknown as { getAttribute: (k: string) => string | null };
    applyTheme(doc, 'dark');
    expect(meta.getAttribute('content')).toBe('#0a0a0a');
    applyTheme(doc, 'light');
    expect(meta.getAttribute('content')).toBe('#ffffff');
  });

  it('REQ-DES-002: stamps html.style.backgroundColor with the literal hex so iOS PWA standalone mode does not flash the WKWebView default white through the transparent status bar', () => {
    // CSS `html { background-color: var(--bg) }` requires the cascade
    // to evaluate the custom property; a microsecond gap in that
    // evaluation during Astro ClientRouter swap exposes the underlying
    // WKWebView default (white) when running as an installed PWA. The
    // inline style attribute paints a literal hex regardless of
    // cascade state.
    const doc = makeDoc();
    applyTheme(doc, 'dark');
    expect(doc.documentElement.style.backgroundColor).toBe('#0a0a0a');
    applyTheme(doc, 'light');
    expect(doc.documentElement.style.backgroundColor).toBe('#ffffff');
  });
});

describe('persistTheme', () => {
  it('REQ-DES-002: writes the theme to localStorage under "theme"', () => {
    const storage = makeStorage();
    persistTheme(storage, 'dark');
    expect(storage.getItem('theme')).toBe('dark');
    persistTheme(storage, 'light');
    expect(storage.getItem('theme')).toBe('light');
  });
});

describe('toggleTheme', () => {
  it('REQ-DES-002: toggles dark → light, persists, and applies', () => {
    const doc = makeDoc();
    const storage = makeStorage({ theme: 'dark' });
    const result = toggleTheme(doc, storage, makeMatchMedia(false));
    expect(result).toBe('light');
    expect(doc.documentElement.dataset.theme).toBe('light');
    expect(storage.getItem('theme')).toBe('light');
  });

  it('REQ-DES-002: toggles light → dark, persists, and applies', () => {
    const doc = makeDoc();
    const storage = makeStorage({ theme: 'light' });
    const result = toggleTheme(doc, storage, makeMatchMedia(false));
    expect(result).toBe('dark');
    expect(doc.documentElement.dataset.theme).toBe('dark');
    expect(storage.getItem('theme')).toBe('dark');
  });

  it('REQ-DES-002: when nothing is stored, toggles based on system preference', () => {
    // prefers-color-scheme: dark → current=dark → next=light
    const doc = makeDoc();
    const storage = makeStorage();
    const result = toggleTheme(doc, storage, makeMatchMedia(true));
    expect(result).toBe('light');
    expect(storage.getItem('theme')).toBe('light');
  });

  it('REQ-DES-002: toggle is idempotent when invoked twice (dark→light→dark)', () => {
    const doc = makeDoc();
    const storage = makeStorage({ theme: 'dark' });
    toggleTheme(doc, storage, makeMatchMedia(false));
    const second = toggleTheme(doc, storage, makeMatchMedia(false));
    expect(second).toBe('dark');
    expect(doc.documentElement.dataset.theme).toBe('dark');
    expect(storage.getItem('theme')).toBe('dark');
  });
});
