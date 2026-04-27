// Tests for src/lib/title-overlap.ts — REQ-PIPE-002 defense-in-depth
// guard against LLM summaries that echo the correct candidate index
// but describe a different candidate's story. CF-058 extracted the
// helper from scrape-chunk-consumer.ts so the contract can be tested
// in isolation without spinning up the full pipeline fixture.

import { describe, it, expect } from 'vitest';
import { titlesShareAnyToken, tokenizeTitle } from '~/lib/title-overlap';

describe('tokenizeTitle — REQ-PIPE-002', () => {
  it('REQ-PIPE-002: lowercases, alnum-splits, drops short tokens', () => {
    const tokens = tokenizeTitle('Apple ships M5 MacBook Pro');
    // 'Apple' (5) ✓, 'ships' (5) — wait, 'ships' is NOT a stopword;
    // 'M5' is 2 chars (skipped), 'MacBook' (7) ✓, 'Pro' (3) skipped.
    expect(tokens.has('apple')).toBe(true);
    expect(tokens.has('ships')).toBe(true);
    expect(tokens.has('macbook')).toBe(true);
    expect(tokens.has('pro')).toBe(false); // length < 4
    expect(tokens.has('m5')).toBe(false); // length < 4
  });

  it('REQ-PIPE-002: strips stopwords from the tokenised set', () => {
    const tokens = tokenizeTitle('The new launch announced for AI users');
    // 'the', 'new', 'launch', 'announced', 'for' all stopwords;
    // only 'users' (5) survives.
    expect(tokens.has('the')).toBe(false);
    expect(tokens.has('new')).toBe(false);
    expect(tokens.has('launch')).toBe(false);
    expect(tokens.has('announced')).toBe(false);
    expect(tokens.has('users')).toBe(true);
  });

  it('REQ-PIPE-002: ignores punctuation when splitting', () => {
    const tokens = tokenizeTitle('OpenAI/Microsoft: revenue split announced');
    expect(tokens.has('openai')).toBe(true);
    expect(tokens.has('microsoft')).toBe(true);
    expect(tokens.has('revenue')).toBe(true);
    expect(tokens.has('split')).toBe(true);
    expect(tokens.has('announced')).toBe(false); // stopword
  });

  it('REQ-PIPE-002: empty title yields empty token set', () => {
    expect(tokenizeTitle('').size).toBe(0);
  });

  it('REQ-PIPE-002: all-stopword title yields empty token set', () => {
    expect(tokenizeTitle('the new and now').size).toBe(0);
  });
});

describe('titlesShareAnyToken — REQ-PIPE-002', () => {
  it('REQ-PIPE-002: matching titles share tokens', () => {
    expect(
      titlesShareAnyToken(
        'Apple ships M5 MacBook',
        'Apple unveils M5 MacBook Pro',
      ),
    ).toBe(true);
  });

  it('REQ-PIPE-002: completely unrelated titles do NOT share', () => {
    // "AlphaCorp acquires BetaCorp" vs "stock market closes higher"
    // share zero non-stopword tokens of length ≥ 4.
    expect(
      titlesShareAnyToken(
        'AlphaCorp acquires BetaCorp',
        'stock market closes higher',
      ),
    ).toBe(false);
  });

  it('REQ-PIPE-002: short titles are accepted (signal too noisy)', () => {
    // The helper accepts when EITHER side has fewer than 2 meaningful
    // tokens. This is by design — short titles can't generate a
    // reliable mismatch signal so we never drop on them.
    expect(titlesShareAnyToken('hi', 'totally different content')).toBe(true);
    expect(titlesShareAnyToken('a b c', 'unrelated lengthy article title')).toBe(true);
  });

  it('REQ-PIPE-002: punctuation differences do not break match', () => {
    expect(
      titlesShareAnyToken(
        'Microsoft, Apple announce new partnership',
        'Microsoft & Apple — partnership details',
      ),
    ).toBe(true);
  });

  it('REQ-PIPE-002: case differences do not break match', () => {
    expect(
      titlesShareAnyToken(
        'GOOGLE quantum chip benchmark',
        'google Quantum Chip Benchmark',
      ),
    ).toBe(true);
  });

  it('REQ-PIPE-002: empty titles are accepted (trivially)', () => {
    expect(titlesShareAnyToken('', 'whatever lengthy headline goes here')).toBe(true);
    expect(titlesShareAnyToken('whatever lengthy headline', '')).toBe(true);
    expect(titlesShareAnyToken('', '')).toBe(true);
  });

  it('REQ-PIPE-002: single shared substantive token is enough to match', () => {
    expect(
      titlesShareAnyToken(
        'OpenAI tightens API rate limits',
        'After backlash, OpenAI relaxes new policy',
      ),
    ).toBe(true);
  });

  it('REQ-PIPE-002: shared stopwords do NOT count as overlap', () => {
    // "the new release" vs "the new launch" — only stopwords overlap.
    // Tokenisation drops everything → both sides yield 0 tokens
    // → trivially-true short-circuit fires (size < 2).
    // The intent of the test is to pin that stopwords alone don't
    // cause a false positive when there ARE non-stopword tokens on
    // each side.
    expect(
      titlesShareAnyToken(
        'AlphaCorp release announcement details',
        'BetaCorp launch announcement details',
      ),
    ).toBe(true); // 'announcement' + 'details' overlap
    expect(
      titlesShareAnyToken(
        'AlphaCorp announces release',
        'BetaCorp announces launch',
      ),
    ).toBe(false); // 'alphacorp' vs 'betacorp' alone — no overlap; 'announces' is a stopword
  });
});
