// Implements REQ-PWA-001 — extracted from src/components/InstallPrompt.astro
// so Astro emits it as an external bundle. The site CSP
// (script-src 'self') silently blocks every inline <script>
// body Astro inlines for small scripts; without this extraction
// the install prompt never wires up on the live site.

// Implements REQ-PWA-001 AC 4, AC 5.
// This runs in the browser; keep it framework-free.

import { isIos as isIosPure } from '~/lib/ios-detection';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

type IosNavigator = Navigator & { standalone?: boolean };

const IOS_PROMPT_SEEN_KEY = 'pwa.iosInstallNoteSeen';

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
    return true;
  }
  const nav = window.navigator as IosNavigator;
  return nav.standalone === true;
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as IosNavigator;
  const arg: { userAgent: string; standalone?: boolean; maxTouchPoints?: number } = {
    userAgent: nav.userAgent,
  };
  if (nav.standalone !== undefined) arg.standalone = nav.standalone;
  if (nav.maxTouchPoints !== undefined) arg.maxTouchPoints = nav.maxTouchPoints;
  return isIosPure(arg);
}

function initInstallPrompt(): void {
  const root = document.querySelector<HTMLElement>('[data-install-prompt]');
  if (!root) return;

  // Already installed — stay hidden.
  if (isStandalone()) return;

  const button = root.querySelector<HTMLButtonElement>('[data-install-button]');
  const iosNote = root.querySelector<HTMLParagraphElement>('[data-install-ios-note]');

  if (isIos() && iosNote) {
    let seen = false;
    try {
      seen = window.localStorage.getItem(IOS_PROMPT_SEEN_KEY) === '1';
    } catch {
      // localStorage unavailable (private mode etc.); treat as unseen so the note shows once per page.
      seen = false;
    }
    if (!seen) {
      root.hidden = false;
      iosNote.hidden = false;
      try {
        window.localStorage.setItem(IOS_PROMPT_SEEN_KEY, '1');
      } catch {
        // ignore — note will reappear next load
      }
    }
    return;
  }

  // Android / desktop Chrome path.
  let deferredPrompt: BeforeInstallPromptEvent | null = null;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
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
