// Tests for src/lib/llm-json.ts — REQ-PIPE-002 + REQ-PIPE-008 (CF-009).

import { describe, it, expect, vi } from 'vitest';
import { runJsonWithFallback, previewRawResponse } from '~/lib/llm-json';

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

describe('runJsonWithFallback — REQ-PIPE-002 / REQ-PIPE-008', () => {
  it('REQ-PIPE-002: primary success path returns ok=true with zero waste', async () => {
    const ai = makeAi([
      { response: '{"articles": [{"title": "ok"}]}', usage: { input_tokens: 10, output_tokens: 20 } },
    ]);
    const result = await runJsonWithFallback({
      ai,
      params: { messages: [] },
      narrow: (raw) => (typeof raw === 'string' ? (JSON.parse(raw) as { articles: unknown[] }) : null),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fallbackUsed).toBe(false);
    expect(result.parsed.articles).toHaveLength(1);
    expect(result.tokensIn).toBe(10);
    expect(result.tokensOut).toBe(20);
    expect(result.wastedTokensIn).toBe(0);
    expect(result.wastedTokensOut).toBe(0);
    expect(result.wastedCostUsd).toBe(0);
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it('REQ-PIPE-002: primary fails, fallback succeeds — fallbackUsed=true with waste counters from primary', async () => {
    const ai = makeAi([
      { response: 'malformed not json', usage: { input_tokens: 5, output_tokens: 7 } },
      { response: '{"articles": [{"title": "fallback win"}]}', usage: { input_tokens: 11, output_tokens: 13 } },
    ]);
    const onPrimaryFailure = vi.fn();
    const result = await runJsonWithFallback({
      ai,
      params: { messages: [] },
      narrow: (raw) => {
        try {
          return typeof raw === 'string' ? (JSON.parse(raw) as { articles: unknown[] }) : null;
        } catch {
          return null;
        }
      },
      onPrimaryFailure,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fallbackUsed).toBe(true);
    expect(result.tokensIn).toBe(11);
    expect(result.tokensOut).toBe(13);
    expect(result.wastedTokensIn).toBe(5);
    expect(result.wastedTokensOut).toBe(7);
    // onPrimaryFailure fires exactly once with primary AttemptInfo.
    expect(onPrimaryFailure).toHaveBeenCalledTimes(1);
    const info = onPrimaryFailure.mock.calls[0]?.[0] as { tokensIn: number; tokensOut: number; rawResponse: unknown };
    expect(info.tokensIn).toBe(5);
    expect(info.tokensOut).toBe(7);
    expect(info.rawResponse).toBe('malformed not json');
  });

  it('REQ-PIPE-002: both fail — ok=false with both AttemptInfos populated', async () => {
    const ai = makeAi([
      { response: 'bad1', usage: { input_tokens: 3, output_tokens: 4 } },
      { response: 'bad2', usage: { input_tokens: 6, output_tokens: 8 } },
    ]);
    const result = await runJsonWithFallback({
      ai,
      params: { messages: [] },
      narrow: () => null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.primary.tokensIn).toBe(3);
    expect(result.primary.tokensOut).toBe(4);
    expect(result.primary.rawResponse).toBe('bad1');
    expect(result.fallback.tokensIn).toBe(6);
    expect(result.fallback.tokensOut).toBe(8);
    expect(result.fallback.rawResponse).toBe('bad2');
    expect(result.wastedTokensIn).toBe(3);
    expect(result.wastedTokensOut).toBe(4);
  });

  it('REQ-PIPE-002: onPrimaryFailure is NOT called when primary succeeds', async () => {
    const ai = makeAi([
      { response: '{"ok": true}', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const onPrimaryFailure = vi.fn();
    await runJsonWithFallback({
      ai,
      params: { messages: [] },
      narrow: (raw) => (typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null),
      onPrimaryFailure,
    });
    expect(onPrimaryFailure).not.toHaveBeenCalled();
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it('REQ-PIPE-002: primaryModel/fallbackModel overrides are honoured', async () => {
    const ai = makeAi([
      { response: 'bad', usage: { input_tokens: 1, output_tokens: 1 } },
      { response: '{}', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const result = await runJsonWithFallback({
      ai,
      params: { messages: [] },
      narrow: (raw) => (raw === '{}' ? {} : null),
      primaryModel: 'custom-primary',
      fallbackModel: 'custom-fallback',
    });
    expect(ai.run).toHaveBeenCalledTimes(2);
    expect(ai.run.mock.calls[0]?.[0]).toBe('custom-primary');
    expect(ai.run.mock.calls[1]?.[0]).toBe('custom-fallback');
    if (!result.ok) return;
    expect(result.modelUsed).toBe('custom-fallback');
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
