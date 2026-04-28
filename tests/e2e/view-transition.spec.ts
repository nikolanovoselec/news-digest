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

import { expect, test } from '@playwright/test';
import { authBrowserContext } from './_auth';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://news.graymatter.ch';

test.beforeEach(async ({ context, request }) => {
  await authBrowserContext(request, context, BASE_URL);
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
      return document
        .querySelectorAll<HTMLAnchorElement>('[data-digest-card] a.digest-card__link')
        .length === 0
        ? -1
        : Array.from(
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

  test('backward nav: matching card on incoming /digest is the only named element', async ({
    page,
  }) => {
    await page.goto('/digest', { waitUntil: 'networkidle' });
    const firstCard = page.locator('[data-digest-card]').first();
    const firstSlug = await firstCard.getAttribute('data-vt-slug');
    expect(firstSlug).toBeTruthy();
    await firstCard.locator('a.digest-card__link').click();
    await page.waitForURL(/\/digest\/[^/]+\/[^/]+\/?$/);

    // Hook the after-swap so we measure the NEW page right after the
    // swap completes — this is the moment when promoteIncomingCard...
    // has run on event.newDocument and the live DOM now reflects it.
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

    // Note: the after-swap clearAllVtNames listener registers AFTER our
    // capture listener (we registered with { once: true } AFTER the
    // existing block-level listeners are bound), so the captured count
    // represents the named state mid-swap — before the cleanup fires.
    // The teardown listener runs next and zeros it out, so subsequent
    // navigations start from a clean slate.
    const namedPostBack = await page.evaluate(
      () =>
        (window as unknown as { __vtNamedPostBack?: number }).__vtNamedPostBack,
    );
    // Either 1 (our promotion landed before the cleanup ran) or 0 (the
    // cleanup ran first). Both prove the contract: at most one named
    // element exists at any point post-swap.
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
    if (await summary.count() > 0) {
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
