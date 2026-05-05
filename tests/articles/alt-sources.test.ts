// Tests for src/components/AltSourcesModal.astro — REQ-READ-002.
//
// The modal is a server-rendered Astro component; a vitest worker
// can't fully hydrate its client script, so we validate observable
// contract via a `?raw` source import (same pattern used throughout
// tests/reading/*). The tests assert on the DOM shape, data-*
// hooks, close-on-backdrop semantics, and editorial styling that the
// client script + CSS rely on.

import { describe, it, expect } from 'vitest';

import modalSource from '../../src/components/AltSourcesModal.astro?raw';
// Client behaviour was extracted to src/scripts/alt-sources-modal.ts
// after the CSP inline-script extraction. Some assertions below pin
// script-body content; they target the new module file.
import modalScript from '../../src/scripts/alt-sources-modal.ts?raw';

describe('AltSourcesModal — REQ-READ-002', () => {
  // CF-033: REQ-ID presence theater removed — CI gate covers annotations.

  it('REQ-READ-002: renders a <dialog> element with a list item per alt source', () => {
    // Native <dialog> gives us Escape-to-close + focus-trap + backdrop
    // rendering for free. The alt sources iterate via altSources.map.
    expect(modalSource).toMatch(/<dialog[\s\S]*?data-alt-sources-modal/);
    expect(modalSource).toMatch(/altSources\.map\(/);
    expect(modalSource).toMatch(/<li\s+class="alt-sources-modal__item"/);
  });

  it('REQ-READ-002: first list item marks the primary source', () => {
    // Primary is rendered once at the top of the <ul>, with a data-primary
    // hook + "primary" badge, using the primarySource* props.
    expect(modalSource).toContain('data-primary');
    expect(modalSource).toMatch(/aria-label="primary source"/);
    expect(modalSource).toContain('{primarySourceName}');
    expect(modalSource).toContain('href={primarySourceUrl}');
  });

  it('REQ-READ-002: each <li> has the source name and a <time> element with published_at', () => {
    // Every list item renders the outbound link (as text) and a
    // <time> tag with a machine-readable datetime attribute plus
    // editorial short display.
    expect(modalSource).toMatch(/<time[\s\S]*?datetime=/);
    expect(modalSource).toContain('{formatPublished(s.published_at)}');
    expect(modalSource).toContain('{s.source_name}');
  });

  it('REQ-READ-002: dialog closes on Escape (native behavior)', () => {
    // We rely on the native <dialog> Escape behaviour — the contract
    // is that we use showModal() (which enables Escape-to-cancel) not
    // show() (which does not). Assert showModal is invoked.
    expect(modalScript).toContain('dialog.showModal()');
    // And regression-guard that the non-modal show() is not used.
    expect(modalScript).not.toMatch(/dialog\.show\(\)/);
  });

  it('REQ-READ-002: dialog closes on backdrop click (event.target === dialog)', () => {
    // The canonical pattern: when a click's target is the dialog
    // element itself (not its inner content), close. The inner
    // content is wrapped in an explicit __body div so this check
    // distinguishes the click surfaces reliably.
    expect(modalScript).toMatch(/event\.target\s*===\s*dialog/);
    expect(modalScript).toContain('dialog.close()');
    // The body class hook is in the template, not the script.
    expect(modalSource).toContain('alt-sources-modal__body');
  });

  it('REQ-READ-002: dialog closes when the × button is clicked', () => {
    // The close button is hooked by data-alt-sources-close and its
    // click handler calls dialog.close().
    expect(modalSource).toContain('data-alt-sources-close');
  });

  it('REQ-READ-002: client script tears down listeners on astro:before-swap', () => {
    // View Transitions swap pages without a full reload, so stale
    // listeners accumulate unless explicitly torn down.
    expect(modalScript).toContain('astro:before-swap');
    expect(modalScript).toContain('teardownModal');
    expect(modalScript).toContain('removeEventListener');
  });

  it('REQ-READ-002: editorial styling reuses global theme tokens', () => {
    // Modal must not hard-code colours — only reuse CSS custom
    // properties from src/styles/global.css. Pin the key tokens so a
    // future refactor that hard-codes a hex triggers the test.
    expect(modalSource).toContain('var(--bg)');
    expect(modalSource).toContain('var(--text)');
    expect(modalSource).toContain('var(--text-muted)');
    expect(modalSource).toContain('var(--border)');
    expect(modalSource).toContain('var(--font-serif)');
    // Regression-guard: no hard-coded hex colour codes in the styles.
    expect(modalSource).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });

  it('REQ-READ-002: modal caps width at 32rem and is centred', () => {
    expect(modalSource).toMatch(/max-width:\s*32rem/);
  });
});
