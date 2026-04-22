// Tests for src/lib/session-jwt.ts — REQ-AUTH-002 (session cookie + instant revocation).
// Verifies HMAC-SHA256 JWT sign/verify, expiry, tampering, and refresh threshold.
import { describe, it, expect } from 'vitest';
import { signSession, verifySession, shouldRefreshJWT, type SessionClaims } from '~/lib/session-jwt';

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

    it('REQ-AUTH-002: defaults TTL to 3600 seconds', async () => {
      const token = await signSession(baseClaims, SECRET);
      const claims = await verifySession(token, SECRET);
      expect(claims).not.toBeNull();
      expect(claims!.exp - claims!.iat).toBe(3600);
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

  describe('shouldRefreshJWT', () => {
    it('REQ-AUTH-002: returns true when less than 15 minutes remain', () => {
      const now = 1_000_000;
      const claims: SessionClaims = {
        sub: '1',
        email: 'a@b.c',
        ghl: 'a',
        sv: 1,
        iat: now - 3000,
        exp: now + 10 * 60, // 10 minutes remaining
      };
      expect(shouldRefreshJWT(claims, now)).toBe(true);
    });

    it('REQ-AUTH-002: returns false when more than 15 minutes remain', () => {
      const now = 1_000_000;
      const claims: SessionClaims = {
        sub: '1',
        email: 'a@b.c',
        ghl: 'a',
        sv: 1,
        iat: now - 600,
        exp: now + 30 * 60, // 30 minutes remaining
      };
      expect(shouldRefreshJWT(claims, now)).toBe(false);
    });

    it('REQ-AUTH-002: returns false for already-expired claims', () => {
      const now = 1_000_000;
      const claims: SessionClaims = {
        sub: '1',
        email: 'a@b.c',
        ghl: 'a',
        sv: 1,
        iat: now - 10_000,
        exp: now - 1, // already expired — verifySession rejects; no refresh
      };
      expect(shouldRefreshJWT(claims, now)).toBe(false);
    });

    it('REQ-AUTH-002: uses current time when `now` is omitted', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const near: SessionClaims = {
        sub: '1',
        email: 'a@b.c',
        ghl: 'a',
        sv: 1,
        iat: nowSec - 3000,
        exp: nowSec + 5 * 60,
      };
      const far: SessionClaims = {
        sub: '1',
        email: 'a@b.c',
        ghl: 'a',
        sv: 1,
        iat: nowSec - 600,
        exp: nowSec + 60 * 60,
      };
      expect(shouldRefreshJWT(near)).toBe(true);
      expect(shouldRefreshJWT(far)).toBe(false);
    });
  });
});
