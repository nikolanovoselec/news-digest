// Tests for REQ-READ-006 — empty, error, and offline pages.
//
// Covers the 404 + 500 error surfaces shipped in src/pages/404.astro
// and src/pages/500.astro. The offline banner behaviour lives in
// digest.astro and is covered by tests/reading/digest-page.test.ts;
// here we only validate the two dedicated error pages.

import { describe, it, expect } from 'vitest';
import notFoundSource from '../../src/pages/404.astro?raw';
import serverErrorSource from '../../src/pages/500.astro?raw';

describe('src/pages/404.astro - REQ-READ-006 AC 5 / REQ-DES-001 (editorial-aesthetic error page)', () => {
  it('REQ-READ-006: renders the literal 404 code in an aria-labelled heading', () => {
    // Users need to know what kind of error they hit at a glance —
    // "404" must appear as the oversized numeral, not buried in body
    // copy, so it can anchor a glance-and-leave recovery.
    expect(notFoundSource).toMatch(/<h1[^>]*aria-label="404 Not Found"[^>]*>\s*404\s*<\/h1>/);
  });

  it('REQ-READ-006: routes unauthenticated visitors to "Back to home" (public recovery path)', () => {
    // The 404 is the only error the landing page reaches — it MUST
    // offer a link back to "/" because anyone hitting a bad URL is
    // by definition not inside an authenticated flow.
    expect(notFoundSource).toMatch(/href="\/"/);
    expect(notFoundSource).toContain('Back to home');
  });

  it('REQ-READ-006: passes noindex=true so search engines don\'t index broken URLs', () => {
    expect(notFoundSource).toContain('noindex={true}');
  });

  it('REQ-READ-006: title prop renders into <title> as "Not found — News Digest"', () => {
    expect(notFoundSource).toContain('title="Not found"');
  });

  it('REQ-READ-006: body text explains what happened without leaking technical detail', () => {
    // Human-readable sentence, no stack trace, no route name, no
    // internal error code — AC 2 of REQ-READ-006 forbids prose
    // detail leaking from the underlying error.
    expect(notFoundSource).toMatch(/doesn't point at anything|doesn't exist/);
    expect(notFoundSource).not.toMatch(/Error\s*:\s*[A-Z0-9_]{6,}/);
    expect(notFoundSource).not.toMatch(/at\s+[A-Z][a-z]+\./); // stack-trace-like frames
  });

  it('REQ-READ-006: CTA target is a link element, not a script-driven button (works with JS off)', () => {
    // The recovery path MUST function without client JS — otherwise
    // an offline / JS-disabled user on 404 has no way back.
    expect(notFoundSource).toMatch(/<a\s[^>]*class="error-page__primary"/);
    expect(notFoundSource).not.toMatch(/onclick|addEventListener.*'click'/);
  });
});

describe('src/pages/500.astro - REQ-READ-006 AC 5 / REQ-DES-001 (editorial-aesthetic error page)', () => {
  it('REQ-READ-006: renders the literal 500 code with aria-label', () => {
    expect(serverErrorSource).toMatch(/<h1[^>]*aria-label="500 Server Error"[^>]*>\s*500\s*<\/h1>/);
  });

  it('REQ-READ-006: 500 page also noindex so transient failures don\'t reach search results', () => {
    expect(serverErrorSource).toContain('noindex={true}');
  });

  it('REQ-READ-006: message says the issue is server-side, reassures recovery via reload', () => {
    // AC 2 — users need to know "this isn't my fault" and how to
    // self-recover. The copy has to stay positive + actionable.
    expect(serverErrorSource).toMatch(/on our end|server couldn't|try again/i);
  });

  it('REQ-READ-006: 500 CTA is the same hardened anchor (JS-independent recovery)', () => {
    expect(serverErrorSource).toMatch(/<a\s[^>]*class="error-page__primary"[^>]*href="\/"/);
  });

  it('REQ-READ-006: no user-controlled data interpolated (defence against log-injection via error pages)', () => {
    // Astro `{…}` interpolation is auto-escaped, but we also want
    // no `set:html` on the error pages — the page is a static shell.
    expect(serverErrorSource).not.toContain('set:html');
  });
});

describe('error pages share the editorial aesthetic — REQ-READ-006 + REQ-DES-001', () => {
  it('REQ-READ-006: both pages use the same oversized serif numeral hero', () => {
    // Visual consistency is the point of having two separate pages
    // instead of one generic error. A future regression that makes
    // 500.astro diverge from 404.astro's layout should trip this.
    expect(notFoundSource).toMatch(/error-page__code/);
    expect(serverErrorSource).toMatch(/error-page__code/);
  });

  it('REQ-READ-006: both pages declare the serif font via --font-serif token', () => {
    expect(notFoundSource).toContain('var(--font-serif)');
    expect(serverErrorSource).toContain('var(--font-serif)');
  });

  it('REQ-READ-006: min-height keeps the error pane centered inside the viewport', () => {
    // Without an explicit min-height the pane would collapse to the
    // height of its text and sit hugging the top of main, which
    // looks broken on desktop. calc(100svh - 14rem) accounts for
    // sticky-header (~60px) + footer (~80px) per REQ-READ-006 AC 4.
    expect(notFoundSource).toMatch(/min-height:\s*calc\(100svh/);
    expect(serverErrorSource).toMatch(/min-height:\s*calc\(100svh/);
  });
});
