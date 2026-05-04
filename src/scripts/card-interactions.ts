// Implements REQ-STAR-001
// Implements REQ-READ-001
//
// Dashboard card interactions — star toggle + tag-disclosure popover.
//
// Star toggles use ONE document-level click delegation listener bound
// once at module load. Every `[data-star-toggle]` in the document —
// /digest, /starred, /history, AND the article-detail header — routes
// through this single handler. Per-button `addEventListener` was
// fragile under Astro's view-transition morphing: a button DOM node
// re-used across SPA navigations kept its `data-bound` flag while
// losing its closure-bound listener, producing the "clicking the
// favorite star sometimes does nothing, reload fixes it" intermittent
// bug. Delegation has nothing to lose because there is nothing
// per-button to lose.
//
// Tag-disclosure triggers stay per-button. They are vulnerable to the
// same view-transition node-reuse pattern that broke stars, but the
// failure mode is benign here — a stale handler on a morphed trigger
// still calls `toggleTagDisclosure`, which queries the live DOM via
// `closest('[data-tag-disclosure]')` and operates on whatever sibling
// is currently in the page. If a future regression surfaces "the # tag
// chip stops opening after navigation", convert this to delegation
// using the same pattern as `bindStarDelegation`.
//
// Exported for unit testing: `initCardInteractions(root)` walks the
// given root (defaults to `document`) and binds tag-trigger handlers
// to every button it finds. Safe to re-run on `astro:page-load` —
// tag-trigger buttons are skipped if already bound. The star
// delegation is bound once at module load, independent of init calls.

const POPOVER_TTL_MS = 5000;
const popoverTimers = new WeakMap<HTMLElement, number>();

/**
 * Wire every tag-disclosure trigger under {@link root} with click
 * handlers. Re-entrant: triggers already bound are skipped. Returns
 * the number of triggers newly bound so tests can assert on it.
 *
 * NOTE: star toggles are NOT bound here — they use document-level
 * delegation set up at module load (see `bindStarDelegation` below).
 */
export function initCardInteractions(
  root: Document | HTMLElement = document,
): number {
  let bound = 0;

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

/**
 * Bind the document-level star-click delegation. Idempotent via
 * `data-star-delegation-bound` on documentElement so re-imports or
 * astro:page-load re-runs never stack listeners. Exported for unit
 * tests that need to assert idempotency without driving the full
 * module-load side effects.
 *
 * Bubble phase (not capture): pairs naturally with the
 * `e.stopPropagation()` the handler itself calls, and lets any
 * card-internal handler opt out by stopping propagation first.
 */
export function bindStarDelegation(): void {
  if (typeof document === 'undefined') return;
  if (document.documentElement.dataset['starDelegationBound'] === '1') return;
  document.documentElement.dataset['starDelegationBound'] = '1';
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('[data-star-toggle]');
    if (button === null) return;
    // CF-027 — let modifier-key/middle-click bypass the handler, mirror
    // of the bindBrandLinkScrollToTop pattern in page-effects.ts. A
    // user holding Cmd/Ctrl on a star button should not have the
    // toggle fire (no useful semantics for it anyway).
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e instanceof MouseEvent && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    void handleStarClick(button);
  });
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
      // CF-015 — silent revert hid the original favorites bug PR #175
      // fixed; surface the failure in the browser console so
      // recurrence is observable without DevTools network panel.
      // eslint-disable-next-line no-console
      console.warn('star toggle failed', { articleId, status: res.status });
    }
  } catch (err) {
    button.setAttribute('aria-pressed', wasPressed ? 'true' : 'false');
    // eslint-disable-next-line no-console
    console.warn('star toggle network failed', { articleId, error: err });
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
  bindStarDelegation();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initCardInteractions());
  } else {
    initCardInteractions();
  }
  document.addEventListener('astro:page-load', () => initCardInteractions());
}
