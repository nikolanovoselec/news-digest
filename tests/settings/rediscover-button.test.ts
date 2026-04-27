// Tests for the settings.astro "Discover missing sources" button —
// REQ-DISC-004 AC 1 (single-bulk-button reshape).
//
// The button renders only when at least one of the user's tags has a
// `sources:{tag}` KV entry with an empty `feeds` array. A brand-new
// tag (no KV entry yet) must NOT trip the button — that's the
// "discovery still pending" case, not "stuck". A single click posts
// to /api/admin/discovery/retry-bulk and re-queues every empty-feed tag.

import { describe, it, expect } from 'vitest';
import settingsPage from '../../src/pages/settings.astro?raw';

describe('settings.astro Discover-missing-sources button — REQ-DISC-004', () => {
  it('REQ-DISC-004: settings.astro computes emptyFeedTags by reading sources:{tag} entries', () => {
    // The file must batch-read the `sources:{tag}` KV entry for each
    // user tag and push tags whose parsed value has `feeds.length === 0`.
    expect(settingsPage).toContain('emptyFeedTags');
    expect(settingsPage).toContain('sources:${tag}');
    // Parse gate: feeds must be explicitly array-empty (not undefined).
    expect(settingsPage).toMatch(/Array\.isArray\(feeds\)[\s\S]*?feeds\.length === 0/);
  });

  it('REQ-DISC-004: the Stuck-tags fieldset renders only when emptyFeedTags.length > 0', () => {
    // Regression guard against always-rendering the section.
    expect(settingsPage).toMatch(/emptyFeedTags\.length > 0[\s\S]*?Stuck tags/);
  });

  it('REQ-DISC-004: a single bulk form posts to /api/admin/discovery/retry-bulk', () => {
    // No per-tag forms anymore. Exactly one form, action set to the
    // bulk endpoint, no hidden `tag` input (the server enumerates).
    expect(settingsPage).toContain('action="/api/admin/discovery/retry-bulk"');
    expect(settingsPage).toMatch(
      /method="post"[\s\S]*?action="\/api\/admin\/discovery\/retry-bulk"/,
    );
  });

  it('REQ-DISC-004: per-tag form (action="/api/admin/discovery/retry") is no longer rendered from settings.astro', () => {
    // Regression guard against an accidental partial revert that leaves
    // both the per-tag loop AND the bulk button on the page. The bulk
    // form's action ends with "retry-bulk", so an exact-string guard
    // protects against the per-tag-only path while letting the bulk
    // path through.
    expect(settingsPage).not.toMatch(/action="\/api\/admin\/discovery\/retry"/);
  });

  it('REQ-DISC-004: button label is "Discover missing sources"', () => {
    expect(settingsPage).toContain('Discover missing sources');
    // Old per-tag label must be gone.
    expect(settingsPage).not.toContain('Re-discover #{tag}');
  });

  it('REQ-DISC-004: confirmation banner reads the count query param', () => {
    expect(settingsPage).toContain('rediscoverConfirmedCount');
    expect(settingsPage).toContain("'rediscover'");
    expect(settingsPage).toContain("'count'");
  });

  it('REQ-DISC-004: settings.astro annotates itself with the REQ id', () => {
    // Spec-reviewer greps for the annotation to link code → REQ.
    expect(settingsPage).toContain('REQ-DISC-004');
  });

  it('REQ-DISC-006: stuck-tag list renders the actual hashtag names (not just a count)', () => {
    // The user must see WHICH tags are stuck — not just "1 tag has no
    // working feeds". The page renders each emptyFeedTag as a chip in
    // a labelled list.
    expect(settingsPage).toContain('settings__stuck-tag-list');
    expect(settingsPage).toContain('settings__stuck-tag-chip');
    expect(settingsPage).toMatch(/emptyFeedTags\.map\(\(tag\)/);
    // The chip text starts with `#` so the user sees `#eldenring` not
    // bare `eldenring`.
    expect(settingsPage).toContain('#{tag}');
  });

  it('REQ-DISC-006: card explains the 7-day auto-removal so the user knows what happens next', () => {
    expect(settingsPage).toMatch(/7 days/);
    expect(settingsPage).toMatch(/automatic|automatically/);
  });
});
