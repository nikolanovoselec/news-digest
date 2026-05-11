// Tests for src/middleware/security-headers.ts - REQ-OPS-003.
// Pins the exact header values required by AC 1-4 byte-for-byte.

import { describe, it, expect } from 'vitest';
import {
  securityHeadersMiddleware,
  CSP_HEADER_VALUE,
  HSTS_HEADER_VALUE,
  PERMISSIONS_POLICY_VALUE,
  SECURITY_HEADERS,
} from '~/middleware/security-headers';

/** Minimal Astro middleware context shim. The real APIContext has many more
 * fields but the security-headers middleware touches none of them - it only
 * awaits `next()` and mutates the response's headers. */
function makeCtx(): unknown {
  return {
    request: new Request('https://example.com/'),
    url: new URL('https://example.com/'),
    cookies: undefined,
    locals: {},
  };
}

/** Invoke the middleware with a `next()` that returns {@link upstream}. */
async function run(upstream: Response): Promise<Response> {
  return securityHeadersMiddleware(makeCtx(), async () => upstream);
}

describe('security-headers middleware', () => {
  // CF-022 (Cycle 1 review): the former `describe('constants', ...)`
  // block asserted that exported string constants equaled hardcoded
  // literals. Those tests passed iff someone typed both sides of the
  // same string - they did not verify behaviour. Every behavioural
  // guarantee is covered by the `describe('stamping', ...)` block
  // below, which sends a request through the middleware and asserts
  // on response headers.

  describe('stamping', () => {
    it('REQ-OPS-003: adds Content-Security-Policy with the exact spec value', async () => {
      const res = await run(new Response('ok'));
      expect(res.headers.get('Content-Security-Policy')).toBe(CSP_HEADER_VALUE);
    });

    it('REQ-OPS-003: adds Strict-Transport-Security', async () => {
      const res = await run(new Response('ok'));
      expect(res.headers.get('Strict-Transport-Security')).toBe(HSTS_HEADER_VALUE);
    });

    it('REQ-OPS-003: adds X-Content-Type-Options: nosniff', async () => {
      const res = await run(new Response('ok'));
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('REQ-OPS-003: adds Referrer-Policy: strict-origin-when-cross-origin', async () => {
      const res = await run(new Response('ok'));
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    });

    it('REQ-OPS-003: adds Permissions-Policy locking down all five features', async () => {
      const res = await run(new Response('ok'));
      expect(res.headers.get('Permissions-Policy')).toBe(PERMISSIONS_POLICY_VALUE);
    });

    it('REQ-OPS-003: adds X-Frame-Options: DENY', async () => {
      const res = await run(new Response('ok'));
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('REQ-OPS-003: stamps every required header even on an error response', async () => {
      const res = await run(new Response('gone', { status: 404 }));
      for (const [name, value] of SECURITY_HEADERS) {
        expect(res.headers.get(name), `missing ${name}`).toBe(value);
      }
    });

    it('REQ-OPS-003: stamps every required header even on a redirect response', async () => {
      const res = await run(
        new Response(null, { status: 302, headers: { Location: '/digest' } }),
      );
      for (const [name, value] of SECURITY_HEADERS) {
        expect(res.headers.get(name), `missing ${name}`).toBe(value);
      }
      // Pre-existing headers on the upstream response must be preserved.
      expect(res.headers.get('Location')).toBe('/digest');
    });

    it('REQ-OPS-003: CSP normalises an upstream Content-Security-Policy (no append)', async () => {
      const upstream = new Response('ok', {
        headers: { 'Content-Security-Policy': "default-src 'none'" },
      });
      const res = await run(upstream);
      // The upstream value is replaced, not appended to.
      expect(res.headers.get('Content-Security-Policy')).toBe(CSP_HEADER_VALUE);
    });

    it('REQ-OPS-003: preserves the response body', async () => {
      const upstream = new Response('payload-abc');
      const res = await run(upstream);
      const text = await res.text();
      expect(text).toBe('payload-abc');
    });

    it('REQ-OPS-003: preserves the status code', async () => {
      const res = await run(new Response(null, { status: 204 }));
      expect(res.status).toBe(204);
    });
  });
});
