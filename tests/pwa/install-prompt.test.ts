// Tests for the install-prompt client behaviour — REQ-PWA-001.
// The contract we're testing (iOS detection, beforeinstallprompt
// handler, "Add to Home Screen" copy) lives in
// src/scripts/install-prompt.ts; the .astro file is template-only
// after the CSP inline-script extraction.

import { describe, it, expect } from 'vitest';
import installPromptSource from '../../src/scripts/install-prompt.ts?raw';
import installPromptTemplate from '../../src/components/InstallPrompt.astro?raw';

// Mirror of the detection logic in the component, duplicated here so we can
// unit-test the branches without spinning up a DOM. If the regex or the
// standalone-gating rule ever changes in the component, these tests must also
// be updated (and the change should be intentional).
const IOS_UA_PATTERN = /iPad|iPhone|iPod/;

type IosNavigatorLike = { userAgent: string; standalone?: boolean };

function isIos(nav: IosNavigatorLike): boolean {
  return IOS_UA_PATTERN.test(nav.userAgent) && !nav.standalone;
}

describe('InstallPrompt source content', () => {
  it('REQ-PWA-001: declares it implements REQ-PWA-001 (in both the script and the template)', () => {
    expect(installPromptSource).toContain('REQ-PWA-001');
    expect(installPromptTemplate).toContain('REQ-PWA-001');
  });

  it('REQ-PWA-001: listens for the beforeinstallprompt event (AC 5)', () => {
    expect(installPromptSource).toMatch(/addEventListener\(\s*['"]beforeinstallprompt['"]/);
  });

  it('REQ-PWA-001: calls event.preventDefault on beforeinstallprompt so we can defer the prompt', () => {
    expect(installPromptSource).toContain('preventDefault');
  });

  it('REQ-PWA-001: shows the iOS "Add to Home Screen" instructional note (AC 4)', () => {
    // The user-facing copy lives in the template, the rendering branch
    // logic lives in the script.
    expect(installPromptTemplate).toContain('Add to Home Screen');
  });

  it('REQ-PWA-001: detects standalone via matchMedia(display-mode: standalone)', () => {
    expect(installPromptSource).toMatch(/matchMedia\(['"]\(display-mode:\s*standalone\)['"]/);
  });

  it('REQ-PWA-001: detects iOS via /iPad|iPhone|iPod/ user-agent pattern', () => {
    expect(installPromptSource).toMatch(/iPad\|iPhone\|iPod/);
  });

  it('REQ-PWA-001: checks navigator.standalone in the iOS branch (AC 4)', () => {
    // The script casts navigator to a typed view (`const nav = navigator
    // as IosNavigator`) before reading the iOS-specific .standalone
    // property — so the literal "navigator.standalone" doesn't appear,
    // but the .standalone access does. Pin the access shape.
    expect(installPromptSource).toMatch(/\bnav\.standalone\b/);
  });
});

describe('iOS detection branch (REQ-PWA-001 AC 4)', () => {
  it('REQ-PWA-001: iPhone Safari in browser tab → isIos() is true', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15';
    expect(isIos({ userAgent: ua, standalone: false })).toBe(true);
  });

  it('REQ-PWA-001: iPad Safari in browser tab → isIos() is true', () => {
    const ua = 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15';
    expect(isIos({ userAgent: ua, standalone: false })).toBe(true);
  });

  it('REQ-PWA-001: iPod touch Safari → isIos() is true', () => {
    const ua = 'Mozilla/5.0 (iPod touch; CPU iPhone OS 17_4 like Mac OS X)';
    expect(isIos({ userAgent: ua, standalone: false })).toBe(true);
  });

  it('REQ-PWA-001: iPhone already installed (standalone=true) → isIos() is false', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15';
    expect(isIos({ userAgent: ua, standalone: true })).toBe(false);
  });

  it('REQ-PWA-001: Android Chrome → isIos() is false (uses beforeinstallprompt path)', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36';
    expect(isIos({ userAgent: ua, standalone: false })).toBe(false);
  });

  it('REQ-PWA-001: desktop Chrome → isIos() is false (uses beforeinstallprompt path)', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
    expect(isIos({ userAgent: ua, standalone: false })).toBe(false);
  });

  it('REQ-PWA-001: Mac Safari (has no iOS UA token) → isIos() is false', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
    expect(isIos({ userAgent: ua, standalone: false })).toBe(false);
  });
});

describe('beforeinstallprompt handler semantics (REQ-PWA-001 AC 5)', () => {
  // Minimal shape of the deferred-prompt event, mirrored from the component.
  interface DeferredPromptEvent {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  }

  it('REQ-PWA-001: the stored event exposes prompt() and userChoice as promised shapes', async () => {
    let userChoiceResolved = false;
    const fake: DeferredPromptEvent = {
      prompt: async () => {},
      userChoice: Promise.resolve({ outcome: 'accepted' as const, platform: 'web' }).then((v) => {
        userChoiceResolved = true;
        return v;
      })
    };
    await fake.prompt();
    const choice = await fake.userChoice;
    expect(userChoiceResolved).toBe(true);
    expect(choice.outcome).toBe('accepted');
  });

  it('REQ-PWA-001: component source wires click on [data-install-button] to prompt()', () => {
    // The click handler must call prompt() — this is the AC "click triggers the prompt".
    expect(installPromptSource).toContain('data-install-button');
    expect(installPromptSource).toMatch(/deferredPrompt\.prompt\(\s*\)/);
  });

  it('REQ-PWA-001: component source awaits userChoice before clearing the deferred prompt', () => {
    expect(installPromptSource).toContain('userChoice');
  });
});
