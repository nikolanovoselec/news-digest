// Implements REQ-STAR-001
// Implements REQ-READ-001
//
// Static-served mirror of src/scripts/card-interactions.ts. Loaded
// from Base.astro via `<script is:inline type="module" src="...">`.
//
// Why static instead of a component-imported `<script>`: the site CSP
// is `script-src 'self'`, and Astro 5 inlines small page-level script
// bundles into the HTML — those inline emits get blocked at runtime,
// which is what makes the star button on /digest a no-op despite the
// code looking correct. Same fix pattern as page-effects.js,
// alt-sources-modal.js, article-detail.js.

const POPOVER_TTL_MS = 5000;
const popoverTimers = new WeakMap();

function initCardInteractions(root) {
  const scope = root || document;
  let bound = 0;

  scope.querySelectorAll('[data-star-toggle]').forEach((button) => {
    if (button.dataset.bound === '1') return;
    button.dataset.bound = '1';
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void handleStarClick(button);
    });
    bound++;
  });

  scope.querySelectorAll('[data-tag-trigger]').forEach((trigger) => {
    if (trigger.dataset.bound === '1') return;
    trigger.dataset.bound = '1';
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleTagDisclosure(trigger);
    });
    bound++;
  });

  if (
    scope === document &&
    document.documentElement.dataset.cardOutsideClickBound !== '1'
  ) {
    document.documentElement.dataset.cardOutsideClickBound = '1';
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

async function handleStarClick(button) {
  const articleId = button.dataset.articleId;
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

function toggleTagDisclosure(trigger) {
  const disclosure = trigger.closest('[data-tag-disclosure]');
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

function closeAllTagPopovers(except) {
  document
    .querySelectorAll('[data-tag-disclosure].is-open')
    .forEach((d) => {
      if (d === except) return;
      d.classList.remove('is-open');
      const trigger = d.querySelector('[data-tag-trigger]');
      if (trigger !== null) trigger.setAttribute('aria-expanded', 'false');
      const existing = popoverTimers.get(d);
      if (existing !== undefined) {
        window.clearTimeout(existing);
        popoverTimers.delete(d);
      }
    });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initCardInteractions());
  } else {
    initCardInteractions();
  }
  document.addEventListener('astro:page-load', () => initCardInteractions());
}
