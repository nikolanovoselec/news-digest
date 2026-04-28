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

  test('backward nav: settled /digest carries zero lingering view-transition-names', async ({
    page,
  }) => {
    // Mid-swap observation is racy — `clearAllVtNames` (registered
    // before any external listener via the page-effects bootstrap)
    // can fire before a once-listener attached after page-load and
    // leaves the captured count at -1. The CONTRACT we care about is
    // the END STATE: after the back-nav settles, no card carries a
    // leftover `view-transition-name`. If a regression skipped the
    // cleanup, a name would persist on the live DOM and the next
    // navigation would drag it into the snapshot — exactly the
    // O(N) bookkeeping the perf refactor eliminated.
    await page.goto('/digest', { waitUntil: 'networkidle' });
    const firstCard = page.locator('[data-digest-card]').first();
    const firstSlug = await firstCard.getAttribute('data-vt-slug');
    expect(firstSlug).toBeTruthy();
    await firstCard.locator('a.digest-card__link').click();
    await page.waitForURL(/\/digest\/[^/]+\/[^/]+\/?$/);

    await page.locator('[data-article-back]').click();
    await page.waitForURL(/\/digest\/?$/);
    await page.waitForLoadState('networkidle');

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

test.describe('REQ-READ-002 / REQ-HIST-001 perf-comparability (live)', () => {
  // The user's original complaint was SUBJECTIVE: "/history feels
  // sluggish vs /digest". The contract tests above pin the structural
  // mechanism (single named group, cleanup on after-swap) but cannot
  // validate the perception directly. This test makes the comparison
  // objective: time the back-from-article navigation on BOTH origins
  // and assert the /history pass is no worse than ~1.6× the /digest
  // pass. A regression that re-introduced the O(N) snapshot
  // bookkeeping or the synchronous open-<details> reflow would widen
  // the gap and trip the budget.

  async function timeBackFromDetail(
    page: import('@playwright/test').Page,
    overviewPath: '/digest' | '/history',
    cardSelector: string,
  ): Promise<number | null> {
    await page.goto(overviewPath, { waitUntil: 'networkidle' });
    const card = page.locator(cardSelector).first();
    if ((await card.count()) === 0) return null;
    if (overviewPath === '/history') {
      const summary = card.locator('xpath=ancestor::details/summary[1]');
      if ((await summary.count()) > 0) {
        await summary.first().click();
      }
    }
    await card.locator('a.digest-card__link').click();
    await page.waitForURL(/\/digest\/[^/]+\/[^/]+\/?$/);
    const start = Date.now();
    await page.locator('[data-article-back]').click();
    const target = overviewPath === '/digest'
      ? /\/digest\/?$/
      : /\/history\/?(\?.*)?$/;
    await page.waitForURL(target);
    await page.waitForLoadState('networkidle');
    return Date.now() - start;
  }

  test('history back-nav is comparable to digest back-nav (≤ 1.6× duration)', async ({
    page,
  }) => {
    // Important: /digest's article-detail__back-link href is "/digest"
    // unconditionally, so leaving from a /history article also lands
    // on /digest by default. We override by directly navigating to
    // /history first then clicking through, so the back-link's
    // ClientRouter intercept resolves naturally — the SAME mechanism
    // the user experiences when reading from /history.

    const digestMs = await timeBackFromDetail(
      page,
      '/digest',
      '[data-digest-card]',
    );
    test.skip(digestMs === null, '/digest has no cards on this deploy');
    if (digestMs === null) return;

    const historyMs = await timeBackFromDetail(
      page,
      '/history',
      '[data-history-day] [data-digest-card]',
    );
    test.skip(historyMs === null, '/history has no cards on this deploy');
    if (historyMs === null) return;

    // 1.6× headroom absorbs CI runner jitter without permitting a real
    // O(N)-vs-O(1) regression to slip through. On the prod deploy
    // post-1e569af both pages should round in roughly the same wall
    // time (Astro ClientRouter network fetch + paint dominates;
    // snapshot-capture cost is now O(1) on both).
    expect(
      historyMs,
      `history=${historyMs}ms, digest=${digestMs}ms — gap > 1.6× suggests an O(N) regression`,
    ).toBeLessThanOrEqual(Math.round(digestMs * 1.6));
  });
});
