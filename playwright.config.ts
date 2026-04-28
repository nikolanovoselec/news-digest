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
// Auth model: tests/e2e/global-setup.ts runs ONCE before any test,
// mints a synthetic-user session via /api/dev/login through a
// standalone APIRequestContext (which does NOT participate in any
// test trace), and writes the cookies to .playwright/storageState.json.
// Tests load that storageState below, so the Bearer token never lands
// in a per-test trace artifact and per-test fixtures don't need to
// re-mint. See src/pages/api/dev/login.ts for the auth contract; the
// synthetic `__e2e__` user (migrations/0006_e2e_user.sql) owns every
// mutation, so the operator's real account is never touched.

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://news.graymatter.ch';
const STORAGE_STATE = '.playwright/storageState.json';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // serial to avoid rate-limit churn against the live Worker
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: BASE_URL,
    storageState: STORAGE_STATE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    extraHTTPHeaders: {
      Origin: BASE_URL,
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
