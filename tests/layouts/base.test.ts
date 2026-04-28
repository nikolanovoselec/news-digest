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

  it('site-header brand link is annotated with data-brand-home for the click-to-scroll-top delegate', () => {
    // The wordmark anchor has href="/digest" (or "/" when signed-out)
    // for SSR + no-JS fallback. The click delegate in page-effects.ts
    // targets the data-brand-home attribute so refactoring the CSS
    // class name doesn't break the binding.
    expect(baseSource).toMatch(
      /<a[\s\S]{0,200}site-header__brand[\s\S]{0,200}data-brand-home/,
    );
    expect(baseSource).toMatch(
      /href=\{Astro\.locals\.user\s*\?\s*['"]\/digest['"]\s*:\s*['"]\/['"]/,
    );
  });

  it('page-effects binds a tap handler that intercepts data-brand-home anchors and scrolls to top when already on /digest', () => {
    // Listeners MUST be document capture-phase. Samsung Internet's
    // WebView dispatches the native anchor handler before element-level
    // listeners get the event, so element-bound listeners miss the
    // first 2-3 taps of the session. Capture-phase on `document` fires
    // before WebView's native dispatch and lets us preventDefault.
    // Both click and pointerup are bound for the click-elision fallback.
    expect(effectsSource).toMatch(
      /closest[\s\S]{0,80}a\[data-brand-home\]/,
    );
    expect(effectsSource).toMatch(
      /window\.location\.pathname\s*!==\s*['"]\/digest['"]/,
    );
    expect(effectsSource).toMatch(
      /window\.scrollTo\(\s*\{\s*top:\s*0/,
    );
    expect(effectsSource).toMatch(
      /document\.addEventListener\(\s*\n?\s*['"]click['"][\s\S]{0,400}true\s*,?\s*\)/,
    );
    expect(effectsSource).toMatch(
      /document\.addEventListener\(\s*\n?\s*['"]pointerup['"][\s\S]{0,400}true\s*,?\s*\)/,
    );
    expect(effectsSource).toMatch(/e\.stopPropagation\(\)/);
  });

  it('::view-transition-group(site-header) carries an explicit z-index so the promoted morphing card never paints over the header', () => {
    // Z-order in the view-transition layer follows DOM order of named
    // groups. `src/scripts/page-effects.ts` promotes a single card per
    // navigation via `view-transition-name: card-{slug}` on the
    // matching link — that link lives inside <main>, AFTER the site-
    // header in body order, so the browser paints the card group ABOVE
    // the site-header group while its position interpolates between
    // the article-detail title and the card's natural list position.
    // Without an explicit z-index on the header group the user would
    // see card text popping through the header mid-morph.
    expect(baseSource).toMatch(
      /::view-transition-group\(site-header\)\s*\{[\s\S]{0,200}z-index:\s*\d+/,
    );
  });

  it('page-effects.ts shapes view-transitions to a single named group per navigation (REQ-READ-002 / REQ-HIST-001)', () => {
    // Default-no-name baseline: every DigestCard ships without a
    // `transition:name`. /history can render 100+ cards across opened
    // days, and the browser captures every named element on the page
    // as part of the view-transition pseudo tree — paying O(N)
    // snapshot bookkeeping for a morph that only ever pairs ONE card
    // with the article-detail header. Promoting a single card per
    // navigation collapses bookkeeping to O(1) and (per gpt-5.2's
    // performance analysis) is the dominant lever closing the
    // /history vs /digest sluggishness gap.
    //
    // Forward (overview → detail): on `astro:before-preparation` the
    // sourceElement is the clicked anchor; we walk to the surrounding
    // [data-digest-card], read its slug, and assign
    // `view-transition-name: card-${slug}` on the link before the OLD
    // snapshot is captured.
    expect(effectsSource).toMatch(/promoteSourceCardForOutgoingMorph/);
    expect(effectsSource).toMatch(
      /astro:before-preparation[\s\S]{0,200}promoteSourceCardForOutgoingMorph/,
    );
    expect(effectsSource).toMatch(
      /view-transition-name['"`]\s*,\s*[`'"]card-\$\{slug\}/,
    );
    // Backward (detail → overview): on astro:before-swap we read the
    // outgoing URL (/digest/{id}/{slug}) and locate the matching card
    // in event.newDocument, skipping copies inside hidden ancestors
    // or closed <details> (those aren't in layout, so a name on them
    // has no bbox and the morph degrades).
    expect(effectsSource).toMatch(/promoteIncomingCardForReturnMorph/);
    expect(effectsSource).toMatch(
      /astro:before-swap[\s\S]{0,300}promoteIncomingCardForReturnMorph/,
    );
    expect(effectsSource).toMatch(/ARTICLE_DETAIL_PATH_RE/);
    // Visibility filter: the helper that finds the promotable card
    // skips elements inside [hidden] ancestors and inside closed
    // <details>, otherwise the name lands on an off-layout element
    // and the morph silently degrades to a root cross-fade.
    expect(effectsSource).toMatch(/closest\(['"]\[hidden\]['"]\)/);
    expect(effectsSource).toMatch(/closest[\s\S]{0,40}['"]details['"]/);
    // Cleanup deliberately runs at the START of the NEXT click via
    // `promoteSourceCardForOutgoingMorph`'s clearAllVtNames(document)
    // — NOT on `astro:after-swap`. The View Transitions API captures
    // the NEW snapshot after the update callback resolves; astro:
    // after-swap fires while the callback is still running. Wiping
    // the name there would strip it from the matching card BEFORE
    // the snapshot is taken, breaking the pair and degrading to a
    // root cross-fade. The forward-promotion clear at click time is
    // the right window — the previous transition has long settled.
    expect(effectsSource).toMatch(
      /promoteSourceCardForOutgoingMorph[\s\S]{0,400}clearAllVtNames\(document\)/,
    );
    // Regression guard: must NOT register clearAllVtNames as an
    // astro:after-swap listener.
    expect(effectsSource).not.toMatch(
      /astro:after-swap[\s\S]{0,200}clearAllVtNames/,
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
