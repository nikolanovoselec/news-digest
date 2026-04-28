// Tests for src/lib/default-hashtags.ts — REQ-AUTH-001 (default seed for
// new accounts in the global-feed rework) and REQ-SET-002 (default hashtag seed).
import { describe, it, expect } from 'vitest';
import { DEFAULT_HASHTAGS } from '~/lib/default-hashtags';

// Reshaped on 2026-04-25:
//   - Dropped: workers (HR keyword collision), python, rust, terraform,
//     postgres, observability, ai (umbrella), cloud (umbrella),
//     microsegmentation (subset of zero-trust)
//   - Renamed: agenticai → ai-agents, genai → generative-ai (matches the
//     way news headlines actually phrase the concepts)
//   - Added: appsec, coding-agents, docker, iam, siem, pqc, openziti,
//     supply-chain-security, gcp (security + identity + LLM-ops + cloud
//     vendor coverage matching the project owner's actual reading list)
// 2026-04-28: added `graymatter` so the curated graymatter.ch RSS feed
// surfaces in every new account's seed (#graymatter manually added by a
// user previously had no curated source backing it).
const SEED_TAGS = [
  'cloudflare',
  'mcp',
  'ai-agents',
  'generative-ai',
  'aws',
  'serverless',
  'azure',
  'zero-trust',
  'kubernetes',
  'devsecops',
  'threat-intel',
  'appsec',
  'coding-agents',
  'docker',
  'iam',
  'siem',
  'pqc',
  'openziti',
  'supply-chain-security',
  'gcp',
  'graymatter',
] as const;

describe('default-hashtags — REQ-AUTH-001', () => {
  it('REQ-AUTH-001: DEFAULT_HASHTAGS has exactly 21 entries', () => {
    expect(DEFAULT_HASHTAGS).toHaveLength(21);
  });

  it('REQ-AUTH-001: DEFAULT_HASHTAGS matches the canonical seed list', () => {
    expect([...DEFAULT_HASHTAGS]).toEqual([...SEED_TAGS]);
  });

  it('REQ-AUTH-001: every entry is a valid tag slug (lowercase, alphanumeric + hyphen)', () => {
    const validSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    for (const tag of DEFAULT_HASHTAGS) {
      expect(tag).toMatch(validSlug);
    }
  });

  it('REQ-AUTH-001: no duplicates', () => {
    const unique = new Set(DEFAULT_HASHTAGS);
    expect(unique.size).toBe(DEFAULT_HASHTAGS.length);
  });
});
