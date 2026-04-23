// Dashboard card interactions — star toggle + tag-disclosure popover.
//
// The previous implementation used a single document-level capture-
// phase click listener. That pattern is fragile across mobile engines
// (Samsung Browser, iOS Safari in-app webviews): the listener either
// doesn't fire for taps inside an <article>, or it fires but the
// touchstart→click translation eats the event before capture. We
// were shipping fix after fix trying to coax it to work.
//
// This module throws that away. It does the boring thing: queries
// every `[data-star-toggle]` and `[data-tag-trigger]` on the page
// and attaches a direct `click` handler per button. Direct handlers
// are the most reliable event path in every browser — no capture,
// no delegation, no preventDefault races with an ancestor anchor.
// The buttons already live OUTSIDE the card's <a>, so the anchor's
// navigation can't shadow them.
//
// Exported for unit testing: `initCardInteractions(root)` walks the
// given root (defaults to `document`) and binds handlers to every
// button it finds. Safe to re-run on `astro:page-load` — each button
// is bound at most once via a `data-bound` flag on the element.

const POPOVER_TTL_MS = 5000;
const popoverTimers = new WeakMap<HTMLElement, number>();

/**
 * Wire every card button under {@link root} with click handlers.
 * Re-entrant: buttons already bound are skipped. Returns the number
 * of buttons newly bound so tests can assert on it.
 */
export function initCardInteractions(
  root: Document | HTMLElement = document,
): number {
  let bound = 0;

  // Star toggles. Each <button data-star-toggle data-article-id=…>
  // becomes a direct click target. The handler flips aria-pressed
  // optimistically, POSTs/DELETEs /api/articles/:id/star, and reverts
  // on non-2xx.
  root.querySelectorAll<HTMLButtonElement>('[data-star-toggle]').forEach(
    (button) => {
      if (button.dataset['bound'] === '1') return;
      button.dataset['bound'] = '1';
      button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void handleStarClick(button);
      });
      bound++;
    },
  );

  // Tag-disclosure triggers. Each `#` / `#3` button opens the sibling
  // `[data-tag-disclosure]`'s popover with a 5-second auto-close.
  root.querySelectorAll<HTMLButtonElement>('[data-tag-trigger]').forEach(
    (trigger) => {
      if (trigger.dataset['bound'] === '1') return;
      trigger.dataset['bound'] = '1';
      trigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleTagDisclosure(trigger);
      });
      bound++;
    },
  );

  // Outside-click closes any open popover. Bound ONCE globally via
  // a documentElement flag so we don't stack listeners on astro:
  // page-load re-entries.
  if (
    root === document &&
    document.documentElement.dataset['cardOutsideClickBound'] !== '1'
  ) {
    document.documentElement.dataset['cardOutsideClickBound'] = '1';
    document.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-tag-disclosure]') !== null) return;
      if (target.closest('[data-tag-trigger]') !== null) return;
      closeAllTagPopovers();
    });
  }

  return bound;
}

/** POST/DELETE /api/articles/:id/star with optimistic UI. Exported for
 *  unit tests that want to drive the network path without wiring a
 *  whole click flow. */
export async function handleStarClick(button: HTMLButtonElement): Promise<void> {
  const articleId = button.dataset['articleId'];
  if (articleId === undefined || articleId === '') return;
  const wasPressed = button.getAttribute('aria-pressed') === 'true';
  const nextPressed = !wasPressed;
  button.setAttribute('aria-pressed', nextPressed ? 'true' : 'false');
  try {
    const res = await fetch(
      `/api/articles/${encodeURIComponent(articleId)}/star`,
      {
        method: nextPressed ? 'POST' : 'DELETE',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      },
    );
    if (!res.ok) {
      button.setAttribute('aria-pressed', wasPressed ? 'true' : 'false');
    }
  } catch {
    button.setAttribute('aria-pressed', wasPressed ? 'true' : 'false');
  }
}

/** Open the trigger's sibling `[data-tag-disclosure]` popover, or
 *  close it if already open. Exported for unit tests. */
export function toggleTagDisclosure(trigger: HTMLButtonElement): void {
  const disclosure = trigger.closest<HTMLElement>('[data-tag-disclosure]');
  if (disclosure === null) return;
  const willOpen = !disclosure.classList.contains('is-open');
  closeAllTagPopovers(willOpen ? disclosure : undefined);
  if (willOpen) {
    disclosure.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    const t = window.setTimeout(() => {
      disclosure.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      popoverTimers.delete(disclosure);
    }, POPOVER_TTL_MS);
    popoverTimers.set(disclosure, t);
  }
}

/** Close every open popover except an optional {@link except} one.
 *  Exported for unit tests. */
export function closeAllTagPopovers(except?: HTMLElement): void {
  document
    .querySelectorAll<HTMLElement>('[data-tag-disclosure].is-open')
    .forEach((d) => {
      if (d === except) return;
      d.classList.remove('is-open');
      const trigger = d.querySelector<HTMLButtonElement>('[data-tag-trigger]');
      if (trigger !== null) trigger.setAttribute('aria-expanded', 'false');
      const existing = popoverTimers.get(d);
      if (existing !== undefined) {
        window.clearTimeout(existing);
        popoverTimers.delete(d);
      }
    });
}

// Auto-wire on DOMContentLoaded + every astro:page-load.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initCardInteractions());
  } else {
    initCardInteractions();
  }
  document.addEventListener('astro:page-load', () => initCardInteractions());
}
