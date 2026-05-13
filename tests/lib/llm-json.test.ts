// Tests for src/lib/llm-json.ts — REQ-PIPE-002 + REQ-PIPE-003 (CF-009).
//
// Single-model architecture (2026-05-06): the helper runs ONE model
// per call. Earlier primary→fallback semantics were removed when the
// project consolidated on a single default model. The previous
// fallback / waste-counter / circuit-breaker tests were removed
// alongside the code that produced them.

import { describe, it, expect, vi } from 'vitest';
import { runJson, previewRawResponse } from '~/lib/llm-json';

function makeAi(responses: Array<{ response: string; usage?: { input_tokens?: number; output_tokens?: number } }>) {
  let i = 0;
  return {
    run: vi.fn().mockImplementation(async () => {
      const r = responses[i++];
      if (r === undefined) throw new Error('makeAi: ran out of canned responses');
      return r;
    }),
  };
}

describe('runJson — REQ-PIPE-002 / REQ-PIPE-003', () => {
  it('REQ-PIPE-002: success path returns ok=true with token counts', async () => {
    const ai = makeAi([
      { response: '{"articles": [{"title": "ok"}]}', usage: { input_tokens: 10, output_tokens: 20 } },
    ]);
    const result = await runJson({
      ai,
      params: { messages: [] },
      narrow: (raw) => (typeof raw === 'string' ? (JSON.parse(raw) as { articles: unknown[] }) : null),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.articles).toHaveLength(1);
    expect(result.tokensIn).toBe(10);
    expect(result.tokensOut).toBe(20);
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it('REQ-PIPE-002: parse failure returns ok=false with attempt info', async () => {
    const ai = makeAi([
      { response: 'malformed not json', usage: { input_tokens: 5, output_tokens: 7 } },
    ]);
    const result = await runJson({
      ai,
      params: { messages: [] },
      narrow: (raw) => {
        try {
          return typeof raw === 'string' ? (JSON.parse(raw) as { articles: unknown[] }) : null;
        } catch {
          return null;
        }
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempt.tokensIn).toBe(5);
    expect(result.attempt.tokensOut).toBe(7);
    expect(result.attempt.rawResponse).toBe('malformed not json');
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it('REQ-PIPE-002: model override is honoured', async () => {
    const ai = makeAi([
      { response: '{"x": 1}', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const result = await runJson({
      ai,
      params: { messages: [] },
      narrow: (raw) => (typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null),
      model: 'custom-model',
    });
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(ai.run.mock.calls[0]?.[0]).toBe('custom-model');
    if (!result.ok) return;
    expect(result.modelUsed).toBe('custom-model');
  });

  it('returns ok=false with a captured error when ai.run throws (e.g. AiError 3046 timeout)', async () => {
    // Workers AI surfaces request-timeouts and capacity errors as
    // thrown AiError objects. The helper must catch the throw and
    // surface it as `ok: false` so the queue handler can decide
    // whether to retry (single-model architecture: no fallback).
    const aiThrowing = {
      run: vi.fn().mockImplementationOnce(async () => {
        throw new Error('AiError: 3046: Request timeout');
      }),
    };
    const result = await runJson({
      ai: aiThrowing,
      params: { messages: [] },
      narrow: (raw) => (typeof raw === 'string' ? (JSON.parse(raw) as { articles: unknown[] }) : null),
    });
    expect(aiThrowing.run).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempt.rawResponse).toEqual({ error: expect.stringContaining('3046') as unknown });
  });
});

describe('previewRawResponse', () => {
  it('truncates strings to the requested length', () => {
    const long = 'x'.repeat(1000);
    expect(previewRawResponse(long).length).toBe(400);
    expect(previewRawResponse(long, 50).length).toBe(50);
  });

  it('serialises non-string responses through JSON.stringify before truncating', () => {
    const obj = { a: 1, b: 'hello' };
    expect(previewRawResponse(obj)).toBe(JSON.stringify(obj));
  });
});
