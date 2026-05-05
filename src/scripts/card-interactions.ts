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

// Idempotency tokens MUST live on `window`, not in this module's
// closure and not on a DOM-node dataset attribute. The trap, learned
// the hard way across PRs #182, #184, #185:
//
//   1. Listener target. We register on `document.addEventListener` so
//      the listener survives Astro's view-transition swap (the swap
//      replaces `document.documentElement`, but `document` itself
//      survives). PR #182 first uncovered this and bound on `document`.
//
//   2. Flag on `documentElement.dataset` (PR #182's mistake). View-
//      transition wipes the dataset → next astro:page-load re-bind
//      stacks a second listener → POST/DELETE race.
//
//   3. Flag in module closure (PR #184/#185's mistake). Looks fine
//      under one module load, but THIS FILE IS LOADED TWICE BY DESIGN:
//
//         a. Layout-wide as `<script type="module" src="/scripts/
//            card-interactions.js">` — built by `scripts/build-client-
//            scripts.mjs` as a self-contained IIFE bundle. CSP forbids
//            inline scripts, so every script-src 'self' module ships
//            this way (Pattern B in `documentation/architecture.md`).
//         b. Statically imported by `src/pages/history.astro:331`
//            (`import { initCardInteractions } from '~/scripts/card-
//            interactions'`) so the page can rebind tag-disclosure
//            triggers on cards CLONED into the search-filter grid.
//            Astro/Vite bundles the entire module — including the
//            module-scope auto-wire IIFE at the bottom of this file —
//            into history.astro's hashed `_astro/*.js` chunk.
//
//      The two builds are *separate ES-module instances*. Each closure
//      has its own `let starDelegationBound = false`. Each registers
//      its own `document.addEventListener('click', ...)`. Result: two
//      listeners on /history. Click → POST + DELETE in parallel.
//      Article-detail when navigated FROM /history inherits the
//      duplicate listener via `document` survival. Refresh on /digest
//      drops it because /digest never imports this module page-level.
//
//   4. ADR-NN — see `documentation/decisions/README.md` for the full
//      decision record. CI test `tests/build/no-page-pattern-b.test.ts`
//      fails the build if any `src/pages/**` adds a static import for
//      a top-level `src/scripts/*.ts`, preventing the next regression.
//
// `window` is the right home for the idempotency token because it is
// the SAME object across both module instances (one realm, one window
// — Workers run a single browser-realm context per page). A window
// property guards against re-binding regardless of how many times the
// module evaluates.
declare global {
  // eslint-disable-next-line no-var
  var __cardInteractionsBound:
    | { star?: true; outsideClick?: true }
    | undefined;
}

function getBindFlags(): { star?: true; outsideClick?: true } {
  if (typeof window === 'undefined') return {};
  if (window.__cardInteractionsBound === undefined) {
    window.__cardInteractionsBound = {};
  }
  return window.__cardInteractionsBound;
}

/**
 * Test-only helper. Clears the window-scoped idempotency token so unit
 * tests can re-exercise `bindStarDelegation` / `initCardInteractions`
 * from a clean slate without `vi.resetModules()` + dynamic imports.
 * Production never calls this. Exported behind `__` to flag its
 * internal status.
 */
export function __resetForTests(): void {
  if (typeof window !== 'undefined') {
    window.__cardInteractionsBound = {};
  }
}

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

  // Outside-click closes any open popover. Bound ONCE per *window*
  // lifetime — see the comment near the bind-flags declaration for
  // why a closure flag is insufficient (this module is evaluated
  // twice on /history due to the dual-bundle design; only `window`
  // is shared between the two evaluations).
  const flags = getBindFlags();
  if (root === document && flags.outsideClick !== true) {
    flags.outsideClick = true;
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
 * Bind the document-level star-click delegation. Idempotent via the
 * `window.__cardInteractionsBound` token so re-imports, astro:page-load
 * re-runs, AND dual-bundle module-instance evaluation (Pattern B
 * standalone IIFE + page-bundled import via history.astro) all
 * converge on a single live listener. Exported for unit tests that
 * need to assert idempotency without driving the full module-load
 * side effects.
 *
 * Bubble phase (not capture): pairs naturally with the
 * `e.stopPropagation()` the handler itself calls, and lets any
 * card-internal handler opt out by stopping propagation first.
 */
export function bindStarDelegation(): void {
  if (typeof document === 'undefined') return;
  const flags = getBindFlags();
  if (flags.star === true) return;
  flags.star = true;
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
      return;
    }
    // CF-038 — REQ-STAR-001 AC 5 says "the UI reconciles with the
    // server value if the optimistic flip disagreed". The earlier
    // implementation only reverted on non-2xx; on 2xx it left the
    // optimistic flip in place even if the server value disagreed.
    // Parse the response body and reconcile.
    try {
      const body = (await res.json()) as { starred?: boolean };
      if (typeof body.starred === 'boolean' && body.starred !== nextPressed) {
        button.setAttribute(
          'aria-pressed',
          body.starred ? 'true' : 'false',
        );
      }
    } catch {
      // Reconciliation is best-effort; an unexpected response body
      // shape leaves the optimistic flip in place. Worst case the UI
      // disagrees with the server until the next page load, which is
      // observably better than reverting on every 2xx parse failure.
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
//
// bindStarDelegation is safe to call on every astro:page-load — its
// window-scoped idempotency token guarantees a single listener
// regardless of how many times page-load fires AND regardless of how
// many module instances exist on the page (see AD20).
// initCardInteractions is called per page-load because tag-disclosure
// triggers ARE per-button and need rebinding when new cards enter the
// DOM (e.g. /history's day-grouped grids that lazy-render on
// `<details>` open). The `data-bound` per-trigger guard inside
// initCardInteractions keeps re-runs idempotent at the per-trigger
// level.
//
// EXTERNAL ENTRY POINT: pages that need to rebind tag-trigger
// handlers on JS-inserted clones (e.g. history.astro's filter grid
// clones cards into a flat search-result grid after the layout-wide
// astro:page-load fires) MUST NOT statically import this module —
// doing so causes Astro/Vite to bundle the WHOLE file, including
// this auto-wire IIFE, into the page chunk and produces a SECOND
// module evaluation alongside the layout-wide IIFE. That bug is
// documented in AD20.
//
// Instead, pages call `window.__cardInteractions.init(root)`. The
// IIFE exposes the function exactly once per realm — safe even if
// some future code paths accidentally re-bundle this module.
declare global {
  interface Window {
    __cardInteractions?: {
      init: (root?: Document | HTMLElement) => number;
    };
  }
}
if (typeof window !== 'undefined' && window.__cardInteractions === undefined) {
  window.__cardInteractions = { init: initCardInteractions };
}
if (typeof document !== 'undefined') {
  bindStarDelegation();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initCardInteractions());
  } else {
    initCardInteractions();
  }
  document.addEventListener('astro:page-load', () => {
    bindStarDelegation();
    initCardInteractions();
  });
}
