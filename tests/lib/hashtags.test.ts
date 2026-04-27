// Tests for src/lib/hashtags.ts — REQ-MAIL-001 / REQ-READ-001 / REQ-SET-002
// (CF-015). The wrapper delegates to parseJsonStringArray; this file
// pins the contract end-to-end so a future refactor of the helper or
// the wrapper can't silently change behaviour.
//
// The function is a defensive parser — every branch returns a usable
// string[] (often `[]`) rather than throwing. The contract is that
// users.hashtags_json can be NULL, empty, malformed JSON, or an
// arbitrary JSON value, and the read paths must keep rendering
// without crashing on a corrupted row.

import { describe, it, expect } from 'vitest';
import { parseHashtags } from '~/lib/hashtags';

describe('parseHashtags — REQ-MAIL-001 / REQ-READ-001 / REQ-SET-002', () => {
  it('returns [] for null input', () => {
    expect(parseHashtags(null)).toEqual([]);
  });

  it('returns [] for empty string', () => {
    expect(parseHashtags('')).toEqual([]);
  });

  it('returns [] for malformed JSON', () => {
    expect(parseHashtags('{not valid json')).toEqual([]);
    expect(parseHashtags('["unterminated')).toEqual([]);
  });

  it('returns [] when the parsed value is not an array', () => {
    expect(parseHashtags('"a string"')).toEqual([]);
    expect(parseHashtags('42')).toEqual([]);
    expect(parseHashtags('null')).toEqual([]);
    expect(parseHashtags('{"k":"v"}')).toEqual([]);
  });

  it('filters out non-string entries from a mixed array', () => {
    expect(parseHashtags('["ai", 42, null, "llm", {"x":1}]')).toEqual([
      'ai',
      'llm',
    ]);
  });

  it('returns the array untouched on the happy path', () => {
    expect(parseHashtags('["ai", "llm", "cloudflare"]')).toEqual([
      'ai',
      'llm',
      'cloudflare',
    ]);
  });

  it('preserves casing and #-prefix verbatim — no normalisation', () => {
    // The wrapper is a pass-through. Normalisation (lowercase, #-strip,
    // trim) is the caller's responsibility — admin retry handlers
    // layer it on, settings.astro layers it on, the bare email/dashboard
    // surfaces consume the stored value as-is.
    expect(parseHashtags('["#AI", "LLM", "  spaced  "]')).toEqual([
      '#AI',
      'LLM',
      '  spaced  ',
    ]);
  });

  it('returns [] for an empty JSON array', () => {
    expect(parseHashtags('[]')).toEqual([]);
  });
});
