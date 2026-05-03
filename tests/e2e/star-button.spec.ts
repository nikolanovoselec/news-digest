// Implements REQ-STAR-001
//
// Live-site Playwright suite for the star toggle on /digest.
//
// Pins the regression that motivated this test: clicking the star
// button on a dashboard card was a silent no-op because the bundled
// `<script>import '~/scripts/card-interactions'</script>` inside
// `DigestCard.astro` was hoisted by Astro into an inline script tag
// and then CSP-blocked at runtime (`script-src 'self'`). The fix
// loads `/scripts/card-interactions.js` as a static-served module
// from `Base.astro` instead.
//
// Why an e2e test for this rather than a unit test: the unit test in
// `tests/reading/card-interactions.test.ts` exercises the imported
// module directly, so a CSP-blocked SCRIPT TAG passes the unit suite
// trivially. Only a real browser hitting the deployed CSP catches
// the regression.
//
// Authentication: inherits the storageState file written by
// tests/e2e/global-setup.ts. Skips when the token is unset.

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

test.describe('REQ-STAR-001 star toggle on /digest (live)', () => {
  test('clicking the star button flips aria-pressed and persists across reload', async ({
    page,
  }) => {
    // Capture every CSP violation the page emits — a regression that
    // re-introduces an inline script tag will fire one of these and
    // we want the test to fail loudly with the directive name in the
    // assertion message.
    const cspViolations: string[] = [];
    page.on('console', (msg) => {
      const txt = msg.text();
      if (txt.includes('Content Security Policy')) {
        cspViolations.push(txt);
      }
    });

    await page.goto('/digest', { waitUntil: 'networkidle' });

    const starButton = page.locator('[data-star-toggle]').first();
    await expect(starButton).toBeVisible();
    const initialPressed = await starButton.getAttribute('aria-pressed');
    const articleId = await starButton.getAttribute('data-article-id');
    expect(articleId, 'card must carry data-article-id').not.toBeNull();
    expect(articleId).not.toBe('');

    // Wait for the network response so we don't race the optimistic
    // flip — the assertion below would still pass if the flip were
    // optimistic-only, but we want to verify the round-trip succeeds.
    const responsePromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/articles/${articleId}/star`) && r.status() < 400,
    );

    await starButton.click();
    await responsePromise;

    const newPressed = await starButton.getAttribute('aria-pressed');
    expect(
      newPressed,
      'aria-pressed must flip after click — silent no-op means card-interactions.js never bound',
    ).not.toBe(initialPressed);

    // Reload and re-locate the same card to confirm the toggle stuck
    // server-side. Order is unstable on /digest (newest first), so
    // resolve by data-article-id.
    await page.reload({ waitUntil: 'networkidle' });
    const refreshedButton = page.locator(
      `[data-star-toggle][data-article-id="${articleId}"]`,
    );
    await expect(refreshedButton).toHaveAttribute('aria-pressed', newPressed!);

    // Restore the original state so the test is idempotent on the
    // shared synthetic-user account — without this, repeated runs
    // would alternately star and un-star the same article.
    const restorePromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/articles/${articleId}/star`) && r.status() < 400,
    );
    await refreshedButton.click();
    await restorePromise;
    await expect(refreshedButton).toHaveAttribute(
      'aria-pressed',
      initialPressed!,
    );

    expect(
      cspViolations,
      `CSP blocked one or more scripts: ${cspViolations.join(' | ')}`,
    ).toEqual([]);
  });
});
