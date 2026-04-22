// Tests for src/styles/global.css — REQ-DES-001, REQ-DES-002, REQ-DES-003.
// The CSS file is imported as a raw string (Vite ?raw) so we can smoke-test
// that the required custom properties and utilities are actually defined.
// This is not a substitute for visual QA but it catches accidental deletions
// of the token contract (e.g. a refactor that drops --accent).

import { describe, it, expect } from 'vitest';
// The Workers test pool doesn't ship public/ + src/ as a filesystem. Vite's
// `?raw` suffix inlines the file as a module export at build time, which
// bypasses both the Tailwind transform AND the missing-fs issue.
// eslint-disable-next-line import/no-unresolved
import cssSource from '../../src/styles/global.css?raw';

describe('design tokens in global.css', () => {
  it('REQ-DES-001: declares the five type-scale sizes (12, 14, 16, 20, 32 px)', () => {
    expect(cssSource).toMatch(/--text-xs:\s*12px/);
    expect(cssSource).toMatch(/--text-sm:\s*14px/);
    expect(cssSource).toMatch(/--text-base:\s*16px/);
    expect(cssSource).toMatch(/--text-lg:\s*20px/);
    expect(cssSource).toMatch(/--text-2xl:\s*32px/);
  });

  it('REQ-DES-001: uses the system font stack with Inter fallback', () => {
    expect(cssSource).toContain('-apple-system');
    expect(cssSource).toContain('BlinkMacSystemFont');
    expect(cssSource).toContain("'Segoe UI'");
    expect(cssSource).toContain('Inter');
    expect(cssSource).toContain('sans-serif');
  });

  it('REQ-DES-001: inputs are 16 px font-size to prevent iOS zoom-on-focus', () => {
    // Rule body contains font-size using --text-base (which is 16px).
    expect(cssSource).toMatch(
      /input,\s*textarea,\s*select\s*\{[^}]*font-size:\s*var\(--text-base\)/
    );
  });

  it('REQ-DES-001: interactive elements have 44x44 minimum touch target', () => {
    expect(cssSource).toMatch(/min-width:\s*44px/);
    expect(cssSource).toMatch(/min-height:\s*44px/);
  });

  it('REQ-DES-001: :focus-visible ring uses accent color', () => {
    expect(cssSource).toContain(':focus-visible');
    expect(cssSource).toMatch(/outline:\s*2px\s+solid\s+var\(--accent\)/);
    expect(cssSource).toMatch(/outline-offset:\s*2px/);
  });

  it('REQ-DES-001: focus-ring utility class is defined for custom targets', () => {
    expect(cssSource).toContain('.focus-ring:focus-visible');
  });

  it('REQ-DES-002: defines light theme tokens (bg, surface, text, text-muted, border, accent)', () => {
    const rootBlock = cssSource.match(/:root\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rootBlock).toMatch(/--bg:/);
    expect(rootBlock).toMatch(/--surface:/);
    expect(rootBlock).toMatch(/--text:/);
    expect(rootBlock).toMatch(/--text-muted:/);
    expect(rootBlock).toMatch(/--border:/);
    expect(rootBlock).toMatch(/--accent:/);
  });

  it('REQ-DES-002: defines dark theme tokens under [data-theme="dark"]', () => {
    const darkBlock = cssSource.match(/\[data-theme=['"]dark['"]\]\s*\{[^}]*\}/)?.[0] ?? '';
    expect(darkBlock).toMatch(/--bg:/);
    expect(darkBlock).toMatch(/--surface:/);
    expect(darkBlock).toMatch(/--text:/);
    expect(darkBlock).toMatch(/--text-muted:/);
    expect(darkBlock).toMatch(/--border:/);
    expect(darkBlock).toMatch(/--accent:/);
  });

  it('REQ-DES-003: declares a single easing curve cubic-bezier(0.22, 1, 0.36, 1)', () => {
    expect(cssSource).toMatch(
      /--ease:\s*cubic-bezier\(\s*0\.22\s*,\s*1\s*,\s*0\.36\s*,\s*1\s*\)/
    );
  });

  it('REQ-DES-003: declares duration tokens 150ms, 250ms, 400ms', () => {
    expect(cssSource).toMatch(/--duration-fast:\s*150ms/);
    expect(cssSource).toMatch(/--duration-base:\s*250ms/);
    expect(cssSource).toMatch(/--duration-slow:\s*400ms/);
  });

  it('REQ-DES-003: motion is gated on prefers-reduced-motion: no-preference', () => {
    expect(cssSource).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*no-preference\s*\)/);
  });

  it('REQ-DES-003: under reduce, transitions collapse to 0s', () => {
    // Presence of both the reduce media query and the 0s overrides is enough
    // for a smoke test — we do not reparse the CSS AST here.
    expect(cssSource).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
    expect(cssSource).toMatch(/transition-duration:\s*0s/);
    expect(cssSource).toMatch(/animation-duration:\s*0s/);
  });

  it('REQ-DES-001: provides safe-area-inset helpers for iOS notches', () => {
    expect(cssSource).toContain('.safe-top');
    expect(cssSource).toContain('.safe-bottom');
    expect(cssSource).toContain('env(safe-area-inset-top)');
    expect(cssSource).toContain('env(safe-area-inset-bottom)');
  });
});
