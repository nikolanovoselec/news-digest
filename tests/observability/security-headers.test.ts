// Tests for src/middleware/security-headers.ts — REQ-OPS-003.
// Pins the exact header values required by AC 1-4 byte-for-byte.

import { describe, it, expect } from 'vitest';
import {
  securityHeadersMiddleware,
  CSP_HEADER_VALUE,
  HSTS_HEADER_VALUE,
  X_CONTENT_TYPE_OPTIONS_VALUE,
  X_FRAME_OPTIONS_VALUE,
  REFERRER_POLICY_VALUE,
  PERMISSIONS_POLICY_VALUE,
  SECURITY_HEADERS,
} from '~/middleware/security-headers';

/** Minimal Astro middleware context shim. The real APIContext has many more
 * fields but the security-headers middleware touches none of them — it only
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
  describe('constants', () => {
    it('REQ-OPS-003: CSP matches the spec byte-for-byte', () => {
      expect(CSP_HEADER_VALUE).toBe(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.gravatar.com https://secure.gravatar.com; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    });

    it('REQ-OPS-003: X-Frame-Options is DENY (defense-in-depth on top of frame-ancestors)', () => {
      expect(X_FRAME_OPTIONS_VALUE).toBe('DENY');
    });

    it('REQ-OPS-003: HSTS is max-age=63072000; includeSubDomains; preload', () => {
      expect(HSTS_HEADER_VALUE).toBe('max-age=63072000; includeSubDomains; preload');
    });

    it('REQ-OPS-003: X-Content-Type-Options is nosniff', () => {
      expect(X_CONTENT_TYPE_OPTIONS_VALUE).toBe('nosniff');
    });

    it('REQ-OPS-003: Referrer-Policy is strict-origin-when-cross-origin', () => {
      expect(REFERRER_POLICY_VALUE).toBe('strict-origin-when-cross-origin');
    });

    it('REQ-OPS-003: Permissions-Policy denies geolocation, microphone, camera, payment, clipboard-read', () => {
      expect(PERMISSIONS_POLICY_VALUE).toBe(
        'geolocation=(), microphone=(), camera=(), payment=(), clipboard-read=()',
      );
    });

    it('REQ-OPS-003: SECURITY_HEADERS lists every required header', () => {
      const names = SECURITY_HEADERS.map(([n]) => n).sort();
      expect(names).toEqual([
        'Content-Security-Policy',
        'Permissions-Policy',
        'Referrer-Policy',
        'Strict-Transport-Security',
        'X-Content-Type-Options',
        'X-Frame-Options',
      ]);
    });
  });

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
