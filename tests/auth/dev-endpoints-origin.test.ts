// CF-035 — defence-in-depth Origin check on /api/dev/login and
// /api/dev/trigger-scrape, exercised via the shared
// `checkDevEndpointOrigin` helper.
//
// The bypass-token gate (DEV_BYPASS_TOKEN) is the primary defence
// against cross-site browser forms (browsers will not let a
// cross-origin form set the Authorization header). The Origin guard
// is uniformity defence-in-depth: when a browser DOES set Origin,
// it must match APP_URL OR the request is rejected. When no Origin
// is sent (curl-driven CI flows), the request passes through to the
// bypass-token check.
//
// Testing the helper directly keeps the test pool-agnostic — no
// dependency on DEV_BYPASS_TOKEN or APP_URL being configured in the
// vitest fixture env.

import { describe, it, expect } from 'vitest';
import { checkDevEndpointOrigin } from '~/middleware/origin-check';

const APP_URL = 'https://news.graymatter.ch';

function postReq(headers: Record<string, string>): Request {
  return new Request('https://news.graymatter.ch/api/dev/login', {
    method: 'POST',
    headers,
  });
}

describe('checkDevEndpointOrigin — REQ-AUTH-003 / CF-035', () => {
  it('CF-035: blocks cross-origin browser POST when Origin mismatches APP_URL', () => {
    const req = postReq({ Origin: 'https://attacker.com' });
    expect(checkDevEndpointOrigin(req, APP_URL)).toBe(false);
  });

  it('CF-035: passes when Origin exactly matches APP_URL', () => {
    const req = postReq({ Origin: APP_URL });
    expect(checkDevEndpointOrigin(req, APP_URL)).toBe(true);
  });

  it('CF-035: passes when Origin header is absent (curl/CI flow)', () => {
    const req = postReq({});
    expect(checkDevEndpointOrigin(req, APP_URL)).toBe(true);
  });

  it('CF-035: passes when Origin header is empty string', () => {
    const req = postReq({ Origin: '' });
    expect(checkDevEndpointOrigin(req, APP_URL)).toBe(true);
  });

  it('CF-035: passes when APP_URL is unset (fork without configured hostname)', () => {
    // Forks deploying without APP_URL configured rely on the
    // bypass-token check alone; the Origin guard self-disables so
    // the endpoint is reachable from the *.workers.dev URL during
    // bootstrap.
    const req = postReq({ Origin: 'https://attacker.com' });
    expect(checkDevEndpointOrigin(req, undefined)).toBe(true);
  });

  it('CF-035: blocks when Origin mismatches APP_URL even on a path-included APP_URL value', () => {
    // APP_URL may include a trailing slash or be a full URL; the
    // helper extracts the origin via originOf so the comparison is
    // origin-only.
    const req = postReq({ Origin: 'https://attacker.com' });
    expect(checkDevEndpointOrigin(req, 'https://news.graymatter.ch/')).toBe(false);
  });

  it('CF-035: case-sensitive on Origin per the URL spec (browsers lowercase already)', () => {
    // Browsers always emit lowercase Origin; an uppercase value would
    // not arrive from a real browser. Pin the exact-match contract so
    // a future "case-insensitive shortcut" doesn't loosen the gate.
    const req = postReq({ Origin: 'HTTPS://news.graymatter.ch' });
    expect(checkDevEndpointOrigin(req, APP_URL)).toBe(false);
  });
});
