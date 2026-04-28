// Implements REQ-READ-002, REQ-HIST-001, REQ-PWA-003
//
// Live-site Playwright suite for the view-transition contract.
//
// Pins the single-named-group invariant introduced in commit 1e569af:
// `DigestCard` no longer emits a default `transition:name`, and exactly
// one card carries `view-transition-name` per navigation. Without these
// assertions, a regression that re-introduced per-card naming would
// silently restore the O(N) snapshot bookkeeping that made `/history`
// feel sluggish vs `/digest`.
//
// Authentication: every test inherits the storageState file written
// by tests/e2e/global-setup.ts. Tests skip when the storageState is
// empty (the global-setup fallback when PLAYWRIGHT_DEV_BYPASS_TOKEN is
// missing). See playwright.config.ts for the wiring.

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

test.describe('REQ-READ-002 view-transition shaping (live)', () => {
  test('default render: zero cards carry an inline view-transition-name', async ({
    page,
  }) => {
    await page.goto('/digest', { waitUntil: 'networkidle' });
    const cardCount = await page.locator('[data-digest-card]').count();
    expect(cardCount).toBeGreaterThan(0);
    // The promotion handler in src/scripts/page-effects.ts only sets
    // `view-transition-name` AT navigation time; on a fresh page load
    // every card must be name-less.
    const namedCount = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll<HTMLAnchorElement>(
          '[data-digest-card] a.digest-card__link',
        ),
      ).filter((el) => el.style.viewTransitionName !== '').length;
    });
    expect(namedCount).toBe(0);
  });

  test('forward nav: clicked card gets a name and is the only one', async ({
    page,
  }) => {
    await page.goto('/digest', { waitUntil: 'networkidle' });
    const firstCard = page.locator('[data-digest-card]').first();
    const firstSlug = await firstCard.getAttribute('data-vt-slug');
    expect(firstSlug, 'first card must expose data-vt-slug').toBeTruthy();

    // Promotion fires on `astro:before-preparation`, BEFORE the loader
    // resolves. Hook into that to capture the named-count snapshot at
    // the exact moment the OLD page-snapshot is taken.
    await page.evaluate(() => {
      (window as unknown as { __vtNamedAtPrep?: number }).__vtNamedAtPrep = -1;
      document.addEventListener(
        'astro:before-preparation',
        () => {
          (window as unknown as { __vtNamedAtPrep?: number }).__vtNamedAtPrep =
            Array.from(
              document.querySelectorAll<HTMLAnchorElement>(
                '[data-digest-card] a.digest-card__link',
              ),
            ).filter((el) => el.style.viewTransitionName !== '').length;
        },
        { once: true },
      );
    });

    await firstCard.locator('a.digest-card__link').click();
    await page.waitForURL(/\/digest\/[^/]+\/[^/]+\/?$/);

    const namedAtPrep = await page.evaluate(
      () => (window as unknown as { __vtNamedAtPrep?: number }).__vtNamedAtPrep,
    );
    expect(namedAtPrep, 'exactly one card promoted at before-preparation').toBe(1);
  });

  test('backward nav: at most one named element exists immediately after swap', async ({
    page,
  }) => {
    // Looser-than-it-sounds invariant: `clearAllVtNames` (registered
    // after the promotion handler in the same `astro:after-swap`
    // listener block) may run before our test's once-listener fires,
    // collapsing the count to 0. Either count proves the contract:
    // at any post-swap observation point, at most one named card
    // exists. The previous "exactly one" framing was racy.
    await page.goto('/digest', { waitUntil: 'networkidle' });
    const firstCard = page.locator('[data-digest-card]').first();
    const firstSlug = await firstCard.getAttribute('data-vt-slug');
    expect(firstSlug).toBeTruthy();
    await firstCard.locator('a.digest-card__link').click();
    await page.waitForURL(/\/digest\/[^/]+\/[^/]+\/?$/);

    await page.evaluate(() => {
      (
        window as unknown as { __vtNamedPostBack?: number }
      ).__vtNamedPostBack = -1;
      document.addEventListener(
        'astro:after-swap',
        () => {
          (
            window as unknown as { __vtNamedPostBack?: number }
          ).__vtNamedPostBack = Array.from(
            document.querySelectorAll<HTMLAnchorElement>(
              '[data-digest-card] a.digest-card__link',
            ),
          ).filter((el) => el.style.viewTransitionName !== '').length;
        },
        { once: true },
      );
    });

    await page.locator('[data-article-back]').click();
    await page.waitForURL(/\/digest\/?$/);

    const namedPostBack = await page.evaluate(
      () =>
        (window as unknown as { __vtNamedPostBack?: number }).__vtNamedPostBack,
    );
    expect(namedPostBack === 0 || namedPostBack === 1).toBe(true);
  });
});

test.describe('REQ-HIST-001 history return-morph (live)', () => {
  test('back from article → /history settles in under 2s and clears all names', async ({
    page,
  }) => {
    await page.goto('/history', { waitUntil: 'networkidle' });
    const firstCard = page
      .locator('[data-history-day] [data-digest-card]')
      .first();
    // Defensive: history may be empty on a fresh deploy. Skip rather
    // than assert — empty /history is a separate failure mode.
    const cardCount = await firstCard.count();
    test.skip(cardCount === 0, '/history has no articles to morph');

    // Open the day so the card is in layout (mirrors what the user
    // does manually before clicking a card).
    const summary = firstCard.locator(
      'xpath=ancestor::details/summary[1]',
    );
    if ((await summary.count()) > 0) {
      await summary.first().click();
    }

    await firstCard.locator('a.digest-card__link').click();
    await page.waitForURL(/\/digest\/[^/]+\/[^/]+\/?$/);

    const start = Date.now();
    await page.locator('[data-article-back]').click();
    await page.waitForURL(/\/history\/?(\?.*)?$/);
    await page.waitForLoadState('networkidle');
    const elapsed = Date.now() - start;
    expect(elapsed, 'detail → /history return settles in <2s').toBeLessThan(2000);

    // After settle, every card should be name-less again.
    const lingering = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll<HTMLAnchorElement>(
          '[data-digest-card] a.digest-card__link',
        ),
      ).filter((el) => el.style.viewTransitionName !== '').length;
    });
    expect(lingering).toBe(0);
  });
});
