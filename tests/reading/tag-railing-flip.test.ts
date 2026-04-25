// Tests for the shared tag-railing FLIP reorder animation —
// REQ-READ-007. The behaviour lives in three files:
//
//   src/lib/tag-railing-flip.ts — the FLIP helper (capture rects,
//     reorder, invert, play, conditional scroll-follow, lockout).
//   src/components/TagStrip.astro — the pulse keyframe used by the
//     "just-tapped" highlight.
//   src/pages/digest.astro and src/pages/history.astro — the host
//     pages that import the helper and call it from their chip-click
//     handlers.
//
// Tests are string-contains over the `?raw` source rather than DOM
// integration tests because the project's vitest runs in the
// Cloudflare Workers pool with no jsdom. The contract surface here
// (helper export shape, host-page wiring, CSS keyframe presence,
// REQ annotation) is what spec-reviewer's source-vs-test pass relies
// on; a future browser-driven smoke test would cover the literal
// motion.

import { describe, it, expect } from 'vitest';
import flipHelper from '../../src/lib/tag-railing-flip.ts?raw';
import tagStrip from '../../src/components/TagStrip.astro?raw';
import digestPage from '../../src/pages/digest.astro?raw';
import historyPage from '../../src/pages/history.astro?raw';

describe('tag-railing FLIP reorder — REQ-READ-007', () => {
  it('REQ-READ-007: helper exports flipChipToFront and isFlipLocked', () => {
    expect(flipHelper).toMatch(/export\s+(async\s+)?function\s+flipChipToFront/);
    expect(flipHelper).toMatch(/export\s+function\s+isFlipLocked/);
  });

  it('REQ-READ-007: helper uses the FLIP pattern (rect capture, reorder, transform)', () => {
    // Capture phase + reorder + inverse-transform are the three
    // load-bearing primitives — without all three the cascade
    // collapses to the broken jump-cut behaviour the bug report
    // described.
    expect(flipHelper).toContain('getBoundingClientRect');
    expect(flipHelper).toMatch(/insertBefore\([^)]*firstChild/);
    expect(flipHelper).toMatch(/transform\s*=/);
  });

  it('REQ-READ-007: helper applies the just-tapped pulse class for input confirmation (AC 1)', () => {
    expect(flipHelper).toContain('tag-chip--just-tapped');
  });

  it('REQ-READ-007: helper locks the strip while the cascade is in flight (AC 5)', () => {
    // Lock attribute set before reorder, removed after the play
    // phase resolves. Subsequent calls return early via isFlipLocked.
    // The literal attribute name lives in a module-level constant
    // (ANIM_LOCK_ATTR), so we verify both the constant's value and
    // that it's used with set/removeAttribute.
    expect(flipHelper).toContain("'data-tag-flip-locked'");
    expect(flipHelper).toMatch(/setAttribute\(ANIM_LOCK_ATTR/);
    expect(flipHelper).toMatch(/removeAttribute\(ANIM_LOCK_ATTR/);
    expect(flipHelper).toContain('isFlipLocked');
  });

  it('REQ-READ-007: helper does not auto-scroll the strip on tap (AC 6)', () => {
    // The cascade plays in place. The chip may slide off-screen-left
    // when the strip is horizontally scrolled — that's intentional.
    // Regression guard against accidentally re-introducing
    // strip.scrollTo() or any other auto-scroll path.
    expect(flipHelper).not.toContain('scrollTo');
    expect(flipHelper).not.toContain('animateScrollTo');
    // The scrollLeft snapshot/restore around insertBefore is allowed
    // and necessary — it defeats the browser's IMPLICIT auto-scroll
    // on focus / scroll-snap mutation. Verify it's still there.
    expect(flipHelper).toContain('savedScrollLeft');
  });

  it('REQ-READ-007: helper bails to instant reorder when prefers-reduced-motion is set (AC 8)', () => {
    expect(flipHelper).toContain('prefers-reduced-motion');
  });

  it('REQ-READ-007: TagStrip.astro ships the pop keyframe used by the just-tapped class (AC 1)', () => {
    expect(tagStrip).toMatch(/@keyframes\s+tagChipPop/);
    expect(tagStrip).toContain('.tag-chip--just-tapped');
  });

  it('REQ-READ-007: digest.astro chip-click path uses the flip helper instead of bare insertBefore', () => {
    // Regression guard: the host page must NOT reach DOM order
    // through `strip.insertBefore(chip, strip.firstChild)` from the
    // tap path; the helper owns that sequence so the FLIP runs.
    expect(digestPage).toContain('flipChipToFront');
  });

  it('REQ-READ-007: history.astro chip-click path uses the flip helper', () => {
    expect(historyPage).toContain('flipChipToFront');
  });

  it('REQ-READ-007: helper annotates itself with the REQ id', () => {
    expect(flipHelper).toContain('REQ-READ-007');
  });
});
