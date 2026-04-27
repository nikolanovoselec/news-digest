// Tests for src/lib/session-jwt.ts — REQ-AUTH-002 (session cookie + instant revocation).
// Verifies HMAC-SHA256 JWT sign/verify, expiry, tampering, and refresh threshold.
import { describe, it, expect } from 'vitest';
import { signSession, verifySession, type SessionClaims } from '~/lib/session-jwt';

const SECRET = 'test-secret-key-for-hmac-sha256-signing-minimum-length';

const baseClaims: Omit<SessionClaims, 'iat' | 'exp'> = {
  sub: '12345',
  email: 'alice@example.com',
  ghl: 'alice',
  sv: 1,
};

describe('session-jwt', () => {
  describe('signSession', () => {
    it('REQ-AUTH-002: produces a valid 3-part base64url JWT', async () => {
      const token = await signSession(baseClaims, SECRET);
      const parts = token.split('.');
      expect(parts).toHaveLength(3);
      // Each part must be base64url — no `+`, `/`, or `=`.
      for (const part of parts) {
        expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    });

    it('REQ-AUTH-002: defaults TTL to 300 seconds (5-minute access token)', async () => {
      // Access JWT lifetime — short by design because the 30-day
      // refresh cookie carries long-term presence (REQ-AUTH-008).
      const token = await signSession(baseClaims, SECRET);
      const claims = await verifySession(token, SECRET);
      expect(claims).not.toBeNull();
      expect(claims!.exp - claims!.iat).toBe(300);
    });

    it('REQ-AUTH-002: honours custom TTL', async () => {
      const before = Math.floor(Date.now() / 1000);
      const token = await signSession(baseClaims, SECRET, 7200);
      const after = Math.floor(Date.now() / 1000);

      const claims = await verifySession(token, SECRET);
      expect(claims).not.toBeNull();
      expect(claims!.iat).toBeGreaterThanOrEqual(before);
      expect(claims!.iat).toBeLessThanOrEqual(after);
      expect(claims!.exp - claims!.iat).toBe(7200);
    });

    it('REQ-AUTH-002: preserves all claim fields through a sign/verify round-trip', async () => {
      const token = await signSession(baseClaims, SECRET);
      const claims = await verifySession(token, SECRET);
      expect(claims).not.toBeNull();
      expect(claims!.sub).toBe('12345');
      expect(claims!.email).toBe('alice@example.com');
      expect(claims!.ghl).toBe('alice');
      expect(claims!.sv).toBe(1);
    });
  });

  describe('verifySession', () => {
    it('REQ-AUTH-002: returns null for expired token', async () => {
      // Negative TTL produces an already-expired token.
      const token = await signSession(baseClaims, SECRET, -1);
      const claims = await verifySession(token, SECRET);
      expect(claims).toBeNull();
    });

    it('REQ-AUTH-002: returns null for tampered signature', async () => {
      const token = await signSession(baseClaims, SECRET);
      const parts = token.split('.');
      const tampered = `${parts[0]}.${parts[1]}.${parts[2]}AAAA`;
      expect(await verifySession(tampered, SECRET)).toBeNull();
    });

    it('REQ-AUTH-002: returns null when payload is tampered but signature is stale', async () => {
      const token = await signSession(baseClaims, SECRET);
      const parts = token.split('.');
      const evilPayload = btoa(
        JSON.stringify({ sub: '99', email: 'evil@example.com', ghl: 'evil', sv: 1, iat: 0, exp: 9_999_999_999 }),
      )
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      const tampered = `${parts[0]}.${evilPayload}.${parts[2]}`;
      expect(await verifySession(tampered, SECRET)).toBeNull();
    });

    it('REQ-AUTH-002: returns null for wrong secret', async () => {
      const token = await signSession(baseClaims, SECRET);
      expect(await verifySession(token, 'wrong-secret')).toBeNull();
    });

    it('REQ-AUTH-002: returns null for malformed token shape', async () => {
      expect(await verifySession('not-a-jwt', SECRET)).toBeNull();
      expect(await verifySession('a.b', SECRET)).toBeNull();
      expect(await verifySession('', SECRET)).toBeNull();
      expect(await verifySession('a.b.c.d', SECRET)).toBeNull();
    });

    it('REQ-AUTH-002: returns null when payload JSON shape is invalid', async () => {
      // Hand-craft header.badPayload.signature that verifies cryptographically
      // only if we control the secret — but we sign over non-JSON bytes so that
      // after verification the JSON.parse step fails.
      const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      // "not-json" as base64url
      const payload = btoa('not-json').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
      const signingInput = `${header}.${payload}`;
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
      const sigBytes = new Uint8Array(sigBuf);
      let sigBinary = '';
      for (let i = 0; i < sigBytes.byteLength; i++) sigBinary += String.fromCharCode(sigBytes[i]!);
      const sig = btoa(sigBinary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

      expect(await verifySession(`${signingInput}.${sig}`, SECRET)).toBeNull();
    });
  });

  // shouldRefreshJWT was removed when REQ-AUTH-002 moved to the
  // access/refresh-token model (REQ-AUTH-008). The access JWT no
  // longer sliding-refreshes — long-term presence is provided by the
  // 30-day refresh token. See tests/auth/refresh-tokens.test.ts for
  // refresh-flow coverage.
});
