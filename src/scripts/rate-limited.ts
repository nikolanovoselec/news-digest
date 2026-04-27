// Implements REQ-AUTH-001 — countdown + button re-enable on the rate-limited page.
// Extracted from src/pages/rate-limited.astro. The site CSP `script-src 'self'` silently
// blocks the inline bundle Astro would otherwise produce for a small
// page-level script; importing this module forces an external emit.

// Live countdown + button re-enable.

function formatRemaining(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function init(): void {
  const root = document.querySelector<HTMLElement>('[data-rate-limited]');
  if (root === null) return;
  if (root.dataset['bound'] === '1') return;
  root.dataset['bound'] = '1';

  const raw = root.dataset['seconds'];
  if (raw === undefined || raw === '') return;
  const initial = Number.parseInt(raw, 10);
  if (Number.isNaN(initial)) return;

  const countdown = root.querySelector<HTMLElement>('[data-countdown]');
  const button = root.querySelector<HTMLButtonElement>('[data-retry-button]');

  const deadline = Math.floor(Date.now() / 1000) + initial;
  const tick = (): void => {
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

export {};
