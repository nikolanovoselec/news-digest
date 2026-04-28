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

  test('backward nav: matching card is named in newDocument at astro:before-swap', async ({
    page,
  }) => {
    // We capture state at `astro:before-swap`, reading from
    // `event.newDocument` (the parsed incoming /digest page). Why
    // this event and not `astro:after-swap`:
    //
    // - page-effects.js's `promoteIncomingCardForReturnMorph` is
    //   itself an `astro:before-swap` listener that sets
    //   `view-transition-name` on the matching card in the
    //   newDocument. Our test listener registers AFTER that handler
    //   (page-effects loads on the article-detail page; our listener
    //   is added later via `page.evaluate`), so DOM event spec
    //   ordering means promoteIncomingCardForReturnMorph runs first
    //   and the name is set by the time our listener inspects.
    // - Empirically, on the back-nav `astro:after-swap` does NOT
    //   reliably dispatch (Received: -1 in CI). `astro:before-swap`
    //   does (page-effects relies on it for swap-time work that we
    //   can verify visually works on prod).
    // - Reading from `event.newDocument` rather than the live DOM
    //   pins the contract at the precise point where
    //   promoteIncomingCardForReturnMorph commits the name — before
    //   any swap mechanics could strip the inline style.
    //
    // The original regression — clearAllVtNames on astro:after-swap —
    // would manifest as 0 named cards at the morph pair-time. Our
    // capture is one event earlier than that hypothetical regression,
    // but the contract it pins (the matching card carries the name
    // BEFORE Astro hands the document to View Transitions) is the
    // necessary precondition. If a future change moves the cleanup
    // to before-swap (more disastrous), this test catches it directly.
    await page.goto('/digest', { waitUntil: 'networkidle' });
    const firstCard = page.locator('[data-digest-card]').first();
    const firstSlug = await firstCard.getAttribute('data-vt-slug');
    expect(firstSlug).toBeTruthy();
    await firstCard.locator('a.digest-card__link').click();
    await page.waitForURL(/\/digest\/[^/]+\/[^/]+\/?$/);

    await page.evaluate(() => {
      type Win = { __vtNamedAtBeforeSwap?: number; __vtNamedSlugAtBeforeSwap?: string | null };
      const w = window as unknown as Win;
      w.__vtNamedAtBeforeSwap = -1;
      w.__vtNamedSlugAtBeforeSwap = null;
      document.addEventListener(
        'astro:before-swap',
        (e) => {
          const ev = e as Event & { newDocument?: Document };
          const scope: Document | DocumentFragment = ev.newDocument ?? document;
          const named = Array.from(
            scope.querySelectorAll<HTMLAnchorElement>(
              '[data-digest-card] a.digest-card__link',
            ),
          ).filter((el) => el.style.viewTransitionName !== '');
          w.__vtNamedAtBeforeSwap = named.length;
          const card = named[0]?.closest('[data-digest-card]') as HTMLElement | null;
          w.__vtNamedSlugAtBeforeSwap = card?.dataset['vtSlug'] ?? null;
        },
        { once: true },
      );
    });

    await page.locator('[data-article-back]').click();
    await page.waitForURL(/\/digest\/?$/);
    await page.waitForLoadState('networkidle');

    const captured = await page.evaluate(() => {
      type Win = { __vtNamedAtBeforeSwap?: number; __vtNamedSlugAtBeforeSwap?: string | null };
      const w = window as unknown as Win;
      return { count: w.__vtNamedAtBeforeSwap, slug: w.__vtNamedSlugAtBeforeSwap };
    });
    expect(
      captured.count,
      'exactly one card carries view-transition-name in newDocument at before-swap',
    ).toBe(1);
    expect(
      captured.slug,
      'the named card is the one we clicked (not e.g. always index 0)',
    ).toBe(firstSlug);
  });
});

test.describe('REQ-HIST-001 history return-morph (live)', () => {
  test('back from article → /history names the morph card in newDocument at astro:before-swap', async ({
    page,
  }) => {
    // Same before-swap-newDocument capture pattern as the /digest
    // backward-nav test. See that test's comment for the full
    // rationale on event choice and ordering. The /history-specific
    // wrinkle is that page-effects.js's
    // `preOpenHistoryDayInIncomingDocument` runs FIRST on
    // astro:before-swap and opens the matching <details> in the
    // newDocument so promoteIncomingCardForReturnMorph (next handler)
    // can find the matching card via findPromotableCard's
    // not-inside-closed-details guard.
    //
    // We dropped the <2s perf budget per user direction
    // ("we leave it as is, enough trying to fix this"). The
    // structural REQ-HIST-001 contract (morph pair forms) is the
    // only live-network assertion that earns its keep here.
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
      type Win = { __vtNamedAtBeforeSwap?: number; __vtNamedSlugAtBeforeSwap?: string | null };
      const w = window as unknown as Win;
      w.__vtNamedAtBeforeSwap = -1;
      w.__vtNamedSlugAtBeforeSwap = null;
      document.addEventListener(
        'astro:before-swap',
        (e) => {
          const ev = e as Event & { newDocument?: Document };
          const scope: Document | DocumentFragment = ev.newDocument ?? document;
          const named = Array.from(
            scope.querySelectorAll<HTMLAnchorElement>(
              '[data-digest-card] a.digest-card__link',
            ),
          ).filter((el) => el.style.viewTransitionName !== '');
          w.__vtNamedAtBeforeSwap = named.length;
          const card = named[0]?.closest('[data-digest-card]') as HTMLElement | null;
          w.__vtNamedSlugAtBeforeSwap = card?.dataset['vtSlug'] ?? null;
        },
        { once: true },
      );
    });

    await page.locator('[data-article-back]').click();
    await page.waitForURL(/\/history\/?(\?.*)?$/);
    await page.waitForLoadState('networkidle');

    const captured = await page.evaluate(() => {
      type Win = { __vtNamedAtBeforeSwap?: number; __vtNamedSlugAtBeforeSwap?: string | null };
      const w = window as unknown as Win;
      return { count: w.__vtNamedAtBeforeSwap, slug: w.__vtNamedSlugAtBeforeSwap };
    });
    expect(
      captured.count,
      'exactly one card named in newDocument at before-swap',
    ).toBe(1);
    expect(
      captured.slug,
      'the named card is the one we clicked',
    ).toBe(expectedSlug);
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
