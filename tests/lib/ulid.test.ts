// Tests for src/lib/ulid.ts — REQ-GEN-006 (ULID for digest + article IDs).
import { describe, it, expect } from 'vitest';
import { generateUlid } from '../../src/lib/ulid';

// Crockford base32 excludes I, L, O, U to avoid ambiguity.
const CROCKFORD_CHARSET = /^[0-9A-HJKMNP-TV-Z]+$/;

describe('generateUlid', () => {
  it('REQ-GEN-006: ULID is 26 characters', () => {
    const ulid = generateUlid();
    expect(ulid).toHaveLength(26);
  });

  it('REQ-GEN-006: ULID uses only Crockford base32 characters', () => {
    for (let i = 0; i < 100; i++) {
      const ulid = generateUlid();
      expect(ulid).toMatch(CROCKFORD_CHARSET);
    }
  });

  it('REQ-GEN-006: ULIDs are unique across many generations', () => {
    const count = 10_000;
    const set = new Set<string>();
    for (let i = 0; i < count; i++) {
      set.add(generateUlid());
    }
    expect(set.size).toBe(count);
  });

  it('REQ-GEN-006: ULIDs are lexicographically sortable by creation time', async () => {
    const first = generateUlid();
    // Wait long enough that the 48-bit ms timestamp prefix advances.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = generateUlid();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const third = generateUlid();
    const sorted = [first, second, third].slice().sort();
    expect(sorted).toEqual([first, second, third]);
  });

  it('REQ-GEN-006: ULID timestamp prefix encodes current time in ms', () => {
    const before = Date.now();
    const ulid = generateUlid();
    const after = Date.now();
    const timePart = ulid.slice(0, 10);
    const decoded = decodeCrockfordBase32(timePart);
    expect(decoded).toBeGreaterThanOrEqual(before);
    expect(decoded).toBeLessThanOrEqual(after);
  });

  it('REQ-GEN-006: ULIDs generated in the same ms have different random suffixes', () => {
    // Generate many in a tight loop — some will collide on timestamp.
    const ulids = Array.from({ length: 1000 }, () => generateUlid());
    const randomParts = ulids.map((u) => u.slice(10));
    const unique = new Set(randomParts);
    // With 80 bits of randomness, all 1000 random parts must be unique.
    expect(unique.size).toBe(randomParts.length);
  });
});

// Test helper: decode a 10-char Crockford base32 timestamp back to ms.
function decodeCrockfordBase32(s: string): number {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let value = 0;
  for (const char of s) {
    const index = alphabet.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid Crockford base32 character: ${char}`);
    }
    value = value * 32 + index;
  }
  return value;
}
