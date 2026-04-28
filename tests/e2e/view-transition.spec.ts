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

  test('backward nav: settled /digest carries exactly one named card (the morph target)', async ({
    page,
  }) => {
    // The View Transitions API captures the NEW snapshot AFTER the
    // update callback resolves. Cleanup CANNOT happen on
    // astro:after-swap (which fires inside the callback) — it would
    // strip the `view-transition-name` from the matching card BEFORE
    // the new snapshot is taken, breaking the pair and silently
    // degrading to a root cross-fade. The contract is therefore that
    // ONE name persists on the live DOM after a successful back-nav
    // (the matching card the morph just paired with), and cleanup is
    // deferred to the next forward click via the
    // `promoteSourceCardForOutgoingMorph` clearAllVtNames pass.
    //
    // A regression that EITHER (a) re-adds clearAllVtNames on
    // astro:after-swap (lingering would be 0, morph fails) OR (b) fails
    // to set the name in promoteIncomingCardForReturnMorph (lingering
    // would be 0, morph fails) — both manifest as lingering=0 here.
    await page.goto('/digest', { waitUntil: 'networkidle' });
    const firstCard = page.locator('[data-digest-card]').first();
    const firstSlug = await firstCard.getAttribute('data-vt-slug');
    expect(firstSlug).toBeTruthy();
    await firstCard.locator('a.digest-card__link').click();
    await page.waitForURL(/\/digest\/[^/]+\/[^/]+\/?$/);

    await page.locator('[data-article-back]').click();
    await page.waitForURL(/\/digest\/?$/);
    await page.waitForLoadState('networkidle');

    const namedSlugs = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-digest-card][data-vt-slug]',
        ),
      )
        .filter((card) => {
          const link = card.querySelector<HTMLAnchorElement>(
            'a.digest-card__link',
          );
          return link !== null && link.style.viewTransitionName !== '';
        })
        .map((c) => c.dataset['vtSlug'] ?? '');
    });
    expect(namedSlugs).toHaveLength(1);
    expect(namedSlugs[0]).toBe(firstSlug);
  });
});

test.describe('REQ-HIST-001 history return-morph (live)', () => {
  test('back from article → /history settles in under 2s and the morph card retains its name', async ({
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

    const expectedSlug = await firstCard.getAttribute('data-vt-slug');

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

    // The matching card should retain its `view-transition-name` after
    // settle — clearing on astro:after-swap would strip it before the
    // new snapshot is captured and the morph would fail to pair.
    const namedSlugs = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-digest-card][data-vt-slug]',
        ),
      )
        .filter((card) => {
          const link = card.querySelector<HTMLAnchorElement>(
            'a.digest-card__link',
          );
          return link !== null && link.style.viewTransitionName !== '';
        })
        .map((c) => c.dataset['vtSlug'] ?? '');
    });
    expect(namedSlugs).toHaveLength(1);
    expect(namedSlugs[0]).toBe(expectedSlug);
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

  // 1.6× ratio detects O(N) vs O(1) regressions; the +200ms additive
  // floor absorbs single-RTT network jitter to a live Worker without
  // weakening that detection. Both apply, whichever is larger wins.
  const MAX_HISTORY_DIGEST_RATIO = 1.6;
  const NETWORK_JITTER_FLOOR_MS = 200;
  // Run each navigation 3 times and compare medians. √n variance
  // reduction on a noisy live measurement; a single bad RTT no longer
  // tips the budget.
  const SAMPLES = 3;

  function median(xs: number[]): number {
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  }

  test('history back-nav is comparable to digest back-nav (median of 3 samples, ≤ 1.6× or ≤ +200ms)', async ({
    page,
  }) => {
    // The back-link in src/pages/digest/[id]/[slug].astro has a static
    // href="/digest", but src/scripts/article-detail.ts hijacks the
    // click and calls history.back() when history.state.index > 0
    // (true after our SPA card click). history.back() returns to the
    // previous SPA entry — /history when the test arrived from there,
    // /digest when it arrived from there. The static href is never
    // followed, so the test exercises the same code path the user hits.

    const digestSamples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const ms = await timeBackFromDetail(page, '/digest', '[data-digest-card]');
      test.skip(ms === null, '/digest has no cards on this deploy');
      if (ms === null) return;
      digestSamples.push(ms);
    }
    const digestMs = median(digestSamples);

    const historySamples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const ms = await timeBackFromDetail(
        page,
        '/history',
        '[data-history-day] [data-digest-card]',
      );
      test.skip(ms === null, '/history has no cards on this deploy');
      if (ms === null) return;
      historySamples.push(ms);
    }
    const historyMs = median(historySamples);

    const budget = Math.max(
      Math.round(digestMs * MAX_HISTORY_DIGEST_RATIO),
      digestMs + NETWORK_JITTER_FLOOR_MS,
    );
    expect(
      historyMs,
      `history=${historyMs}ms (samples=${historySamples.join('/')}), ` +
        `digest=${digestMs}ms (samples=${digestSamples.join('/')}), ` +
        `budget=${budget}ms — gap suggests an O(N) regression`,
    ).toBeLessThanOrEqual(budget);
  });
});
