// Implements REQ-READ-006 — offline retry button + online-event hop.
// Extracted from src/pages/offline.astro (same REQ tag as the parent
// page; the offline service-worker REQ that once owned this page is
// now Out of Scope per sdd/README.md). The site CSP `script-src 'self'`
// silently blocks the inline bundle Astro would otherwise produce for
// a small page-level script; importing this module forces an external
// emit.

function init(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-offline-retry]');
  if (button === null) return;
  if (button.dataset['bound'] === '1') return;
  button.dataset['bound'] = '1';
  button.addEventListener('click', () => {
    if (window.navigator.onLine) {
      window.location.assign('/digest');
    }
  });
  // When the browser signals connectivity restored, hop back to
  // /digest automatically.
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

export {};
