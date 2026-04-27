// Implements REQ-READ-006 — offline retry button + online-event hop.
// Static-served because Astro 5 directRenderScript inlines pure-import
// script tags and the site CSP `script-src 'self'` blocks the inline
// emit. The .ts source under src/scripts/offline.ts mirrors this file.

function init() {
  const button = document.querySelector('[data-offline-retry]');
  if (button === null) return;
  if (button.dataset.bound === '1') return;
  button.dataset.bound = '1';
  button.addEventListener('click', () => {
    if (window.navigator.onLine) {
      window.location.assign('/digest');
    }
  });
  window.addEventListener('online', () => {
    window.location.assign('/digest');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
document.addEventListener('astro:page-load', init);
