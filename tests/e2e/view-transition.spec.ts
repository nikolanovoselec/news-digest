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

  test('backward nav: matching card is named at astro:after-swap (the morph pair-time)', async ({
    page,
  }) => {
    // The View Transitions API captures the NEW snapshot AFTER the
    // update callback resolves; `astro:after-swap` fires INSIDE that
    // callback, before snapshot capture. So the named-count seen at
    // after-swap is what determines whether the morph pair forms.
    //
    // We capture state at after-swap (not after settle): the post-
    // settle DOM legitimately ends up with zero inline
    // `view-transition-name` styles in production — the browser's
    // own snapshot lifecycle and Astro's swap mechanics together
    // strip the inline style by the time `networkidle` resolves, but
    // the morph DID pair successfully (verified by the user manually,
    // and pinned here at the exact moment the API needs it).
    //
    // The original regression — clearAllVtNames on astro:after-swap —
    // would manifest as 0 named cards at this exact capture point,
    // because the listener would run before our capture. This test
    // catches that.
    await page.goto('/digest', { waitUntil: 'networkidle' });
    const firstCard = page.locator('[data-digest-card]').first();
    const firstSlug = await firstCard.getAttribute('data-vt-slug');
    expect(firstSlug).toBeTruthy();
    await firstCard.locator('a.digest-card__link').click();
    await page.waitForURL(/\/digest\/[^/]+\/[^/]+\/?$/);

    // Install a one-shot capture on the article-detail page. The
    // listener survives the SPA back-nav (Astro's ClientRouter swaps
    // body, never replaces window/document), and fires once on the
    // back-nav's after-swap.
    await page.evaluate(() => {
      (window as unknown as { __vtNamedAtAfterSwap?: number }).__vtNamedAtAfterSwap = -1;
      document.addEventListener(
        'astro:after-swap',
        () => {
          (window as unknown as { __vtNamedAtAfterSwap?: number }).__vtNamedAtAfterSwap =
            Array.from(
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
    await page.waitForLoadState('networkidle');

    const namedAtAfterSwap = await page.evaluate(
      () => (window as unknown as { __vtNamedAtAfterSwap?: number }).__vtNamedAtAfterSwap,
    );
    expect(
      namedAtAfterSwap,
      'exactly one card carries view-transition-name at after-swap (morph pair-time)',
    ).toBe(1);
  });
});

test.describe('REQ-HIST-001 history return-morph (live)', () => {
  test('back from article → /history names the morph card at astro:after-swap', async ({
    page,
  }) => {
    // Same pair-time-capture pattern as the /digest backward-nav test.
    // We do NOT assert post-settle named-cards on /history — the
    // post-settle inline style is cleared by the same browser /
    // Astro lifecycle that affects /digest. Pinning the regression
    // means catching `clearAllVtNames` reintroduced into the
    // after-swap path, which would zero out our capture.
    //
    // We also drop the <2s perf budget here. The user has accepted
    // that /history is structurally slower than /digest (more cards
    // in opened day-groups). The structural REQ-HIST-001 contract
    // (the morph pair forms) is the only assertion that earns its
    // keep on a live network.
    await page.goto('/history', { waitUntil: 'networkidle' });
    const firstCard = page
      .locator('[data-history-day] [data-digest-card]')
      .first();
    const cardCount = await firstCard.count();
    test.skip(cardCount === 0, '/history has no articles to morph');

    const expectedSlug = await firstCard.getAttribute('data-vt-slug');

    const summary = firstCard.locator(
      'xpath=ancestor::details/summary[1]',
    );
    if ((await summary.count()) > 0) {
      await summary.first().click();
    }

    await firstCard.locator('a.digest-card__link').click();
    await page.waitForURL(/\/digest\/[^/]+\/[^/]+\/?$/);

    await page.evaluate(() => {
      (window as unknown as { __vtNamedAtAfterSwap?: number }).__vtNamedAtAfterSwap = -1;
      document.addEventListener(
        'astro:after-swap',
        () => {
          (window as unknown as { __vtNamedAtAfterSwap?: number }).__vtNamedAtAfterSwap =
            Array.from(
              document.querySelectorAll<HTMLAnchorElement>(
                '[data-digest-card] a.digest-card__link',
              ),
            ).filter((el) => el.style.viewTransitionName !== '').length;
        },
        { once: true },
      );
    });

    await page.locator('[data-article-back]').click();
    await page.waitForURL(/\/history\/?(\?.*)?$/);
    await page.waitForLoadState('networkidle');

    const namedAtAfterSwap = await page.evaluate(
      () => (window as unknown as { __vtNamedAtAfterSwap?: number }).__vtNamedAtAfterSwap,
    );
    expect(
      namedAtAfterSwap,
      `exactly one card named at after-swap (expected slug ${expectedSlug})`,
    ).toBe(1);
  });
});

test.describe('REQ-READ-002 / REQ-HIST-001 perf-comparability (live)', () => {
  // Skipped intentionally. The structural contract tests above pin
  // the morph-pair mechanism — that's the regression we care about.
  // The remaining /history-vs-/digest sluggishness is structural
  // (more cards in opened day-groups, more layout work) and the user
  // has accepted it as-is. Resurrect this test if a future refactor
  // claims to close the gap and we want a numeric guard.
  test.skip(
    'history back-nav is comparable to digest back-nav — accepted as structurally slower',
    () => {},
  );
});
