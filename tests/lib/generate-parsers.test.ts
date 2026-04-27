// Tests for the LLM-response parsers in src/lib/generate.ts —
// REQ-PIPE-002 / REQ-PIPE-008 (CF-016).
//
// The chunk consumer and the cross-chunk finalize consumer both feed
// raw `env.AI.run()` output through these parsers before consuming
// the structured payload. Both surfaces tolerate the same set of
// model deviations (already-parsed object, ```json fences, prose
// preamble, trailing chatter, balanced-brace recovery) so the
// pipeline can stay idempotent under model upgrades that change how
// `response_format: json_object` is honoured.

import { describe, it, expect } from 'vitest';
import { parseLLMPayload, parseLLMJson } from '~/lib/generate';

describe('parseLLMPayload — REQ-PIPE-002', () => {
  it('REQ-PIPE-002: accepts an already-parsed object on the response field', () => {
    const out = parseLLMPayload({ articles: [{ title: 'a' }] });
    expect(out).not.toBeNull();
    expect(out?.articles).toHaveLength(1);
  });

  it('REQ-PIPE-002: rejects a non-object response (boolean, number, null)', () => {
    expect(parseLLMPayload(null)).toBeNull();
    expect(parseLLMPayload(42)).toBeNull();
    expect(parseLLMPayload(true)).toBeNull();
  });

  it('REQ-PIPE-002: rejects an object missing the articles array', () => {
    expect(parseLLMPayload({ other: 'shape' })).toBeNull();
    expect(parseLLMPayload({ articles: 'not-array' })).toBeNull();
  });

  it('REQ-PIPE-002: parses a fenced ```json block with a prose preamble', () => {
    const raw =
      'Sure, here is the JSON you asked for:\n\n```json\n' +
      '{"articles":[{"title":"t","url":"https://e/x"}]}\n```';
    const out = parseLLMPayload(raw);
    expect(out?.articles).toHaveLength(1);
  });

  it('REQ-PIPE-002: parses a bare JSON string', () => {
    const out = parseLLMPayload('{"articles":[{"title":"t"}]}');
    expect(out?.articles).toHaveLength(1);
  });

  it('REQ-PIPE-002: balanced-brace fallback recovers from trailing prose', () => {
    // The model emits valid JSON then keeps talking. The first-brace
    // walker should cut at the matching `}` and ignore the suffix.
    const raw = 'Here you go: {"articles":[{"title":"x"}]} \nLet me know if you want more.';
    const out = parseLLMPayload(raw);
    expect(out?.articles).toHaveLength(1);
  });

  it('REQ-PIPE-002: nested braces inside string literals do not confuse the walker', () => {
    // The walker must respect "..." string boundaries so a `}` inside
    // a string literal doesn't close the outer object early.
    const raw =
      'preamble {"articles":[{"title":"contains } inside","url":"u"}]} trailing';
    const out = parseLLMPayload(raw);
    expect(out?.articles).toHaveLength(1);
    const articles = out?.articles;
    expect(articles).toBeDefined();
    expect((articles![0] as { title: string }).title).toContain('}');
  });

  it('REQ-PIPE-002: invalid JSON returns null', () => {
    expect(parseLLMPayload('not json at all')).toBeNull();
    expect(parseLLMPayload('{ unterminated ')).toBeNull();
  });

  it('REQ-PIPE-002: empty string returns null', () => {
    expect(parseLLMPayload('')).toBeNull();
  });
});

describe('parseLLMJson — REQ-PIPE-008', () => {
  it('REQ-PIPE-008: accepts an already-parsed object', () => {
    const out = parseLLMJson({ dedup_groups: [[1, 2]] });
    expect(out?.['dedup_groups']).toEqual([[1, 2]]);
  });

  it('REQ-PIPE-008: parses a fenced ```json finalize response', () => {
    const raw = '```json\n{"dedup_groups":[[0,3,7]]}\n```';
    const out = parseLLMJson(raw);
    expect(out?.['dedup_groups']).toEqual([[0, 3, 7]]);
  });

  it('REQ-PIPE-008: balanced-brace recovery on prose-wrapped finalize', () => {
    const raw = 'I found two pairs: {"dedup_groups":[[1,4]]} thank you!';
    const out = parseLLMJson(raw);
    expect(out?.['dedup_groups']).toEqual([[1, 4]]);
  });

  it('REQ-PIPE-008: rejects strings that contain no balanced object', () => {
    expect(parseLLMJson('plain prose, no json')).toBeNull();
    expect(parseLLMJson('{ unterminated')).toBeNull();
  });

  it('REQ-PIPE-008: rejects null / number / boolean', () => {
    expect(parseLLMJson(null)).toBeNull();
    expect(parseLLMJson(42)).toBeNull();
    expect(parseLLMJson(true)).toBeNull();
  });

  it('REQ-PIPE-008: rejects an empty string', () => {
    expect(parseLLMJson('')).toBeNull();
  });

  it('REQ-PIPE-008: returns the parsed object even when it has no dedup_groups (caller validates fields)', () => {
    // Per the helper's contract, parseLLMJson is the loose parser —
    // it only enforces "must parse to a non-null object", and leaves
    // field validation to the caller. The finalize consumer does its
    // own dedup_groups shape check downstream.
    const out = parseLLMJson('{"other":"shape"}');
    expect(out).toEqual({ other: 'shape' });
  });
});
