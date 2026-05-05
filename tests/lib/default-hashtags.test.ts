// Tests for src/lib/default-hashtags.ts — REQ-AUTH-001 (default seed for
// new accounts in the global-feed rework) and REQ-SET-002 (default hashtag seed).
//
// CF-031: the prior test mirrored the production constant as a literal
// `SEED_TAGS` and asserted equality between the two — a tautology that
// could only fail if someone manually edited the test in the opposite
// direction from production. Per tdd-discipline.md it caught nothing.
// The replacement tests below are property tests over the runtime
// constant: every entry is a valid slug, none repeat, and the set is
// neither empty nor implausibly large.
import { describe, it, expect } from 'vitest';
import { DEFAULT_HASHTAGS } from '~/lib/default-hashtags';

describe('default-hashtags — REQ-AUTH-001', () => {
  it('REQ-AUTH-001: every entry is a valid tag slug (lowercase, alphanumeric + hyphen)', () => {
    const validSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    for (const tag of DEFAULT_HASHTAGS) {
      expect(tag).toMatch(validSlug);
    }
  });

  it('REQ-AUTH-001: no duplicate tags', () => {
    const unique = new Set(DEFAULT_HASHTAGS);
    expect(unique.size).toBe(DEFAULT_HASHTAGS.length);
  });

  it('REQ-AUTH-001: seed is non-empty and bounded (<=50)', () => {
    expect(DEFAULT_HASHTAGS.length).toBeGreaterThan(0);
    expect(DEFAULT_HASHTAGS.length).toBeLessThanOrEqual(50);
  });
});
