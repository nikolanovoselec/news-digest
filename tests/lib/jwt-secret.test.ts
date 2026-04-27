// Tests for src/lib/jwt-secret.ts — CF-029 (OAUTH_JWT_SECRET minimum
// entropy enforced at runtime).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  requireStrongJwtSecret,
  __resetWeakSecretLatch,
  MIN_JWT_SECRET_BYTES,
} from '~/lib/jwt-secret';

describe('requireStrongJwtSecret', () => {
  beforeEach(() => {
    __resetWeakSecretLatch();
  });

  it('CF-029: throws when the secret is shorter than the minimum', () => {
    expect(() => requireStrongJwtSecret('short')).toThrow('jwt_secret_too_weak');
  });

  it('CF-029: throws on the empty string', () => {
    expect(() => requireStrongJwtSecret('')).toThrow('jwt_secret_too_weak');
  });

  it('CF-029: passes silently when the secret is exactly the minimum length', () => {
    const secret = 'a'.repeat(MIN_JWT_SECRET_BYTES);
    expect(() => requireStrongJwtSecret(secret)).not.toThrow();
  });

  it('CF-029: passes when the secret exceeds the minimum length', () => {
    const secret = 'a'.repeat(MIN_JWT_SECRET_BYTES + 16);
    expect(() => requireStrongJwtSecret(secret)).not.toThrow();
  });

  it('CF-029: counts UTF-8 bytes, not code-units (multi-byte chars)', () => {
    // Each "é" is 2 UTF-8 bytes; 16 of them = 32 bytes, which is the floor.
    const secret = 'é'.repeat(16);
    expect(() => requireStrongJwtSecret(secret)).not.toThrow();
    // 15 of them = 30 bytes — below the floor.
    const tooShort = 'é'.repeat(15);
    expect(() => requireStrongJwtSecret(tooShort)).toThrow('jwt_secret_too_weak');
  });

  it('CF-029: emits a structured warn log on the first weak-secret call only', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => requireStrongJwtSecret('short')).toThrow();
    expect(() => requireStrongJwtSecret('also-short')).toThrow();
    const warnLogs = spy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('"jwt.secret.weak"'));
    expect(warnLogs.length).toBe(1);
    spy.mockRestore();
  });
});
