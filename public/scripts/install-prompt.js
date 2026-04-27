// Implements REQ-PWA-001 AC 4, AC 5
//
// Static-served because Astro 5 directRenderScript inlines the bundled
// output of `<script>import './module';</script>` blocks, and the site
// CSP `script-src 'self'` blocks the inline emit. The .ts source under
// src/scripts/install-prompt.ts mirrors this file.

const IOS_UA_PATTERN = /iPad|iPhone|iPod/;
const IOS_PROMPT_SEEN_KEY = 'pwa.iosInstallNoteSeen';

function isStandalone() {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
    return true;
  }
  const nav = window.navigator;
  return nav.standalone === true;
}

function isIos() {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator;
  return IOS_UA_PATTERN.test(nav.userAgent) && !nav.standalone;
}

function initInstallPrompt() {
  const root = document.querySelector('[data-install-prompt]');
  if (!root) return;
  if (isStandalone()) return;

  const button = root.querySelector('[data-install-button]');
  const iosNote = root.querySelector('[data-install-ios-note]');

  if (isIos() && iosNote) {
    let seen = false;
    try {
      seen = window.localStorage.getItem(IOS_PROMPT_SEEN_KEY) === '1';
    } catch {
      seen = false;
    }
    if (!seen) {
      root.hidden = false;
      iosNote.hidden = false;
      try {
        window.localStorage.setItem(IOS_PROMPT_SEEN_KEY, '1');
      } catch {
        /* ignore */
      }
    }
    return;
  }

  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    if (button) {
      root.hidden = false;
      button.hidden = false;
    }
  });

  if (button) {
    button.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      try {
        await deferredPrompt.prompt();
        await deferredPrompt.userChoice;
      } finally {
        deferredPrompt = null;
        button.hidden = true;
        root.hidden = true;
      }
    });
  }

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    if (button) button.hidden = true;
    root.hidden = true;
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initInstallPrompt, { once: true });
} else {
  initInstallPrompt();
}
