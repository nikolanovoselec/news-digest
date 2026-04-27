// Tests for src/middleware/origin-check.ts — REQ-AUTH-003 (CSRF defense
// for state-changing endpoints).

import { describe, it, expect } from 'vitest';
import { checkOrigin, originOf } from '~/middleware/origin-check';

const APP_ORIGIN = 'https://news-digest.example.com';

function req(method: string, origin: string | null): Request {
  const headers = new Headers();
  if (origin !== null) headers.set('Origin', origin);
  return new Request('https://news-digest.example.com/api/foo', { method, headers });
}

function expectRejected(r: ReturnType<typeof checkOrigin>): Response {
  if (r.ok) throw new Error('expected origin check to fail');
  return r.response;
}

describe('originOf', () => {
  it('REQ-AUTH-003: extracts the origin from an HTTPS URL', () => {
    expect(originOf('https://news-digest.example.com/anything?q=1')).toBe(
      'https://news-digest.example.com',
    );
  });

  it('REQ-AUTH-003: preserves the port when present', () => {
    expect(originOf('https://example.com:8080/path')).toBe('https://example.com:8080');
  });
});

describe('checkOrigin — exempt methods', () => {
  it('REQ-AUTH-003: GET is allowed regardless of Origin', () => {
    const r = checkOrigin(req('GET', null), APP_ORIGIN);
    expect(r.ok).toBe(true);
  });

  it('REQ-AUTH-003: GET with a cross-site Origin is still allowed', () => {
    const r = checkOrigin(req('GET', 'https://evil.com'), APP_ORIGIN);
    expect(r.ok).toBe(true);
  });

  it('REQ-AUTH-003: HEAD is allowed', () => {
    const r = checkOrigin(req('HEAD', null), APP_ORIGIN);
    expect(r.ok).toBe(true);
  });

  it('REQ-AUTH-003: OPTIONS is allowed', () => {
    const r = checkOrigin(req('OPTIONS', null), APP_ORIGIN);
    expect(r.ok).toBe(true);
  });
});

describe('checkOrigin — state-changing methods', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    it(`REQ-AUTH-003: rejects ${method} with missing Origin header`, async () => {
      const r = checkOrigin(req(method, null), APP_ORIGIN);
      const response = expectRejected(r);
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body).toMatchObject({ code: 'forbidden_origin' });
    });

    it(`REQ-AUTH-003: rejects ${method} with mismatched Origin`, () => {
      const r = checkOrigin(req(method, 'https://evil.com'), APP_ORIGIN);
      const response = expectRejected(r);
      expect(response.status).toBe(403);
    });

    it(`REQ-AUTH-003: rejects ${method} with empty Origin string`, () => {
      const r = checkOrigin(req(method, ''), APP_ORIGIN);
      const response = expectRejected(r);
      expect(response.status).toBe(403);
    });

    it(`REQ-AUTH-003: accepts ${method} with exact matching Origin`, () => {
      const r = checkOrigin(req(method, APP_ORIGIN), APP_ORIGIN);
      expect(r.ok).toBe(true);
    });
  }

  it('REQ-AUTH-003: rejection body is JSON with error and code fields', async () => {
    const r = checkOrigin(req('POST', null), APP_ORIGIN);
    const response = expectRejected(r);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    const body = (await response.json()) as { error?: string; code?: string };
    expect(typeof body.error).toBe('string');
    expect(body.code).toBe('forbidden_origin');
  });

  it('REQ-AUTH-003: subdomain Origin does not match bare origin', () => {
    const r = checkOrigin(
      req('POST', 'https://evil.news-digest.example.com'),
      APP_ORIGIN,
    );
    expect(r.ok).toBe(false);
  });

  it('REQ-AUTH-003: http scheme on same host does not match https origin', () => {
    const r = checkOrigin(
      req('POST', 'http://news-digest.example.com'),
      APP_ORIGIN,
    );
    expect(r.ok).toBe(false);
  });
});
