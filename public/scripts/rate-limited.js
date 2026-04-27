// Implements REQ-AUTH-001 — countdown + button re-enable on the rate-limited page.
// Static-served because Astro 5 directRenderScript inlines pure-import
// script tags and the site CSP `script-src 'self'` blocks the inline
// emit. The .ts source under src/scripts/rate-limited.ts mirrors this
// file.

function formatRemaining(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function init() {
  const root = document.querySelector('[data-rate-limited]');
  if (root === null) return;
  if (root.dataset.bound === '1') return;
  root.dataset.bound = '1';

  const raw = root.dataset.seconds;
  if (raw === undefined || raw === '') return;
  const initial = Number.parseInt(raw, 10);
  if (Number.isNaN(initial)) return;

  const countdown = root.querySelector('[data-countdown]');
  const button = root.querySelector('[data-retry-button]');

  const deadline = Math.floor(Date.now() / 1000) + initial;
  const tick = () => {
    const remaining = Math.max(0, deadline - Math.floor(Date.now() / 1000));
    if (countdown !== null) countdown.textContent = formatRemaining(remaining);
    if (remaining <= 0) {
      if (button !== null) button.disabled = false;
      window.clearInterval(handle);
    }
  };

  const handle = window.setInterval(tick, 1000);
  tick();

  if (button !== null) {
    button.addEventListener('click', () => {
      if (!button.disabled) {
        window.location.assign('/digest');
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
document.addEventListener('astro:page-load', init);
