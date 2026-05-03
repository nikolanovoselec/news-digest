// Implements REQ-OPS-003
//
// Live-site Playwright suite that asserts the tightened CSP (CF-014)
// fires zero `securitypolicyviolation` events across the core
// navigation flow. This is the merge gate for any CSP change.
//
// Why this exists: Astro 5.x has historically interacted badly with
// strict CSPs on this project. The card-interactions regression that
// produced REQ-STAR-001's e2e test was caused by an inline script tag
// that only fails in a real browser under the deployed CSP — a unit
// test trivially passes the imported-module behaviour.
//
// Two reliability fixes vs the first cut:
//   (1) Violations are collected via Playwright's `page.on('console')`
//       AND a per-navigation initScript that buffers into sessionStorage
//       (not `window`) so a navigation between subscribe and read does
//       not drop the buffer.
//   (2) A positive-control test injects an inline `<script>` against
//       the deployed CSP and asserts that DOES fire a violation. Without
//       this, refactoring the listener to a no-op would leave the gate
//       silently green forever.

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

interface StorageStateShape {
  cookies: { name: string; value: string }[];
}

function hasAuthCookies(): boolean {
  try {
    const raw = readFileSync('.playwright/storageState.json', 'utf8');
    const parsed = JSON.parse(raw) as StorageStateShape;
    return Array.isArray(parsed.cookies) && parsed.cookies.length > 0;
  } catch {
    return false;
  }
}

test.beforeAll(() => {
  test.skip(
    !hasAuthCookies(),
    'PLAYWRIGHT_DEV_BYPASS_TOKEN not set — global-setup wrote an empty storageState.',
  );
});

test.describe('REQ-OPS-003 CSP violation gate', () => {
  test('zero securitypolicyviolation events across /digest navigation flow', async ({ page }) => {
    // Console violations: Chromium emits a console error for each CSP
    // block in addition to the event. Capturing both gives belt-and-
    // suspenders coverage even if the addInitScript approach loses a
    // race against the first navigation's parse.
    const consoleViolations: string[] = [];
    page.on('console', (msg) => {
      const txt = msg.text();
      if (txt.includes('Content Security Policy') || txt.includes('Refused to')) {
        consoleViolations.push(txt.slice(0, 300));
      }
    });

    // Buffer event-based violations into sessionStorage so navigating
    // away does not wipe the buffer. addInitScript runs on every new
    // document; the listener we attach there persists each violation
    // immediately into sessionStorage so we can read every navigation's
    // findings at the end of the flow, not just the last page's.
    await page.addInitScript(() => {
      const KEY = '__cspViolations';
      window.addEventListener('securitypolicyviolation', (e) => {
        const ev = e as SecurityPolicyViolationEvent;
        const existing = sessionStorage.getItem(KEY);
        const arr = existing !== null ? (JSON.parse(existing) as unknown[]) : [];
        arr.push({
          directive: ev.violatedDirective,
          blocked: ev.blockedURI,
          source: ev.sourceFile ?? '',
          page: window.location.pathname,
        });
        sessionStorage.setItem(KEY, JSON.stringify(arr));
      });
    });

    // Walk the high-value navigation paths: dashboard load, article
    // detail, view-transition back, view-transition forward.
    await page.goto('/digest', { waitUntil: 'networkidle' });
    const firstCard = page.locator('[data-article-id]').first();
    await expect(firstCard).toBeVisible();
    const articleHref = await firstCard
      .locator('a[href^="/digest/"]')
      .first()
      .getAttribute('href');
    if (articleHref !== null && articleHref !== '') {
      await page.goto(articleHref, { waitUntil: 'networkidle' });
      await page.goBack({ waitUntil: 'networkidle' });
      await page.goForward({ waitUntil: 'networkidle' });
    }

    const eventViolations = await page.evaluate(() => {
      const raw = sessionStorage.getItem('__cspViolations');
      return raw !== null ? (JSON.parse(raw) as unknown[]) : [];
    });

    expect(
      [...consoleViolations, ...eventViolations],
      `CSP violations during navigation: console=${JSON.stringify(consoleViolations)} events=${JSON.stringify(eventViolations)}`,
    ).toEqual([]);
  });

  test('positive control: an injected inline script DOES trigger a violation', async ({ page }) => {
    // Without this, a regression that breaks the listener (or a CSP
    // that goes permissive enough to allow inline scripts) would leave
    // the negative test silently green forever. The deployed CSP has
    // `script-src 'self'` so an inline `<script>` MUST fire a
    // violation — if it doesn't, every other test in this file is
    // worthless.
    const consoleViolations: string[] = [];
    page.on('console', (msg) => {
      const txt = msg.text();
      if (txt.includes('Content Security Policy') || txt.includes('Refused to')) {
        consoleViolations.push(txt.slice(0, 300));
      }
    });

    await page.addInitScript(() => {
      const KEY = '__cspViolations';
      window.addEventListener('securitypolicyviolation', (e) => {
        const ev = e as SecurityPolicyViolationEvent;
        const existing = sessionStorage.getItem(KEY);
        const arr = existing !== null ? (JSON.parse(existing) as unknown[]) : [];
        arr.push({ directive: ev.violatedDirective, blocked: ev.blockedURI });
        sessionStorage.setItem(KEY, JSON.stringify(arr));
      });
    });

    await page.goto('/digest', { waitUntil: 'networkidle' });

    // Inject an inline script via a same-document evaluation. The
    // browser parses + tries to execute it under the page's CSP, fires
    // a securitypolicyviolation for `script-src`, and the listener
    // (or console) records it. Use addScriptTag with `content:` —
    // this is the Playwright primitive for "actually inject a script
    // tag that the browser will see at parse time".
    let injectionThrew = false;
    try {
      await page.addScriptTag({ content: 'window.__shouldNotRun = true' });
    } catch {
      // CSP may surface as a Playwright error rather than a runtime
      // event in some browser versions — both outcomes prove the
      // policy fired. Either branch satisfies the assertion below.
      injectionThrew = true;
    }

    // Give the violation event a tick to land in sessionStorage.
    await page.waitForTimeout(50);
    const eventViolations = await page.evaluate(() => {
      const raw = sessionStorage.getItem('__cspViolations');
      return raw !== null ? (JSON.parse(raw) as unknown[]) : [];
    });

    const fired =
      consoleViolations.length > 0 ||
      eventViolations.length > 0 ||
      injectionThrew;
    expect(
      fired,
      `Positive control failed: inline-script injection produced no CSP violation. The negative test in this file is therefore unreliable. console=${JSON.stringify(consoleViolations)} events=${JSON.stringify(eventViolations)} injectionThrew=${injectionThrew}`,
    ).toBe(true);
  });
});
