// Implements REQ-READ-002, REQ-HIST-001
//
// Auth helper for live Playwright tests. Mints a synthetic-user session
// via the `/api/dev/login` bypass and stamps the resulting cookie onto
// the browser context so subsequent navigations are authenticated.
// The bypass is gated on the deployment by the `DEV_BYPASS_TOKEN`
// Worker secret; if that secret is absent the endpoint returns 404 and
// these tests skip with a clear message.

import { type APIRequestContext, type BrowserContext, test } from '@playwright/test';

const TOKEN_ENV_KEY = 'PLAYWRIGHT_DEV_BYPASS_TOKEN';

export async function authBrowserContext(
  api: APIRequestContext,
  browserContext: BrowserContext,
  baseURL: string,
): Promise<void> {
  const token = process.env[TOKEN_ENV_KEY];
  test.skip(
    typeof token !== 'string' || token === '',
    `${TOKEN_ENV_KEY} not set — cannot mint a synthetic session for live smoke tests`,
  );
  if (typeof token !== 'string' || token === '') return; // unreachable post-skip

  const res = await api.post(`${baseURL}/api/dev/login`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: {},
  });
  if (!res.ok()) {
    throw new Error(
      `dev-login failed: HTTP ${res.status()} from ${baseURL}/api/dev/login. ` +
        `Verify DEV_BYPASS_TOKEN matches the Worker secret on the target deployment.`,
    );
  }

  // Capture every Set-Cookie header (session JWT + refresh token row)
  // and stamp them onto the browser context so subsequent page loads
  // see an authenticated user.
  const setCookies = res.headersArray()
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value);
  const url = new URL(baseURL);
  const cookies = setCookies.flatMap((raw) => {
    const [pair, ...attrs] = raw.split(';');
    if (pair === undefined) return [];
    const eq = pair.indexOf('=');
    if (eq === -1) return [];
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const lower = attrs.map((a) => a.trim().toLowerCase());
    return [
      {
        name,
        value,
        domain: url.hostname,
        path: '/',
        httpOnly: lower.includes('httponly'),
        secure: lower.includes('secure'),
        sameSite: 'Lax' as const,
      },
    ];
  });
  await browserContext.addCookies(cookies);
}
