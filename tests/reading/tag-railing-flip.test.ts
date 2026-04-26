// Tests for the shared tag-railing FLIP reorder animation —
// REQ-READ-007. The behaviour lives in three files:
//
//   src/lib/tag-railing-flip.ts — the FLIP helper (capture rects,
//     reorder, invert, play, scroll-position preservation, lockout).
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
    expect(flipHelper).toMatch(/insertBefore\([^)]*beforeNode/);
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
    // strip.scrollTo() in the cascade path.
    expect(flipHelper).not.toContain('scrollTo');
    // The scrollLeft snapshot/restore around insertBefore is allowed
    // and necessary — it defeats the browser's IMPLICIT auto-scroll
    // on focus / scroll-snap mutation. Verify it's still there.
    expect(flipHelper).toContain('savedScrollLeft');
  });

  it('REQ-READ-007: cascade duration scales with the chip\'s visible-fraction of travel (AC 3)', () => {
    // The play-phase duration is derived so the on-screen portion of
    // the chip's journey takes ~TARGET_VISIBLE_CROSSING_MS, regardless
    // of total travel distance. Far chips (most of journey off-screen)
    // get longer total durations so the visible window stays trackable.
    expect(flipHelper).toContain('TARGET_VISIBLE_CROSSING_MS');
    expect(flipHelper).toContain('visibleFraction');
    expect(flipHelper).toContain('MIN_CASCADE_MS');
    expect(flipHelper).toContain('MAX_CASCADE_MS');
  });

  it("REQ-READ-007: cascade easing is 'linear' on every chip (post UX-eval)", () => {
    // Earlier per-chip ease-IN/ease-OUT was removed after UX evaluation
    // — uniform 'linear' easing feels more consistent across chips that
    // travel different distances. Regression guard against the old
    // distinction sneaking back in.
    expect(flipHelper).toMatch(/transition\s*=\s*`transform\s*\$\{[^}]+\}ms\s+linear`/);
    expect(flipHelper).not.toContain('EASE_IN');
    expect(flipHelper).not.toContain('EASE_OUT');
    expect(flipHelper).not.toContain('tappedEndsOffScreen');
  });

  it('REQ-READ-007: arms a one-shot scroll-down reveal after the cascade (AC 6)', () => {
    // After the cascade settles, the next downward window-scroll
    // smooth-animates strip.scrollLeft → 0 so the user sees the
    // just-selected chip docked at slot 0 as they begin to read
    // the dashboard. One-shot per cascade; cancellable on user
    // swipe of the strip.
    expect(flipHelper).toContain('armScrollDownReveal');
    expect(flipHelper).toMatch(/window\.addEventListener\(['"]scroll['"]/);
    expect(flipHelper).toMatch(/delta\s*<=\s*0/);
    expect(flipHelper).toContain('animateStripScrollTo');
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

  it('REQ-READ-007: helper exports flipChipToPosition for arbitrary destinations (AC 3 unselect)', () => {
    // The unselect cascade slides the chip to its natural sort
    // position rather than slot 0, so the helper must accept a
    // destination beforeNode parameter (null = append-to-end).
    // flipChipToFront stays as a thin wrapper over flipChipToPosition.
    expect(flipHelper).toMatch(/export\s+(async\s+)?function\s+flipChipToPosition/);
    expect(flipHelper).toMatch(/beforeNode/);
  });

  it('REQ-READ-007: digest.astro un-select branch calls flipChipToPosition with a computed beforeNode (AC 3)', () => {
    // The unselect path must compute the chip's natural position by
    // walking other non-selected chips and finding the first one
    // with strictly lower priority (lower count, or same count +
    // alpha-later tag). Pattern guards: a localeCompare reference
    // and a flipChipToPosition call inside the unselect branch.
    expect(digestPage).toContain('flipChipToPosition');
    expect(digestPage).toContain('localeCompare');
  });

  it('REQ-READ-007: history.astro un-select branch calls flipChipToPosition with a computed beforeNode (AC 3)', () => {
    expect(historyPage).toContain('flipChipToPosition');
    expect(historyPage).toContain('localeCompare');
  });

  it('REQ-READ-007: helper measures the tapped chip\'s travel against the strip viewport (AC 3)', () => {
    // The visible-fraction math intersects [tappedFirstLeft,
    // tappedLastLeft] with [stripRect.left, stripRect.right] to figure
    // out how much of the chip's journey is on-screen. Guard against
    // accidentally dropping the strip-rect intersection (which would
    // make every cascade duration land at MIN regardless of travel).
    expect(flipHelper).toContain('tappedFirstLeft');
    expect(flipHelper).toContain('tappedLastLeft');
    expect(flipHelper).toContain('stripRect.left');
    expect(flipHelper).toContain('stripRect.right');
  });

  it('REQ-READ-007: scroll-down reveal arms only when the chip lands at slot 0 (AC 6)', () => {
    // Unselect cascade lands the chip mid-railing — pulling
    // scrollLeft to 0 on the next page scroll would hide the chip
    // the user just operated on. The arm condition must include a
    // strip.firstChild === tappedChip check.
    expect(flipHelper).toMatch(/strip\.firstChild\s*===\s*tappedChip/);
  });

  it('REQ-READ-007: no-op tap (chip already at destination) plays pop only — no hold, no LIFT, no cascade (AC 9)', () => {
    // The bug: tapping the leftmost chip ran the full pop+hold+cascade
    // choreography even though no chip moved. The 1000ms hold sat with
    // the chip pulsing in dead air, and the trailing LIFT_HOLD_MS
    // setTimeout removed the lift class ~1850ms after the tap — long
    // enough that the keyframe re-triggered on some engines, producing
    // a visible "second pop" at the end of the choreography.
    //
    // Fix invariants the helper must honour:
    //   1. Detect the no-op tap by comparing beforeNode against the
    //      tapped chip and its nextSibling — both forms (insertBefore
    //      with the chip itself, or with its right neighbour) leave the
    //      DOM order unchanged.
    //   2. On a no-op tap, add POP_CLASS only — never LIFT_CLASS, since
    //      lift's purpose is to elevate the chip above neighbours it
    //      slides past, and there is no slide.
    //   3. Schedule POP_CLASS removal at exactly 500ms (the keyframe
    //      duration) so a subsequent re-tap can re-trigger the same
    //      animation cleanly.
    //   4. Lock the strip for that 500ms so a re-tap during the pop
    //      doesn't restart the keyframe mid-flight.
    //   5. Return without entering the hold or the cascade phase — no
    //      HOLD_BEFORE_CASCADE_MS await, no FLIP rect capture.
    expect(flipHelper).toMatch(
      /beforeNode\s*!==\s*tappedChip\s*&&\s*beforeNode\s*!==\s*tappedChip\.nextSibling/,
    );
    // The bail-out block must contain the pop class add and a 500ms
    // setTimeout that removes both POP_CLASS and the lock attribute.
    // Plain string match here is sufficient — the helper has only one
    // 500ms setTimeout, so a literal substring assertion pins it.
    expect(flipHelper).toMatch(/classList\.add\(POP_CLASS\)/);
    expect(flipHelper).toMatch(/setAttribute\(ANIM_LOCK_ATTR/);
    expect(flipHelper).toMatch(/}, 500\)/);
    // Critically: LIFT_CLASS must NOT be added on the no-op path.
    // Inspect the source between the wouldMove guard and the early
    // return. Use a non-greedy match so it stops at the first `return`.
    const noOpBlock = flipHelper.match(
      /const wouldMove[\s\S]*?if \(!wouldMove\) \{[\s\S]*?return;\s*\}/,
    );
    expect(noOpBlock).not.toBeNull();
    expect(noOpBlock?.[0]).not.toContain('LIFT_CLASS');
  });
});
