// Implements REQ-STAR-001, REQ-READ-002
//
// Article-detail page client behaviour. Served as a static file from
// /public so CSP `script-src 'self'` permits it (Astro 5
// directRenderScript inlines `<script>import './module';</script>` blocks
// regardless of bundle size, and inline emits are blocked by the CSP).
// The .ts source under src/scripts/article-detail.ts mirrors this file
// and is kept for tests that read it via `?raw` imports.

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

function initStar() {
  if (document.documentElement.dataset.starDetailBound === '1') return;
  document.documentElement.dataset.starDetailBound = '1';
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const button = target.closest('[data-star-toggle]');
      if (button === null) return;
      e.preventDefault();
      e.stopPropagation();
      void handleStarClick(button);
    },
    true,
  );
}

function handleBackClick(e) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return;
  }
  const stateIndex = window.history.state?.index;
  const arrivedInAppViaSpa =
    typeof stateIndex === 'number' && stateIndex > 0;
  const sameOriginReferrer =
    document.referrer !== '' &&
    new URL(document.referrer).origin === window.location.origin;
  if (!arrivedInAppViaSpa && !sameOriginReferrer) {
    return;
  }
  e.preventDefault();
  window.history.back();
}

function bindBack() {
  const link = document.querySelector('[data-article-back]');
  if (link === null) return;
  if (link.dataset.backBound === '1') return;
  link.dataset.backBound = '1';
  link.addEventListener('click', handleBackClick);
}

initStar();
bindBack();
document.addEventListener('astro:page-load', () => {
  initStar();
  bindBack();
});
