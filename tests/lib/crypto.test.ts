// Tests for src/lib/crypto.ts — REQ-AUTH-001 / REQ-AUTH-002
// (CF-005: shared crypto helpers; previously duplicated across
// callback.ts, dev/login.ts, dev/trigger-scrape.ts, session-jwt.ts,
// auth/[provider]/login.ts).

import { describe, it, expect } from 'vitest';
import {
  base64UrlEncode,
  base64UrlDecode,
  readCookie,
  timingSafeEqualHmac,
} from '~/lib/crypto';

const SECRET = 'test-secret-for-hmac-sha256-comparison-padding';

describe('base64UrlEncode', () => {
  it('CF-005: encodes empty bytes as empty string', () => {
    expect(base64UrlEncode(new Uint8Array(0))).toBe('');
  });

  it('CF-005: replaces + and / with - and _ and strips padding', () => {
    // 0xff 0xff 0xff → "////" in std base64 → "____" in base64url.
    expect(base64UrlEncode(new Uint8Array([0xff, 0xff, 0xff]))).toBe('____');
  });

  it('CF-005: round-trips through base64UrlDecode', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = base64UrlEncode(bytes);
    const decoded = base64UrlDecode(encoded);
    expect(Array.from(decoded)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('readCookie', () => {
  it('CF-005: returns the value of a single cookie', () => {
    expect(readCookie('foo=bar', 'foo')).toBe('bar');
  });

  it('CF-005: returns the value when there are multiple cookies', () => {
    expect(readCookie('a=1; b=2; c=3', 'b')).toBe('2');
  });

  it('CF-005: returns null when the named cookie is absent', () => {
    expect(readCookie('a=1', 'b')).toBeNull();
  });

  it('CF-005: returns null for null or empty header', () => {
    expect(readCookie(null, 'a')).toBeNull();
    expect(readCookie('', 'a')).toBeNull();
  });

  it('CF-005: trims whitespace around cookie names', () => {
    expect(readCookie(' a = 1; b = 2 ', 'b')).toBe('2');
  });
});

describe('timingSafeEqualHmac', () => {
  it('CF-005: returns true for identical strings', async () => {
    expect(await timingSafeEqualHmac('hello', 'hello', SECRET)).toBe(true);
  });

  it('CF-005: returns false for different strings of equal length', async () => {
    expect(await timingSafeEqualHmac('aaaa', 'bbbb', SECRET)).toBe(false);
  });

  it('CF-005: returns false for different strings of different length', async () => {
    expect(await timingSafeEqualHmac('aaa', 'aaaaaa', SECRET)).toBe(false);
  });

  it('CF-005: returns false for empty strings (defends against empty-cookie false-positive)', async () => {
    expect(await timingSafeEqualHmac('', '', SECRET)).toBe(false);
    expect(await timingSafeEqualHmac('a', '', SECRET)).toBe(false);
    expect(await timingSafeEqualHmac('', 'a', SECRET)).toBe(false);
  });

  it('CF-005: returns true for high-entropy OAuth-state-style nonces when equal', async () => {
    const state = 'aGVsbG8td29ybGQtdGhpcy1pcy1hLXJhbmRvbS1ub25jZQ';
    expect(await timingSafeEqualHmac(state, state, SECRET)).toBe(true);
  });
});
