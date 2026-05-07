// Tests for src/lib/dedup-rerank.ts - REQ-PIPE-009.

import { describe, it, expect, vi } from 'vitest';
import {
  rerankBorderlinePair,
  readRerankFloor,
  DEFAULT_RERANK_FLOOR,
} from '~/lib/dedup-rerank';

function makeAi(response: unknown) {
  return {
    AI: {
      run: vi.fn().mockResolvedValue(response),
    },
  } as unknown as Pick<Env, 'AI'>;
}

const A = { id: 'a', title: 'A title', snippet: 'A snippet' };
const B = { id: 'b', title: 'B title', snippet: 'B snippet' };

describe('readRerankFloor - REQ-PIPE-009', () => {
  it('returns the configured float when valid', () => {
    expect(readRerankFloor({ DEDUP_RERANK_FLOOR: '0.7' })).toBe(0.7);
  });

  it('falls back to default when env var is missing', () => {
    expect(readRerankFloor({} as Pick<Env, 'DEDUP_RERANK_FLOOR'>)).toBe(
      DEFAULT_RERANK_FLOOR,
    );
  });

  it('falls back to default on invalid input', () => {
    expect(readRerankFloor({ DEDUP_RERANK_FLOOR: 'not-a-number' })).toBe(
      DEFAULT_RERANK_FLOOR,
    );
    expect(readRerankFloor({ DEDUP_RERANK_FLOOR: '-1' })).toBe(
      DEFAULT_RERANK_FLOOR,
    );
    expect(readRerankFloor({ DEDUP_RERANK_FLOOR: '2' })).toBe(
      DEFAULT_RERANK_FLOOR,
    );
  });
});

describe('rerankBorderlinePair - REQ-PIPE-009', () => {
  it('returns true when LLM emits {"same_event":true}', async () => {
    const env = makeAi({ response: '{"same_event":true}' });
    expect(await rerankBorderlinePair(env, A, B)).toBe(true);
  });

  it('returns false when LLM emits {"same_event":false}', async () => {
    const env = makeAi({ response: '{"same_event":false}' });
    expect(await rerankBorderlinePair(env, A, B)).toBe(false);
  });

  it('returns false when LLM response is unparseable', async () => {
    const env = makeAi({ response: 'not json at all' });
    expect(await rerankBorderlinePair(env, A, B)).toBe(false);
  });

  it('returns false when AI binding throws', async () => {
    const env = {
      AI: { run: vi.fn().mockRejectedValue(new Error('boom')) },
    } as unknown as Pick<Env, 'AI'>;
    expect(await rerankBorderlinePair(env, A, B)).toBe(false);
  });

  it('returns false when same_event is missing from payload', async () => {
    const env = makeAi({ response: '{"other_field":true}' });
    expect(await rerankBorderlinePair(env, A, B)).toBe(false);
  });

  it('handles direct-object response (json_object mode)', async () => {
    const env = makeAi({ response: { same_event: true } });
    expect(await rerankBorderlinePair(env, A, B)).toBe(true);
  });
});
