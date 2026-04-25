// Implements REQ-READ-007
//
// Shared FLIP-pattern helper for the tag railing on /digest and
// /history. The host pages call `flipChipToFront(strip, chip)` from
// their chip-click handlers; the helper:
//
//   1. Adds a brief pulse class on the tapped chip for input
//      confirmation (AC 1).
//   2. Captures every chip's bounding rect BEFORE mutating the DOM
//      (the FLIP "First" phase).
//   3. Moves the tapped chip to slot 0 via insertBefore (the FLIP
//      "Last" phase).
//   4. For each chip whose position changed, applies an inverse
//      translate so visually nothing moved (the FLIP "Invert" phase),
//      then on the next animation frame transitions the transform
//      back to zero so the cascade plays out (the FLIP "Play" phase).
//   5. Locks the strip via `data-tag-flip-locked` while the cascade
//      is in flight, so a rapid second tap can't desync data order
//      from visual order (AC 4).
//   6. After the motion settles, conditionally scrolls the strip to
//      the start, but ONLY when the strip is overflow-scrollable AND
//      the tapped chip's first rect was outside the strip's visible
//      box (AC 5). A chip already in view triggers no scroll.
//   7. When the runtime advertises `prefers-reduced-motion: reduce`,
//      the helper performs the reorder instantly and skips all
//      transform animation (AC 7).

// 450ms reads as deliberate motion at the gesture scale users perceive
// — under 300ms the cascade flashes by so quickly the eye registers
// only the start and end states and the chip appears to teleport.
// The pulse hold is sized to outlast the cascade by ~40ms so the
// just-tapped highlight is visible for the entire move plus a small
// trailing beat.
const DEFAULT_DURATION_MS = 450;
const PULSE_CLASS = 'tag-chip--just-tapped';
const PULSE_HOLD_MS = 500;
const ANIM_LOCK_ATTR = 'data-tag-flip-locked';

export interface FlipChipOptions {
  /** Animation duration in ms. Defaults to 220. */
  durationMs?: number;
  /** Whether to follow the moved chip with a scroll on overflow
   *  viewports. Defaults to true. Pass false to disable scroll
   *  entirely (e.g., wrap layouts already render every chip). */
  followScroll?: boolean;
}

/** True iff a flip animation is currently mid-flight on the given
 *  strip. Host-page tap handlers should consult this and bail out
 *  early so a double-tap doesn't queue a second reorder on top of
 *  the first one (AC 4). */
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

  // (AC 1) Brief pulse on the tapped chip — fires immediately even
  // when the chip is already first (no reorder needed) so the user
  // always gets feedback that the tap was received.
  tappedChip.classList.add(PULSE_CLASS);
  setTimeout(() => tappedChip.classList.remove(PULSE_CLASS), PULSE_HOLD_MS);

  // FIRST: capture every chip's rect before mutating the DOM.
  const chips = Array.from(
    strip.querySelectorAll<HTMLElement>('[data-tag-chip]'),
  );
  const firstRects = new Map<HTMLElement, DOMRect>();
  for (const chip of chips) {
    firstRects.set(chip, chip.getBoundingClientRect());
  }

  // (AC 7) Bail to instant reorder when motion is suppressed.
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) {
    strip.insertBefore(tappedChip, strip.firstChild);
    return;
  }

  // LAST: actually reorder. Lock the strip immediately so any
  // re-entrant tap that fires before we resolve is suppressed. The
  // try/finally below guarantees the lock is cleared even if any
  // DOM op throws (e.g., chip detached mid-flight by an external
  // mutation), so the strip never gets stuck inert.
  strip.setAttribute(ANIM_LOCK_ATTR, '1');
  try {
    strip.insertBefore(tappedChip, strip.firstChild);

    // INVERT: for each chip whose position changed by more than half
    // a pixel, set transform so it appears to still be in its old
    // slot. `transition: none` ensures the inverse jump is
    // instantaneous.
    const playing: HTMLElement[] = [];
    for (const chip of chips) {
      const first = firstRects.get(chip);
      if (first === undefined) continue;
      const last = chip.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      chip.style.transform = `translate(${dx}px, ${dy}px)`;
      chip.style.transition = 'none';
      playing.push(chip);
    }

    // Fast-exit when nothing actually moved (e.g., the user tapped
    // the chip already in slot 0). Otherwise we'd burn the full
    // backstop window waiting for a transitionend that will never
    // fire, blocking the strip for ~durationMs+100ms with no visual
    // payoff. AC 5 scroll-follow still runs below the try block.
    if (playing.length > 0) {
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

    // (AC 5) Conditional scroll-follow. We need scroll when:
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
