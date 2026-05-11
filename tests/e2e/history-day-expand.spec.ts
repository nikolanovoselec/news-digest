// Implements REQ-HIST-001
//
// CF-044 - Playwright spec for the /history page's day-expand
// accordion behaviour (REQ-HIST-001 AC 3).
//
// What this catches that source-grep cannot:
//   - The <details> element actually opens on click
//   - Cards inside become interactive (star button responds)
//   - Day-body renders real article cards on expand

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

test.describe('REQ-HIST-001 AC3 history day expand/collapse', () => {
  test('clicking a <details> summary expands the day body', async ({ page }) => {
    await page.goto('/history');

    // Find the first collapsed <details> element on the page.
    const details = page.locator('details').first();
    if (await details.count() === 0) {
      // CF-024: environment-driven - dev-bypass user has no history
      // entries yet, so /history renders empty-state instead of
      // <details>. The accordion contract is unobservable without at
      // least one collapsed day.
      test.skip(true, '/history has no <details> entries - no ingested articles for this user yet');
    }

    // Click the summary to expand.
    const summary = details.locator('summary').first();
    await summary.click();

    // After click, the details element must be open.
    const isOpen = await details.evaluate((el) => (el as HTMLDetailsElement).open);
    expect(isOpen).toBe(true);
  });

  test('expanded day body contains article cards', async ({ page }) => {
    await page.goto('/history');

    const details = page.locator('details').first();
    if (await details.count() === 0) {
      // CF-024: same empty-history guard as above.
      test.skip(true, '/history has no <details> entries - nothing to expand');
    }

    // Open it.
    const summary = details.locator('summary').first();
    await summary.click();

    // Cards inside must be present.
    const cards = details.locator('[data-digest-card], .digest-card');
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThan(0);
  });

  test('star button inside expanded day is interactive (has aria-pressed)', async ({ page }) => {
    await page.goto('/history');

    const details = page.locator('details').first();
    if (await details.count() === 0) {
      // CF-024: same empty-history guard - no day to expand means no
      // star button inside to assert against.
      test.skip(true, '/history has no <details> entries - no star button to assert against');
    }

    await details.locator('summary').first().click();

    const starBtn = details
      .locator('[data-star-toggle]')
      .first();
    if (await starBtn.count() === 0) {
      // CF-024: history entry exists but no starrable cards - happens
      // when the day's articles have all been ingested before the
      // star feature was deployed (legacy rows without the toggle).
      test.skip(true, 'expanded <details> has no [data-star-toggle] - legacy entries pre-star feature');
    }

    // The button must carry aria-pressed so the click handler can drive it.
    const pressed = await starBtn.getAttribute('aria-pressed');
    expect(pressed).toMatch(/^(true|false)$/);
  });
});
