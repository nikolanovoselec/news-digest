// Implements REQ-OPS-003 + AD11
//
// Live-site Playwright suite that PINS the literal CSP header value.
// CF-019: AD11 documents why `'unsafe-inline'` stays in `style-src` for
// FLIP transforms and view-transition-name. The "third time it has
// been attempted" history (`hotfix/csp-style-unsafe-inline`) shows
// that decision is regularly re-litigated. Without an automated
// header pin, a future PR could drop `'unsafe-inline'` and break
// production again.
//
// This test fails CI if any of these directives drift:
//   - script-src 'self'           (no inline scripts ever)
//   - style-src 'self' 'unsafe-inline'  (AD11 — required for FLIP +
//                                        view-transitions)
//   - frame-ancestors 'none'      (clickjacking gate)
//   - default-src 'self'          (deny-by-default)
//
// Pair with `csp-violation.spec.ts` which subscribes to runtime
// `securitypolicyviolation` events on a live navigation. Together
// they form the merge gate for any CSP change:
//   - csp-violation.spec.ts proves the deployed CSP doesn't break
//     pages we ship.
//   - csp-policy.spec.ts proves the deployed CSP is the policy we
//     intended (a misconfiguration that loosens the policy would
//     not fire violations and would slip past the violation suite).

import { expect, test } from '@playwright/test';

test.describe('CSP header pins (REQ-OPS-003 + AD11)', () => {
  test('serves the AD11-pinned CSP directives', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBeLessThan(400);
    const csp = res.headers()['content-security-policy'];
    expect(csp, 'Content-Security-Policy header missing').toBeTruthy();

    // AD11: 'unsafe-inline' MUST stay in style-src. Removing it has
    // broken production three times. If you are looking at this test
    // because it is failing in your PR: read documentation/decisions/
    // README.md AD11 BEFORE proposing a fix.
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");

    // script-src must NOT have 'unsafe-inline' — strict script policy
    // is the load-bearing XSS defense; AD11 acknowledges that even
    // when style-src is loose.
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);

    // Other AD11-anchored directives.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  test('HSTS preload directive present (REQ-OPS-003 AC 2)', async ({ request }) => {
    const res = await request.get('/');
    const hsts = res.headers()['strict-transport-security'];
    expect(hsts).toBeTruthy();
    expect(hsts).toMatch(/max-age=63072000/);
    expect(hsts).toContain('includeSubDomains');
    expect(hsts).toContain('preload');
  });
});
