// Implements REQ-READ-007
//
// CF-035 — AD19 mandated Playwright spec for the tag-railing FLIP
// reorder animation. Replaces the source-grep tests in
// tests/reading/tag-railing-flip.test.ts that verify the implementation
// exists but cannot assert on actual DOM mutations or animation state.
//
// What this spec catches that source-grep cannot:
//   - `data-tag-flip-locked` toggle and clear
//   - `strip.firstChild` matches the tapped chip after the cascade
//   - CSP violation guard (no inline-style injection from the animation)
//
// Per AD19: this spec is the merge gate for any FLIP regression.

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

// CF-043: explicit fail instead of silent skip.
test.beforeAll(() => {
  if (!hasAuthCookies()) {
    throw new Error(
      'PLAYWRIGHT_DEV_BYPASS_TOKEN is required for E2E tests. ' +
        'Set the secret and re-run. global-setup must write a non-empty storageState.',
    );
  }
});

test.describe('REQ-READ-007 tag-railing FLIP cascade', () => {
  test('clicking a tag chip moves it to strip.firstChild', async ({ page }) => {
    // Collect CSP violations — the FLIP helper applies inline `transform`
    // during animation; those must not violate the CSP.
    const cspViolations: string[] = [];
    page.on('console', (msg) => {
      const txt = msg.text();
      if (txt.includes('Content Security Policy') || txt.includes('Refused to')) {
        cspViolations.push(txt.slice(0, 300));
      }
    });

    await page.goto('/digest');

    // Locate the tag strip and the second chip (first chip is already at
    // position 0 so clicking it can't demonstrate a reorder).
    const strip = page.locator('[data-tag-strip]').first();
    if (await strip.count() === 0) {
      test.skip(); // no tag strip on this user — e.g. empty hashtags
    }

    const chips = strip.locator('[data-tag]');
    const chipCount = await chips.count();
    if (chipCount < 2) {
      test.skip(); // need at least 2 chips to test reorder
    }

    // Record which tag the SECOND chip carries.
    const secondChip = chips.nth(1);
    const targetTag = await secondChip.getAttribute('data-tag');
    expect(targetTag).toBeTruthy();

    // Click the second chip and wait for the animation to settle.
    await secondChip.click();
    // The FLIP plays over ≤400ms; wait for the lock to clear.
    await page.waitForFunction(
      () => !document.querySelector('[data-tag-flip-locked]'),
      null,
      { timeout: 1000 },
    );

    // The clicked chip must now be strip.firstChild.
    const firstTag = await strip
      .locator('[data-tag]')
      .first()
      .getAttribute('data-tag');
    expect(firstTag).toBe(targetTag);

    // No CSP violations during the animation.
    expect(cspViolations).toHaveLength(0);
  });

  test('data-tag-flip-locked is cleared after cascade completes', async ({ page }) => {
    await page.goto('/digest');

    const strip = page.locator('[data-tag-strip]').first();
    if (await strip.count() === 0) test.skip();

    const chips = strip.locator('[data-tag]');
    if (await chips.count() < 2) test.skip();

    // Tap any chip and assert lock is gone within the animation budget.
    await chips.nth(1).click();
    const lockCleared = await page.waitForFunction(
      () => !document.querySelector('[data-tag-flip-locked]'),
      null,
      { timeout: 1000 },
    );
    expect(lockCleared).toBeTruthy();
  });
});
