// Tests for REQ-SET-002 AC 2/4/7/8 — the tag-strip curation surface
// that lives on /digest (the reading page, not /settings).
//
// Server-side coverage (validation, normalisation, 25-tag cap) lives in
// tests/settings/api.test.ts. The DOM behaviour (click flips
// aria-pressed, DELETE fires only from the × button, applyFilter runs
// after toggle) is covered by Playwright at
// tests/e2e/tag-curation.spec.ts — the chip-toggle state machine is
// DOM-coupled (state lives in aria-pressed + `.is-selected` class) and
// is not extractable as a pure function for vitest. This file restricts
// itself to the markup-level contracts: which attributes/classes must
// exist, which literal user-facing strings must render, and the
// non-nested-form invariant.

import { describe, it, expect } from 'vitest';
import tagStrip from '../../src/components/TagStrip.astro?raw';
import settingsPage from '../../src/pages/settings.astro?raw';
import digestCard from '../../src/components/DigestCard.astro?raw';
import digestPageAstro from '../../src/pages/digest.astro?raw';
import { RESTORE_DEFAULTS_LABEL } from '~/lib/default-hashtags';

describe('tag strip markup contract — REQ-SET-002 AC 2', () => {
  it('REQ-SET-002: every tag chip starts with aria-pressed for a11y toggle semantics', () => {
    // aria-pressed is the screen-reader-visible toggle marker; any
    // chip lacking it won't announce its selected-ness.
    expect(tagStrip).toMatch(/data-tag-chip[\s\S]{0,500}aria-pressed/);
  });

  it('REQ-SET-002: chip has a separate data-tag-remove affordance for the × click', () => {
    // AC 2 requires two distinct click targets on the same chip:
    // body → toggle selection, × → delete. The × MUST be its own
    // element so stopPropagation + the two handlers are unambiguous.
    expect(tagStrip).toMatch(/data-tag-remove/);
    expect(tagStrip).toMatch(/tag-chip__remove/);
  });
});

describe('digest grid filter contract — REQ-SET-002 AC 7', () => {
  it('REQ-SET-002: DigestCard exposes its tag list via data-tags so the filter can walk', () => {
    // AC 7 filter is client-side; each card's tags are serialised
    // as a comma-separated string in data-tags.
    expect(digestCard).toMatch(/data-tags=/);
  });

  it('REQ-SET-002: digest cards carry [data-digest-card] for the filter walk', () => {
    // The filter walker selects [data-digest-card] elements. If the
    // component stops emitting this attribute the filter silently
    // no-ops.
    expect(digestCard).toContain('data-digest-card');
  });

  it('REQ-SET-002: empty-intersection region renders the "No stories match" message', () => {
    // AC 7 — when every card is filtered out, show a short message.
    // The exact string is a UX-visible contract.
    expect(digestPageAstro).toContain('No stories match');
    expect(digestPageAstro).toContain('data-tag-nomatch');
  });
});

describe('Restore initial tags action - REQ-SET-002 AC 8 / REQ-SET-008 (restore-defaults action)', () => {
  it('REQ-SET-002: settings exposes a button labelled via RESTORE_DEFAULTS_LABEL', () => {
    // The label renders from the RESTORE_DEFAULTS_LABEL constant, so
    // the raw source either shows the literal string or the JSX
    // interpolation `{RESTORE_DEFAULTS_LABEL}`. Accept either —
    // what matters is that the button uses the shared constant, not
    // a divergent hardcoded copy.
    const hasLiteral = settingsPage.includes(RESTORE_DEFAULTS_LABEL);
    const hasInterpolation = settingsPage.includes('RESTORE_DEFAULTS_LABEL');
    expect(
      hasLiteral || hasInterpolation,
      `neither "${RESTORE_DEFAULTS_LABEL}" nor RESTORE_DEFAULTS_LABEL found`,
    ).toBe(true);
  });

  it('REQ-SET-002: restore action uses a native <form> POST to /api/tags/restore', () => {
    // Native form POST is the project's canonical pattern for
    // state-changing buttons — it works even if the JS bundle fails.
    expect(settingsPage).toMatch(
      /<form[^>]+method="post"[^>]+action="\/api\/tags\/restore"/,
    );
  });

  it('REQ-SET-002: restore form carries data-restore-form so JS can attach its "Restoring…" label handler', () => {
    expect(settingsPage).toContain('data-restore-form');
  });

  it('REQ-SET-002: restore form is NOT nested inside the main settings form (nested-form regression guard)', () => {
    // Historical bug: the restore button sat inside the settings
    // <form>, so the browser submitted the OUTER form on click and
    // redirected to /settings?time=08:30. Guard: the restore form's
    // opening <form> tag appears AFTER the main settings form's
    // </form> closing tag.
    const mainFormClose = settingsPage.indexOf(
      '</form>',
      settingsPage.indexOf('data-settings-form'),
    );
    const restoreAction = settingsPage.indexOf('/api/tags/restore');
    expect(mainFormClose).toBeGreaterThan(-1);
    expect(restoreAction).toBeGreaterThan(-1);
    expect(restoreAction).toBeGreaterThan(mainFormClose);
  });
});
