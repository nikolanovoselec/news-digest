// Implements REQ-READ-002, REQ-HIST-001
//
// Global setup for the live Playwright suite. Runs ONCE before any
// test starts and mints a synthetic-user session via /api/dev/login,
// saving the resulting cookies to `.playwright/storageState.json` so
// every test inherits an authenticated browser context via
// `playwright.config.ts`'s `use.storageState`.
//
// Why a global-setup mint instead of a per-test fixture:
//   1. Test traces (configured `retain-on-failure`) capture every
//      request a test makes — including the Authorization header
//      with the Bearer token and the Set-Cookie response with the
//      session JWT + refresh token. Anyone with repo read access
//      who downloaded a failure trace could extract those credentials
//      until the secret rotated. globalSetup runs OUTSIDE per-test
//      tracing, so the bearer token never lands in a downloadable
//      artifact.
//   2. Cookie marshalling: Playwright's `storageState` understands
//      the wire format natively, so we don't have to hand-parse
//      `Set-Cookie` attributes (Domain/Path/Max-Age/Expires) — saving
//      / loading the state preserves them exactly.
//   3. Single round-trip: previously every test re-minted; now the
//      live Worker is hit exactly once for auth.

import { type FullConfig, request as apiRequest } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const TOKEN_ENV_KEY = 'PLAYWRIGHT_DEV_BYPASS_TOKEN';
const STORAGE_STATE_PATH = '.playwright/storageState.json';

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL =
    config.projects[0]?.use?.baseURL ?? process.env['PLAYWRIGHT_BASE_URL'];
  if (typeof baseURL !== 'string' || baseURL === '') {
    throw new Error(
      'Playwright globalSetup: baseURL not configured — set PLAYWRIGHT_BASE_URL or projects[0].use.baseURL.',
    );
  }

  const token = process.env[TOKEN_ENV_KEY];
  if (typeof token !== 'string' || token === '') {
    // Tests guard with `test.skip` when storageState is empty — see
    // `view-transition.spec.ts`. We still write a stub file so the
    // `storageState` path resolves and Playwright doesn't error out
    // before the skip fires.
    await ensureDir(STORAGE_STATE_PATH);
    await writeFile(
      STORAGE_STATE_PATH,
      JSON.stringify({ cookies: [], origins: [] }, null, 2),
      'utf8',
    );
    console.warn(
      `[playwright globalSetup] ${TOKEN_ENV_KEY} not set — wrote empty storageState. Tests requiring auth will skip.`,
    );
    return;
  }

  // `request.newContext` creates a standalone APIRequestContext that
  // does NOT participate in any test's trace. The Authorization
  // header and Set-Cookie response stay out of every artifact.
  const ctx = await apiRequest.newContext({ baseURL });
  try {
    const res = await ctx.post('/api/dev/login', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Origin: baseURL,
      },
      data: {},
    });
    if (!res.ok()) {
      throw new Error(
        `[playwright globalSetup] dev-login failed: HTTP ${res.status()} from ${baseURL}/api/dev/login. ` +
          `Verify ${TOKEN_ENV_KEY} matches the Worker secret on the target deployment.`,
      );
    }
    // `storageState()` serialises cookies + origin storage in
    // Playwright's native format. Subsequent test contexts that
    // reference this file via `use.storageState` rehydrate verbatim,
    // including Domain / Path / Expires / Max-Age / SameSite — none
    // of which the prior hand-rolled parser preserved.
    await ensureDir(STORAGE_STATE_PATH);
    await ctx.storageState({ path: STORAGE_STATE_PATH });
  } finally {
    await ctx.dispose();
  }
}

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}
