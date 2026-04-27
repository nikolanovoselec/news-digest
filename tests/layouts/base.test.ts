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
    expect(baseSource).toMatch(
      /<script\s+is:inline\s+type="module"\s+src="\/scripts\/page-effects\.js"\s*>\s*<\/script>/,
    );
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
