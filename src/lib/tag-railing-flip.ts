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
// dropped (AC 5). The railing's scroll position is preserved
// across the cascade — the helper does not auto-scroll. On a
// horizontally-scrolled mobile viewport the tapped chip may slide
// off the left edge as it travels to data-position 0; the user
// navigates the railing manually to see the new arrangement
// (AC 6). The scroll-snap and focus defenses around `insertBefore`
// only suppress the browser's *implicit* scroll — they don't
// initiate any scroll of their own.
//
// When the runtime advertises `prefers-reduced-motion: reduce`,
// the helper performs the reorder instantly and skips the pop,
// hold, and cascade entirely (AC 8).

// Three-phase choreography (deliberately slow so the user sees each
// step distinctly):
//
//   1. POP: the tapped chip scales up with a bounce so the user gets
//      unmistakable feedback that the tap was received. The pop
//      keyframe in TagStrip.astro runs for ~500ms and is the only
//      motion on screen for the first beat.
//   2. HOLD: a one-second pause where nothing else moves. The popped
//      chip stays slightly elevated (z-index lift via the pop class)
//      while the user's eye lands on it, so they know which chip is
//      about to move before the cascade starts.
//   3. CASCADE: the FLIP reorder plays at a distance-proportional
//      duration (see PX_PER_MS / MIN_CASCADE_MS / MAX_CASCADE_MS) so
//      the chip's perceived velocity stays uniform whether it
//      travels 200px or 1500px. The eye can track the chip across
//      the railing without it racing past as a blur.
//
// Total wall-clock from tap to settled state for a near chip:
//   ~500ms pop (overlapping the hold) + remaining hold to 1000ms
//     + 200ms cascade  ≈ 1200 ms.
// Far chips (low visibleFraction) extend the cascade up to 750ms,
// pushing wall clock to ~1750ms. Earlier 220ms / 450ms tunings
// looked like teleportation on real hardware; the current numbers
// are tuned for snappy-but-trackable.
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
// Cascade duration scales with the tapped chip's *visible-fraction*
// of travel — i.e., how much of the chip's journey is inside the
// strip's viewport. Far chips have most of their journey off-screen
// (chip enters viewport from one edge, exits the other), so the
// user only sees a narrow window of motion. By inverting the
// visible fraction we keep the on-screen portion of every cascade
// at roughly TARGET_VISIBLE_CROSSING_MS, regardless of total
// distance. Linear-velocity scaling (the prior approach) optimised
// for *physical* velocity uniformity, but the eye only ever sees
// the visible slice — so far chips still flashed past as a blur.
const MIN_CASCADE_MS = 200;
const MAX_CASCADE_MS = 750;
const TARGET_VISIBLE_CROSSING_MS = 200;
// Floor on visibleFraction prevents a 0-divide when the chip is
// entirely off-screen at FIRST capture (which would imply the user
// somehow tapped a chip they couldn't see — defensive).
const MIN_VISIBLE_FRACTION = 0.15;
// Easing curves: tapped chip uses ease-IN when it ends off-screen
// so the slow phase (front of curve) covers the visible portion and
// the fast phase covers the off-screen tail. Displaced chips and
// tapped-but-arriving-visible use ease-OUT so they decelerate into
// their final visible position.
// TODO(REQ-READ-007): easing constants commented out while the play
// phase forces 'linear' pending UX evaluation. Restore by uncommenting
// these and the per-chip easing line in the play loop below.
// const EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)';
// const EASE_OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
// LIFT_CLASS lives slightly longer than the longest possible cascade
// so the elevated look settles back to flat AFTER the slide ends,
// regardless of how far the tapped chip had to travel.
const LIFT_HOLD_MS = HOLD_BEFORE_CASCADE_MS + MAX_CASCADE_MS + 100;
const ANIM_LOCK_ATTR = 'data-tag-flip-locked';
// One-shot scroll-down reveal: after a cascade settles, the next
// downward window scroll smooth-animates strip.scrollLeft → 0 so the
// user sees the just-selected chip docked at slot 0 as they begin to
// scroll the dashboard. Lives ~600ms with easeOutQuint matching the
// FLIP cascade's curve. Cancelled if the user manually swipes the
// strip during the animation.
const SCROLL_REVEAL_DURATION_MS = 600;

export interface FlipChipOptions {
  /** Override for the cascade animation duration in ms. When unset,
   *  the helper computes a distance-proportional duration clamped
   *  between MIN_CASCADE_MS and MAX_CASCADE_MS so velocity feels
   *  uniform across short and long hops. */
  durationMs?: number;
}

/** True iff a flip animation is currently mid-flight on the given
 *  strip. Host-page tap handlers should consult this and bail out
 *  early so a double-tap doesn't queue a second reorder on top of
 *  the first one (AC 5). */
export function isFlipLocked(strip: HTMLElement): boolean {
  return strip.hasAttribute(ANIM_LOCK_ATTR);
}

/** Reorder `tappedChip` to the start of `strip` with a FLIP cascade.
 *  Thin wrapper over `flipChipToPosition` for the select-on-tap case
 *  where the chip always lands at slot 0. */
export function flipChipToFront(
  strip: HTMLElement,
  tappedChip: HTMLElement,
  options: FlipChipOptions = {},
): Promise<void> {
  return flipChipToPosition(strip, tappedChip, strip.firstChild, options);
}

/** Reorder `tappedChip` to immediately before `beforeNode` (or to
 *  the end if `beforeNode` is null) with the same pop-hold-cascade
 *  choreography as `flipChipToFront`. Used by the unselect path,
 *  where the chip slides back to its natural sort position among
 *  the non-selected chips. The cascade direction (leftward or
 *  rightward) is determined naturally by the FLIP rect math; the
 *  ease-IN curve kicks in whenever the chip ends off-screen on
 *  either edge so the visible portion of the journey covers the
 *  slow phase of the curve. The scroll-down reveal is only armed
 *  when the chip ends up at slot 0 (i.e., `strip.firstChild ===
 *  tappedChip` after the move) — unselect cascades that land
 *  mid-railing don't pull the strip's scrollLeft to 0 on the next
 *  page scroll. */
export async function flipChipToPosition(
  strip: HTMLElement,
  tappedChip: HTMLElement,
  beforeNode: Node | null,
  options: FlipChipOptions = {},
): Promise<void> {
  if (isFlipLocked(strip)) return;
  // The play-phase duration is computed adaptively from the tapped
  // chip's visible-fraction of travel — see tappedCascadeMs in the
  // cascade block. options.durationMs is honoured there as an
  // override (used by tests for deterministic timing).

  // (AC 8) Bail to instant reorder when motion is suppressed. The
  // pop + hold + cascade choreography is purely chrome — when the
  // user has asked for reduced motion we skip it entirely and just
  // commit the new order silently.
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) {
    strip.insertBefore(tappedChip, beforeNode);
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
  // hadFocus is hoisted above the try so the finally block can
  // restore focus regardless of where in the cascade we throw.
  strip.setAttribute(ANIM_LOCK_ATTR, '1');
  const hadFocus = document.activeElement === tappedChip;
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

    // CRITICAL — defeat two browser implicit behaviours that would
    // otherwise shift `strip.scrollLeft` between FIRST and LAST
    // captures and break the inverse-transform math (especially for
    // the tapped chip itself):
    //   (a) :focus auto-scroll: when insertBefore moves a focused
    //       button to a different DOM position inside a scrollable
    //       container, Blink/WebKit scroll the container to keep the
    //       focused element visible. We blur the chip first; later we
    //       re-focus it with preventScroll: true once the cascade is
    //       settled (preserves keyboard accessibility).
    //   (b) scroll-snap re-evaluation: the strip uses
    //       `scroll-snap-type: x proximity` and chips have
    //       `scroll-snap-align: start`. DOM mutation re-evaluates
    //       snap points and may re-snap scrollLeft. We temporarily
    //       disable scroll-snap for the duration of the FLIP and
    //       restore it after settle.
    // Plus a synchronous scrollLeft snapshot/restore around
    // insertBefore as belt-and-braces in case the browser still
    // moves scrollLeft despite (a) and (b).
    const prevSnap = strip.style.scrollSnapType;
    strip.style.scrollSnapType = 'none';
    const savedScrollLeft = strip.scrollLeft;
    if (hadFocus) tappedChip.blur();

    strip.insertBefore(tappedChip, beforeNode);

    if (strip.scrollLeft !== savedScrollLeft) {
      strip.scrollLeft = savedScrollLeft;
    }

    // INVERT: for each chip whose position changed by more than half
    // a pixel, set transform so it appears to still be in its old
    // slot. `transition: none` ensures the inverse jump is
    // instantaneous. We also guard against the tapped chip's pop
    // class still emitting a `transform: scale(...)` from its
    // keyframe — the inline transform overrides it.
    const playing: HTMLElement[] = [];
    // Capture the tapped chip's first/last rects for the visible-
    // fraction duration math below. We compute these inside the
    // INVERT loop to avoid a second getBoundingClientRect call.
    let tappedFirstLeft = 0;
    let tappedLastLeft = 0;
    // NOTE(REQ-READ-007): when the per-chip easing logic is restored
    // (see commented-out tappedEndsOffScreen block below), also
    // re-add `let tappedLastRight = 0;` here and `tappedLastRight =
    // last.right;` inside the `if (chip === tappedChip)` block.
    // Currently dropped to satisfy CodeQL's useless-assignment rule.
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
      if (chip === tappedChip) {
        tappedFirstLeft = first.left;
        tappedLastLeft = last.left;
      }
    }

    // Visible-fraction-based cascade duration. The tapped chip's
    // travel range is [min(first,last), max(first,last)]. The
    // visible portion is the intersection of that range with the
    // strip's visible viewport. By keeping
    // (visible_distance / total_distance) * total_duration ≈ TARGET
    // we hold the on-screen crossing time roughly constant across
    // chips that travel 200px and chips that travel 2000px. The
    // hidden tail of long-travel cascades extends total wall-clock
    // but is invisible to the user — only the visible window
    // matters perceptually.
    const stripRect = strip.getBoundingClientRect();
    const travelMin = Math.min(tappedFirstLeft, tappedLastLeft);
    const travelMax = Math.max(tappedFirstLeft, tappedLastLeft);
    const visibleSpan = Math.max(
      0,
      Math.min(travelMax, stripRect.right) - Math.max(travelMin, stripRect.left),
    );
    const totalSpan = Math.max(1, travelMax - travelMin);
    const visibleFraction = Math.max(MIN_VISIBLE_FRACTION, visibleSpan / totalSpan);
    const tappedCascadeMs =
      options.durationMs ??
      Math.max(
        MIN_CASCADE_MS,
        Math.min(MAX_CASCADE_MS, TARGET_VISIBLE_CROSSING_MS / visibleFraction),
      );
    // Displaced chips animate over the floor duration so they don't
    // drift slowly into position while the tapped chip continues its
    // longer journey. They'll reach their final slot quickly; the
    // tapped chip continues sliding (mostly off-screen) until
    // tappedCascadeMs elapses.
    const displacedCascadeMs = options.durationMs ?? MIN_CASCADE_MS;
    // TODO(REQ-READ-007): per-chip easing temporarily disabled while
    // the play phase forces 'linear'. Restore by uncommenting these
    // lines and the corresponding `easing` assignment in the play
    // loop below. The off-screen-edge logic is intact for both the
    // select (off-screen-left) and unselect (off-screen-right) paths.
    // const tappedEndsOffScreen =
    //   tappedLastLeft < stripRect.left || tappedLastRight > stripRect.right;
    // const tappedEasing = tappedEndsOffScreen ? EASE_IN : EASE_OUT;

    // Fast-exit when nothing actually moved (e.g., the user tapped
    // the chip already in slot 0). Otherwise we'd burn the full
    // backstop window waiting for a transitionend that will never
    // fire, blocking the strip for ~durationMs+100ms with no visual
    // payoff.
    if (playing.length > 0) {
      // CRITICAL ORDERING — POP_CLASS removal must come BEFORE the
      // offsetWidth flush. Per CSS Animations Level 1 §2.2, while
      // an animation declaration is on the element, the
      // animation-controlled value (the keyframe's final transform:
      // scale(1)) overrides any inline transform. If we flush styles
      // with the class still attached, the flushed before-change
      // value for the tapped chip is scale(1), not the inline
      // translate(dx, 0). The subsequent transition then runs
      // scale(1) → none — visually nothing — and the chip appears
      // to teleport. Removing the class first hands transform
      // ownership cleanly to inline style BEFORE the flush captures
      // the before-change state.
      tappedChip.classList.remove(POP_CLASS);

      // Now flush — the before-change `translate(dx, 0)` is the
      // committed value the transition will start from. Without this
      // read, the browser collapses the inverse-set and the play-
      // phase clear into a single style computation and the cascade
      // never animates.
      for (const chip of playing) {
        void chip.offsetWidth;
      }

      // PLAY: next animation frame, transition transforms back to
      // zero so the cascade plays out. The strip's scrollLeft is
      // intentionally NOT touched — on a horizontally-scrolled
      // mobile viewport the tapped chip's destination at DOM slot 0
      // sits at viewport pixel `slot0_offset - scrollLeft`, which
      // is off-screen-left when scrollLeft > 0. The chip slides
      // visibly off the left edge during the cascade. This is the
      // intended behaviour: per REQ-READ-007 AC 6 the railing's
      // scroll position is preserved across the cascade and the
      // user navigates manually to see the new arrangement.
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      for (const chip of playing) {
        const isTapped = chip === tappedChip;
        const duration = isTapped ? tappedCascadeMs : displacedCascadeMs;
        // TODO(REQ-READ-007): easing temporarily forced to 'linear'
        // pending UX evaluation. The original per-chip easing logic is
        // preserved (tappedEasing / EASE_IN / EASE_OUT consts above)
        // so restoring is a one-line revert of this assignment.
        // const easing = isTapped ? tappedEasing : EASE_OUT;
        const easing = 'linear';
        chip.style.transition = `transform ${duration}ms ${easing}`;
        // Explicit identity transform rather than '' (inline removal).
        // CSS Transitions L1 §3 interpolates between two computed
        // <transform-list> values cleanly when both endpoints are
        // explicit; relying on '' → cascade-fallback-to-`none` is
        // valid per spec but has caused engine-specific edge cases
        // historically. Belt-and-braces: state the destination.
        chip.style.transform = 'translate(0px, 0px)';
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
        setTimeout(settle, tappedCascadeMs + 100);
      });

      // Cleanup inline transition + transform styles so subsequent
      // re-orders don't inherit stale values. transform was set to
      // 'translate(0px, 0px)' (identity) at play-phase start; clear
      // it here so the chip's resolved transform falls back to the
      // natural cascaded value (none) for any future cycle.
      for (const chip of playing) {
        chip.style.transition = '';
        chip.style.transform = '';
      }
    }

    // Restore scroll-snap (AFTER the cascade — re-enabling it
    // mid-transition would re-snap during the slide).
    strip.style.scrollSnapType = prevSnap;

    // Arm a one-shot scroll-down reveal: the next downward window
    // scroll will smooth-animate the strip's scrollLeft → 0 so the
    // user sees the just-selected chip docked at slot 0 as they
    // begin to read the dashboard. Conditions:
    //   1. strip is overflow-scrollable (scrollWidth > clientWidth)
    //   2. strip is currently scrolled right (scrollLeft > 0)
    //   3. the tapped chip ended up at slot 0 (strip.firstChild ===
    //      tappedChip) — the SELECT case. Unselect cascades land
    //      mid-railing; pulling scrollLeft to 0 then would hide the
    //      chip the user just operated on.
    if (
      strip.scrollWidth > strip.clientWidth &&
      strip.scrollLeft > 0 &&
      strip.firstChild === tappedChip
    ) {
      armScrollDownReveal(strip);
    }
  } finally {
    // Keyboard-accessibility safety: restore focus in finally so
    // even an unexpected throw mid-cascade doesn't leave the user
    // without a focused chip. preventScroll: true blocks the focus
    // call's own implicit scroll.
    if (hadFocus) tappedChip.focus({ preventScroll: true });
    strip.removeAttribute(ANIM_LOCK_ATTR);
  }
}

/** Install a one-shot window scroll listener that fires on the first
 *  downward page scroll and smooth-animates the strip's `scrollLeft`
 *  back to 0 — revealing the just-selected chip at slot 0 as the
 *  user starts to read the dashboard. Only one listener is armed per
 *  strip at a time (subsequent calls before the first fires are
 *  no-ops). The animation cancels if the user manually swipes the
 *  strip during it. */
function armScrollDownReveal(strip: HTMLElement): void {
  if (strip.dataset['scrollRevealArmed'] === '1') return;
  strip.dataset['scrollRevealArmed'] = '1';

  let lastScrollY = window.scrollY;
  const onScroll = (): void => {
    const currentY = window.scrollY;
    const delta = currentY - lastScrollY;
    lastScrollY = currentY;
    if (delta <= 0) return; // only fire on downward scroll
    window.removeEventListener('scroll', onScroll);
    delete strip.dataset['scrollRevealArmed'];
    if (strip.scrollLeft <= 0) return;
    animateStripScrollTo(strip, 0, SCROLL_REVEAL_DURATION_MS);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
}

/** Smooth scrollLeft easing with user-input cancellation. Same shape
 *  as the helper that lived inline before PR #49 removed it. */
function animateStripScrollTo(
  strip: HTMLElement,
  target: number,
  durationMs: number,
): void {
  const start = strip.scrollLeft;
  if (Math.abs(target - start) < 0.5) return;
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
  };
  const opts: AddEventListenerOptions = { once: true, passive: true };
  strip.addEventListener('wheel', cancel, opts);
  strip.addEventListener('touchstart', cancel, opts);
  strip.addEventListener('pointerdown', cancel, opts);
  const cleanup = (): void => {
    strip.removeEventListener('wheel', cancel);
    strip.removeEventListener('touchstart', cancel);
    strip.removeEventListener('pointerdown', cancel);
  };
  const t0 = performance.now();
  const tick = (now: number): void => {
    if (cancelled) {
      cleanup();
      return;
    }
    const t = Math.min(1, (now - t0) / durationMs);
    const eased = 1 - Math.pow(1 - t, 5);
    strip.scrollLeft = start + (target - start) * eased;
    if (t < 1) {
      requestAnimationFrame(tick);
    } else {
      cleanup();
    }
  };
  requestAnimationFrame(tick);
}

