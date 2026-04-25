// Implements REQ-READ-007
//
// Shared three-phase choreography for the tag railing on /digest
// and /history. The host pages call `flipChipToFront(strip, chip)`
// from their chip-click handlers; the helper plays:
//
//   PHASE 1 — POP (AC 1): scale-bounce class on the tapped chip for
//     immediate input confirmation. The chip is also lifted via
//     z-index + drop-shadow so it visibly rises above neighbours.
//   PHASE 2 — HOLD (AC 2): a deliberate ~1-second pause where the
//     popped chip sits elevated and nothing else moves, giving the
//     user's eye time to land on the chip before the cascade starts.
//   PHASE 3 — CASCADE (AC 3): classic FLIP — capture rects, move
//     the tapped chip to slot 0, invert displaced chips with an
//     inline transform, then on the next animation frame transition
//     the transform back to zero so the cascade plays out.
//
// The strip is locked via `data-tag-flip-locked` for the full
// pop+hold+cascade so re-entrant taps anywhere in the sequence are
// dropped (AC 5). After the motion settles, the railing
// conditionally scrolls to the start — but ONLY when the strip is
// overflow-scrollable AND the tapped chip's first rect was outside
// the strip's visible box (AC 6). A chip already in view triggers
// no scroll.
//
// When the runtime advertises `prefers-reduced-motion: reduce`,
// the helper performs the reorder instantly and skips the pop,
// hold, and cascade entirely (AC 8).

// Three-phase choreography (deliberately slow so the user sees each
// step distinctly):
//
//   1. POP: the tapped chip scales up with a bounce so the user gets
//      unmistakable feedback that the tap was received. The pop
//      keyframe in TagStrip.astro runs for ~700ms and is the only
//      motion on screen for the first beat.
//   2. HOLD: a one-second pause where nothing else moves. The popped
//      chip stays slightly elevated (z-index lift via the pop class)
//      while the user's eye lands on it, so they know which chip is
//      about to move before the cascade starts.
//   3. CASCADE: the FLIP reorder plays at SLOW_CASCADE_MS — long
//      enough that the eye can track the chip across the railing
//      and see the displaced chips slide right to fill the gap.
//
// Total wall-clock from tap to settled state:
//   ~700ms pop (overlapping the hold) + remaining hold to 1000ms
//     + 800ms cascade  ≈ 1800 ms.
// This is intentionally long. Earlier 220ms / 450ms tunings looked
// like teleportation on real hardware.
// Two classes carry distinct concerns so JS can manage them
// independently. `POP_CLASS` owns the scale-bounce keyframe and is
// removed BEFORE the cascade starts so its CSS animation no longer
// fights the inline `transform: translate(...)` we set for the FLIP
// invert phase. `LIFT_CLASS` owns the z-index + box-shadow and
// stays on for the full pop+hold+cascade so the chip remains visibly
// elevated above its neighbours throughout the motion — without it,
// neighbouring chips would clip the tapped chip's edges as they
// slide past during the cascade.
const POP_CLASS = 'tag-chip--just-tapped';
const LIFT_CLASS = 'tag-chip--in-flight';
const HOLD_BEFORE_CASCADE_MS = 1000;
const SLOW_CASCADE_MS = 800;
// LIFT_CLASS lives slightly longer than the cascade so the elevated
// look settles back to flat AFTER the slide ends.
const LIFT_HOLD_MS = HOLD_BEFORE_CASCADE_MS + SLOW_CASCADE_MS + 100;
const DEFAULT_DURATION_MS = SLOW_CASCADE_MS;
const ANIM_LOCK_ATTR = 'data-tag-flip-locked';

export interface FlipChipOptions {
  /** Cascade animation duration in ms. Defaults to SLOW_CASCADE_MS
   *  (800). The pop and hold phases above the cascade are not
   *  configurable via this option — adjust the module-level
   *  constants if you need to retune them together. */
  durationMs?: number;
  /** Whether to follow the moved chip with a scroll on overflow
   *  viewports. Defaults to true. Pass false to disable scroll
   *  entirely (e.g., wrap layouts already render every chip). */
  followScroll?: boolean;
}

/** True iff a flip animation is currently mid-flight on the given
 *  strip. Host-page tap handlers should consult this and bail out
 *  early so a double-tap doesn't queue a second reorder on top of
 *  the first one (AC 5). */
export function isFlipLocked(strip: HTMLElement): boolean {
  return strip.hasAttribute(ANIM_LOCK_ATTR);
}

/** Reorder `tappedChip` to the start of `strip` with a FLIP cascade.
 *  Resolves once every chip has settled into its final position and
 *  the lock attribute has been cleared. */
export async function flipChipToFront(
  strip: HTMLElement,
  tappedChip: HTMLElement,
  options: FlipChipOptions = {},
): Promise<void> {
  if (isFlipLocked(strip)) return;
  const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
  const followScroll = options.followScroll ?? true;

  // (AC 8) Bail to instant reorder when motion is suppressed. The
  // pop + hold + cascade choreography is purely chrome — when the
  // user has asked for reduced motion we skip it entirely and just
  // commit the new order silently.
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) {
    strip.insertBefore(tappedChip, strip.firstChild);
    return;
  }

  // PHASE 1 — POP + LIFT: scale-bounce keyframe (POP_CLASS) plus
  // z-index/shadow elevation (LIFT_CLASS) added simultaneously. The
  // pop class is removed at cascade start (see PHASE 3) so its
  // animation doesn't fight the FLIP's inline transform. The lift
  // class outlasts the cascade so the chip stays visually above
  // neighbours while it slides.
  tappedChip.classList.add(POP_CLASS, LIFT_CLASS);
  setTimeout(() => tappedChip.classList.remove(LIFT_CLASS), LIFT_HOLD_MS);

  // Lock the strip immediately so any re-entrant tap during the
  // pop / hold / cascade is suppressed. The try/finally below
  // guarantees the lock is cleared even if any DOM op throws.
  strip.setAttribute(ANIM_LOCK_ATTR, '1');
  try {
    // PHASE 2 — HOLD: deliberate pause so the user's eye lands on
    // the popped chip before anything else moves. The chip is still
    // mid-pop while we wait; by the time this resolves the pop
    // keyframe has finished and the chip is back at scale 1.
    await new Promise<void>((resolve) =>
      setTimeout(resolve, HOLD_BEFORE_CASCADE_MS),
    );

    // PHASE 3 — CASCADE: classic FLIP. Capture rects AFTER the
    // hold so the pop's transient transform isn't baked into the
    // FIRST measurement.
    const chips = Array.from(
      strip.querySelectorAll<HTMLElement>('[data-tag-chip]'),
    );
    const firstRects = new Map<HTMLElement, DOMRect>();
    for (const chip of chips) {
      firstRects.set(chip, chip.getBoundingClientRect());
    }

    strip.insertBefore(tappedChip, strip.firstChild);

    // INVERT: for each chip whose position changed by more than half
    // a pixel, set transform so it appears to still be in its old
    // slot. `transition: none` ensures the inverse jump is
    // instantaneous. We also guard against the tapped chip's pop
    // class still emitting a `transform: scale(...)` from its
    // keyframe — the inline transform overrides it.
    const playing: HTMLElement[] = [];
    for (const chip of chips) {
      const first = firstRects.get(chip);
      if (first === undefined) continue;
      const last = chip.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      chip.style.transition = 'none';
      chip.style.transform = `translate(${dx}px, ${dy}px)`;
      playing.push(chip);
    }

    // Fast-exit when nothing actually moved (e.g., the user tapped
    // the chip already in slot 0). Otherwise we'd burn the full
    // backstop window waiting for a transitionend that will never
    // fire, blocking the strip for ~durationMs+100ms with no visual
    // payoff. AC 6 scroll-follow still runs below the try block.
    if (playing.length > 0) {
      // CRITICAL — force the browser to commit the inverse-transform
      // styles BEFORE we set up the transition. Without this synchronous
      // layout read, the browser collapses the "set inverse + transition
      // none" and "clear inverse + transition 800ms" into a single
      // style computation, so the play phase never animates and the
      // tapped chip jump-cuts straight to its final position. Reading
      // offsetWidth (or any layout property) flushes pending styles.
      for (const chip of playing) {
        void chip.offsetWidth;
      }

      // Hand `transform` ownership cleanly to the FLIP's inline
      // styles. POP_CLASS still declares an animation on `transform`,
      // and even though the keyframe finished mid-hold the browser
      // may still treat the property as animation-controlled while
      // the class is present. Removing it now, before we kick off
      // the play phase, eliminates that conflict.
      tappedChip.classList.remove(POP_CLASS);

      // PLAY: next animation frame, transition transforms back to
      // zero so the cascade plays out.
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      for (const chip of playing) {
        chip.style.transition = `transform ${durationMs}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
        chip.style.transform = '';
      }

      // Wait for the longest-moving chip's transitionend (which is
      // the tapped chip — it traverses the most distance) with a
      // hard backstop in case transitionend never fires.
      await new Promise<void>((resolve) => {
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const onEnd = (e: TransitionEvent): void => {
          if (e.target === tappedChip && e.propertyName === 'transform') {
            tappedChip.removeEventListener('transitionend', onEnd);
            settle();
          }
        };
        tappedChip.addEventListener('transitionend', onEnd);
        setTimeout(settle, durationMs + 100);
      });

      // Cleanup inline transition styles so subsequent re-orders
      // don't inherit a stale transition value. transform was
      // already cleared when we kicked off the play phase.
      for (const chip of playing) {
        chip.style.transition = '';
      }
    }

    // (AC 6) Conditional scroll-follow. We need scroll when:
    //   a) the strip is overflow-scrollable (scrollWidth > clientWidth),
    //   b) the tapped chip's first rect was outside the strip's
    //      visible horizontal range (off-screen left or right).
    // Otherwise the user tapped a chip that's already visible and an
    // auto-scroll would feel jarring.
    if (followScroll) {
      const isOverflowing = strip.scrollWidth > strip.clientWidth;
      const tappedFirst = firstRects.get(tappedChip);
      if (isOverflowing && tappedFirst !== undefined) {
        const stripRect = strip.getBoundingClientRect();
        const wasOffScreen =
          tappedFirst.left < stripRect.left ||
          tappedFirst.right > stripRect.right;
        if (wasOffScreen) {
          strip.scrollTo({ left: 0, behavior: 'smooth' });
        }
      }
    }
  } finally {
    strip.removeAttribute(ANIM_LOCK_ATTR);
  }
}
