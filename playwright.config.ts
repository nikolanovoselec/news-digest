// Implements REQ-READ-002, REQ-HIST-001, REQ-PWA-003
//
// Playwright config for live-site smoke tests.
//
// These tests run against a deployed Worker (default
// https://news.graymatter.ch) and exercise behaviours that vitest
// cannot validate: real browser layout, view-transition snapshots,
// scroll restore, and the click-to-morph contract on /digest and
// /history. They are NOT part of the default `npm test` pipeline.
//
// How to run:
//   1. `DEV_BYPASS_TOKEN=...` is set as a Worker secret on the
//      target deployment AND exposed as `PLAYWRIGHT_DEV_BYPASS_TOKEN`
//      in the runner's environment (GitHub Actions secret of the
//      same name; for manual runs, export it in your shell).
//   2. CI: trigger the `Playwright E2E` workflow via workflow_dispatch.
//      Optional `base_url` input lets the run target a preview deploy.
//   3. Local: `PLAYWRIGHT_BASE_URL=https://news.graymatter.ch
//      PLAYWRIGHT_DEV_BYPASS_TOKEN=... npx playwright test`.
//
// The synthetic `__e2e__` user (provisioned by migrations/0006_e2e_user.sql)
// owns every mutation triggered through this suite — the operator's
// real account is never touched. See `src/pages/api/dev/login.ts` for
// the auth contract.

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://news.graymatter.ch';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // serial to avoid rate-limit churn against the live Worker
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The dev-login bypass token is read by tests/e2e/_auth.ts and
    // exchanged for a session cookie before the suite runs.
    extraHTTPHeaders: {
      Origin: BASE_URL,
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
