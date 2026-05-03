// Implements REQ-READ-002 — alt-sources modal open/close + responsive anchor.
// Extracted from src/components/AltSourcesModal.astro. The site CSP `script-src 'self'` silently
// blocks the inline bundle Astro would otherwise produce for a small
// page-level script; importing this module forces an external emit.

// Implements REQ-READ-002 — modal open/close wiring + desktop anchor.
//
// Opens the <dialog> via showModal() when a `[data-alt-sources-trigger]`
// element is clicked anywhere on the page. Closes on:
//   - Escape (handled natively by <dialog>)
//   - Click on the close (×) button
//   - Click on the backdrop (event.target === dialog)
//
// Positioning: on viewports >= 768px the dialog anchors below the
// trigger button (computed via `positionAnchored`) instead of the
// CSS-default centred layout. Mobile keeps the centred modal — when
// the screen is small a popover next to a button has nowhere good to
// go. The toggle is a `data-anchored` attribute on the dialog that the
// CSS branches on (see AltSourcesModal.astro :: `[data-anchored='1']`).
//
// Re-initialises on astro:page-load (View Transitions) and tears down
// listeners on astro:before-swap so navigating between articles
// doesn't accumulate stale bindings.

const DESKTOP_MIN_WIDTH_PX = 768;
const ANCHOR_GAP_PX = 8;
const ANCHOR_EDGE_MARGIN_PX = 12;

function getDialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>('[data-alt-sources-modal]');
}

/**
 * Compute viewport-clamped top/left for an anchored popover positioned
 * below {@link triggerRect}. Pure function — exported for unit tests.
 *
 * Strategy: place the dialog directly below the trigger, left-aligned to
 * the trigger's left edge. If that would overflow the right viewport
 * edge, slide left until it fits with `ANCHOR_EDGE_MARGIN_PX` slack.
 * If the dialog would overflow the bottom, flip above the trigger.
 * If it still doesn't fit (very tall dialog on a short viewport),
 * return null so the caller falls back to centred layout.
 */
export function positionAnchored(
  triggerRect: { top: number; left: number; bottom: number; right: number; width: number },
  viewport: { width: number; height: number },
  dialog: { width: number; height: number },
): { top: number; left: number } | null {
  if (dialog.height + ANCHOR_EDGE_MARGIN_PX * 2 > viewport.height) {
    return null;
  }
  let left = triggerRect.left;
  if (left + dialog.width + ANCHOR_EDGE_MARGIN_PX > viewport.width) {
    left = viewport.width - dialog.width - ANCHOR_EDGE_MARGIN_PX;
  }
  if (left < ANCHOR_EDGE_MARGIN_PX) {
    left = ANCHOR_EDGE_MARGIN_PX;
  }
  let top = triggerRect.bottom + ANCHOR_GAP_PX;
  if (top + dialog.height + ANCHOR_EDGE_MARGIN_PX > viewport.height) {
    // Flip above the trigger.
    top = triggerRect.top - dialog.height - ANCHOR_GAP_PX;
    if (top < ANCHOR_EDGE_MARGIN_PX) {
      // Still doesn't fit — fall back to centred.
      return null;
    }
  }
  return { top, left };
}

function applyAnchorOrCentre(
  dialog: HTMLDialogElement,
  trigger: HTMLElement,
): void {
  // Mobile: leave the CSS centred layout in place.
  if (window.innerWidth < DESKTOP_MIN_WIDTH_PX) {
    dialog.removeAttribute('data-anchored');
    dialog.style.removeProperty('top');
    dialog.style.removeProperty('left');
    return;
  }
  // Desktop: try to anchor. We need the dialog's measured size, which
  // is only available after `showModal()` promotes it to the top
  // layer. Pre-measure via a temporary `display: block` snapshot would
  // double-paint; instead, read it after the open and adjust in the
  // same frame so the user never sees the centred-then-jump artifact.
  const triggerRect = trigger.getBoundingClientRect();
  // Attribute is set BEFORE showModal so the CSS centring transform is
  // dropped from the very first frame; inline top/left are written
  // after measurement.
  dialog.setAttribute('data-anchored', '1');
  // Park briefly off-screen so the first paint of the modal isn't at
  // (0,0) before we measure.
  dialog.style.top = '-9999px';
  dialog.style.left = '-9999px';
  // Measure after promotion to top layer.
  requestAnimationFrame(() => {
    const dialogRect = dialog.getBoundingClientRect();
    const pos = positionAnchored(
      triggerRect,
      { width: window.innerWidth, height: window.innerHeight },
      { width: dialogRect.width, height: dialogRect.height },
    );
    if (pos === null) {
      // Fall back to CSS centring.
      dialog.removeAttribute('data-anchored');
      dialog.style.removeProperty('top');
      dialog.style.removeProperty('left');
      return;
    }
    dialog.style.top = `${pos.top}px`;
    dialog.style.left = `${pos.left}px`;
  });
}

function onTriggerClick(event: Event): void {
  const dialog = getDialog();
  if (dialog === null) return;
  event.preventDefault();
  if (typeof dialog.showModal !== 'function') return;
  const trigger = event.currentTarget as HTMLElement;
  applyAnchorOrCentre(dialog, trigger);
  dialog.showModal();
}

function onCloseClick(event: Event): void {
  const dialog = getDialog();
  if (dialog === null) return;
  event.preventDefault();
  if (typeof dialog.close === 'function') {
    dialog.close();
  }
}

function onDialogClick(event: MouseEvent): void {
  const dialog = getDialog();
  if (dialog === null) return;
  // Clicking the backdrop dispatches a click whose target is the
  // dialog itself (the content sits in an inner wrapper).
  if (event.target === dialog) {
    dialog.close();
  }
}

function initModal(): void {
  const dialog = getDialog();
  if (dialog === null) return;
  if (dialog.dataset['bound'] === '1') return;
  dialog.dataset['bound'] = '1';

  const triggers = document.querySelectorAll<HTMLElement>(
    '[data-alt-sources-trigger]',
  );
  triggers.forEach((t) => {
    t.addEventListener('click', onTriggerClick);
  });

  const closeBtn = dialog.querySelector<HTMLElement>('[data-alt-sources-close]');
  if (closeBtn !== null) {
    closeBtn.addEventListener('click', onCloseClick);
  }

  dialog.addEventListener('click', onDialogClick);
}

function teardownModal(): void {
  const dialog = getDialog();
  if (dialog === null) return;

  const triggers = document.querySelectorAll<HTMLElement>(
    '[data-alt-sources-trigger]',
  );
  triggers.forEach((t) => {
    t.removeEventListener('click', onTriggerClick);
  });

  const closeBtn = dialog.querySelector<HTMLElement>('[data-alt-sources-close]');
  if (closeBtn !== null) {
    closeBtn.removeEventListener('click', onCloseClick);
  }

  dialog.removeEventListener('click', onDialogClick);
  dialog.dataset['bound'] = '0';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initModal, { once: true });
} else {
  initModal();
}
document.addEventListener('astro:page-load', initModal);
document.addEventListener('astro:before-swap', teardownModal);
