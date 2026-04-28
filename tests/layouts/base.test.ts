// Tests for the layout's view-transition wiring. The behaviour
// originally lived inline in src/layouts/Base.astro but the site's
// CSP (`script-src 'self'`) silently blocked every inline `<script>`
// block, dropping the morph animation and the per-path scroll
// restore on the floor. The fix moves the code into
// src/scripts/page-effects.ts so Astro emits it as an external
// bundle (CSP-allowed) and the layout's `<script>` block becomes a
// single `import '~/scripts/page-effects'`.
//
// We pin THREE things now:
//   1. Base.astro imports the external module — without that the
//      whole thing is dead code at runtime.
//   2. The external module wires up preOpenHistoryDayInIncomingDocument
//      and the after-swap sync scroll restore.
//   3. Base.astro keeps the [data-vt-active] CSS rule that depends
//      on the dataset flag toggled by the module.

import { describe, it, expect } from 'vitest';

import baseSource from '../../src/layouts/Base.astro?raw';
import effectsSource from '../../src/scripts/page-effects.ts?raw';

describe('Base.astro / page-effects.ts — view-transition wiring (REQ-DES-003 / REQ-HIST-001)', () => {
  it('Base.astro references /scripts/page-effects.js as a static-served module so CSP allows it', () => {
    // The site CSP is `script-src 'self'`. Astro 5 directRenderScript
    // INLINES `<script>import './module';</script>` bundles regardless
    // of size, and the inline emit is then blocked at runtime. The
    // workaround is to reference public/scripts/page-effects.js with
    // is:inline so Astro renders the tag verbatim — no processing, no
    // inlining, just a same-origin <script src=> the browser fetches
    // straight from the static asset pipeline.
    //
    // Pin attributes independently so a prettier or hand reorder
    // (alphabetical, etc.) doesn't break the test on a no-op format
    // commit.
    const tag = baseSource.match(/<script\b[^>]*src="\/scripts\/page-effects\.js"[^>]*>\s*<\/script>/);
    expect(tag, 'expected a <script src="/scripts/page-effects.js"> tag in Base.astro').not.toBeNull();
    const t = tag?.[0] ?? '';
    expect(t).toMatch(/\bis:inline\b/);
    expect(t).toMatch(/type="module"/);
  });

  it('page-effects.ts registers preOpenHistoryDayInIncomingDocument as an astro:before-swap listener', () => {
    expect(effectsSource).toContain('preOpenHistoryDayInIncomingDocument');
    // Regex spans newlines because the call is multi-line in the
    // source: `addEventListener(\n  'astro:before-swap',\n  preOpen...,\n);`
    expect(effectsSource).toMatch(
      /addEventListener\([\s\S]{0,80}['"]astro:before-swap['"][\s\S]{0,80}preOpenHistoryDayInIncomingDocument/,
    );
  });

  it('page-effects.ts reads the saved sessionStorage day-state key matching history.astro', () => {
    // The on-page restore in history.astro and the pre-open in the
    // shared module must agree on the storage key — drift would
    // silently make the morph animation disappear again.
    expect(effectsSource).toContain("'history:last-day-state'");
  });

  it('page-effects.ts toggles the data-vt-active flag on astro:before-preparation and clears it on astro:after-swap', () => {
    // Set on before-preparation so the snapshot is captured with the
    // header already in its opaque state.
    expect(effectsSource).toMatch(
      /astro:before-preparation[\s\S]{0,200}vtActive/,
    );
    // Clear on after-swap so normal scroll restores the frosted-glass
    // look. A half-fix that sets but never clears would leave the
    // header solid permanently after the first navigation.
    expect(effectsSource).toMatch(
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

  it('site-header base style is fully opaque — no translucent bleed of scrolled content', () => {
    // The user reported scrolled article body text bleeding through
    // the header on detail-back nav even AFTER the view transition
    // settled. The previous frosted-glass base (88% + backdrop-blur)
    // looked tasteful but was the source of the bleed in steady
    // state. Pin solid `var(--bg)` on the base rule so a regression
    // that re-introduces transparency is caught immediately.
    //
    // The block extraction is anchored on the indentation Astro emits
    // for the layout's <style> children (6 leading spaces, then '}'
    // alone on a line). The earlier non-greedy form silently captured
    // the wrong closing brace when nested at-rules were present.
    const headerRule = baseSource.match(
      /\n      \.site-header\s*\{([\s\S]*?)\n      \}/,
    );
    expect(headerRule, 'expected a .site-header rule in Base.astro').not.toBeNull();
    const block = headerRule?.[1] ?? '';
    expect(block).toMatch(/background-color:\s*var\(--bg\)\s*;/);
    // Translucent backgrounds (color-mix with transparent, rgba/hsla
    // with alpha < 1 in either comma- or slash-separated form,
    // decimal or percentage) all produce the bleed and must stay out.
    // The previous `[^)]*transparent` form silently passed against
    // the just-removed `color-mix(in oklab, var(--bg) 88%, transparent)`
    // because `[^)]*` halted at the inner `)` of `var(--bg)` before
    // reaching `transparent`. Use a non-anchored substring match.
    expect(block).not.toMatch(/color-mix\b[\s\S]*?\btransparent\b[\s\S]*?\)/);
    expect(block).not.toMatch(
      /\b(?:rgba?|hsla?)\([^;]*(?:,\s*0?\.[0-9]+|\/\s*0?\.[0-9]+|\/\s*[0-9]{1,2}\s*%)\s*\)/,
    );
    // backdrop-filter on an opaque bg has no visible effect; its
    // presence is a code smell that the bg was meant to be
    // translucent. Reject both the standard and the -webkit-prefixed
    // form on the base rule so a partial revert can't slip through
    // on iOS Safari.
    expect(block).not.toMatch(/(?:^|\s|;)(?:-webkit-)?backdrop-filter:/);
  });

  it('::view-transition-group(site-header) is painted with var(--bg) and old/new snapshots skip the cross-fade so the header stays solid mid-transition', () => {
    // Even with a solid base background, the BROWSER cross-fades the
    // OLD and NEW site-header snapshots when the named transition
    // group activates: each ends up at ~50% opacity halfway through,
    // alpha-composing to ~75% combined opacity, which is what the
    // user saw bleeding scrolled body text through the "black bar"
    // on detail-back nav. Painting the GROUP container with var(--bg)
    // gives the cross-fade a solid backstop, and `animation: none` on
    // both pseudo-elements collapses the visual to a single steady-
    // state header — correct, because the chrome is identical on
    // every page and there is nothing to morph.
    expect(baseSource).toMatch(
      /::view-transition-group\(site-header\)\s*\{[\s\S]{0,200}background-color:\s*var\(--bg\)/,
    );
    expect(baseSource).toMatch(
      /::view-transition-old\(site-header\)\s*\{[\s\S]{0,80}animation:\s*none/,
    );
    expect(baseSource).toMatch(
      /::view-transition-new\(site-header\)\s*\{[\s\S]{0,80}animation:\s*none/,
    );
  });

  it('::view-transition-group(site-header) carries an explicit z-index so morphing cards never paint over the header', () => {
    // Z-order in the view-transition layer follows DOM order of named
    // groups by default. Every digest card has `transition:name=card-...`
    // and lives inside <main>, AFTER the site-header in the body, so the
    // browser paints each card group ABOVE the site-header group while
    // its position interpolates between the article-detail title (top
    // of the page) and the card's natural position in the digest list.
    // Mid-flight the card crosses the header zone and the user sees the
    // card text "popping through" the header. An explicit z-index on
    // the header group keeps the chrome on top regardless of DOM order.
    expect(baseSource).toMatch(
      /::view-transition-group\(site-header\)\s*\{[\s\S]{0,200}z-index:\s*\d+/,
    );
  });

  it('synchronously restores scroll on astro:after-swap so view-transition snapshots include below-fold cards', () => {
    // Without an in-callback scroll restore, the View-Transition
    // snapshot of the new page is captured at scrollY=0. Any card
    // outside the initial viewport (e.g. a /history card buried
    // inside an expanded day deep in the 14-day list) is dropped
    // from the snapshot and the morph silently no-ops.
    //
    // The async page-load tick loop still runs to handle lazy-image
    // and filter-driven layout reflow, but it cannot replace the
    // sync restore — by the time page-load fires, the snapshot is
    // already captured.
    expect(effectsSource).toMatch(
      /astro:after-swap[\s\S]{0,400}window\.scrollTo\(\s*0\s*,\s*target\s*\)/,
    );
  });
});
