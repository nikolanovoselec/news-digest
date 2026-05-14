// Tests for src/lib/dedup-rerank.ts - REQ-PIPE-009.

import { describe, it, expect, vi } from 'vitest';
import {
  rerankBorderlinePairsBatch,
  readRerankFloor,
  DEFAULT_RERANK_FLOOR,
  RERANK_BATCH_SIZE,
  type RerankPair,
} from '~/lib/dedup-rerank';

function makeAi(response: unknown) {
  return {
    AI: {
      run: vi.fn().mockResolvedValue(response),
    },
  } as unknown as Pick<Env, 'AI'>;
}

function makeAiSequence(responses: unknown[]) {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  return {
    AI: { run: fn },
  } as unknown as Pick<Env, 'AI'> & { AI: { run: ReturnType<typeof vi.fn> } };
}

function pair(i: number, sameEventHint: boolean): RerankPair {
  return {
    a: { id: `a${i}`, title: `Article A ${i}`, snippet: `snippet a ${i}` },
    b: {
      id: `b${i}`,
      title: `Article B ${i}${sameEventHint ? ' same' : ' different'}`,
      snippet: `snippet b ${i}`,
    },
  };
}

function verdictResponse(indices: ReadonlyArray<{ i: number; same_event: boolean }>) {
  return { response: JSON.stringify({ verdicts: indices }) };
}

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

describe('rerankBorderlinePairsBatch - REQ-PIPE-009 (AD48 batched API)', () => {
  it('returns [] on empty input without calling the AI', async () => {
    const env = makeAi({ response: '{"verdicts":[]}' });
    const verdicts = await rerankBorderlinePairsBatch(env, []);
    expect(verdicts).toEqual([]);
    expect((env.AI as unknown as { run: ReturnType<typeof vi.fn> }).run).not
      .toHaveBeenCalled();
  });

  it('returns verdicts aligned to input order for a single-pair batch', async () => {
    const env = makeAi(
      verdictResponse([{ i: 0, same_event: true }]),
    );
    const verdicts = await rerankBorderlinePairsBatch(env, [pair(0, true)]);
    expect(verdicts).toEqual([true]);
    expect((env.AI as unknown as { run: ReturnType<typeof vi.fn> }).run).toHaveBeenCalledTimes(1);
  });

  it('returns verdicts for a 5-pair batch in one LLM call', async () => {
    const env = makeAi(
      verdictResponse([
        { i: 0, same_event: true },
        { i: 1, same_event: false },
        { i: 2, same_event: true },
        { i: 3, same_event: false },
        { i: 4, same_event: true },
      ]),
    );
    const verdicts = await rerankBorderlinePairsBatch(env, [
      pair(0, true),
      pair(1, false),
      pair(2, true),
      pair(3, false),
      pair(4, true),
    ]);
    expect(verdicts).toEqual([true, false, true, false, true]);
    expect((env.AI as unknown as { run: ReturnType<typeof vi.fn> }).run).toHaveBeenCalledTimes(1);
  });

  it('handles exactly RERANK_BATCH_SIZE pairs in a single call', async () => {
    const pairs: RerankPair[] = [];
    const verdictEntries: Array<{ i: number; same_event: boolean }> = [];
    for (let i = 0; i < RERANK_BATCH_SIZE; i++) {
      pairs.push(pair(i, i % 2 === 0));
      verdictEntries.push({ i, same_event: i % 2 === 0 });
    }
    const env = makeAi(verdictResponse(verdictEntries));
    const verdicts = await rerankBorderlinePairsBatch(env, pairs);
    expect(verdicts).toHaveLength(RERANK_BATCH_SIZE);
    expect(verdicts.every((v, i) => v === (i % 2 === 0))).toBe(true);
    expect((env.AI as unknown as { run: ReturnType<typeof vi.fn> }).run).toHaveBeenCalledTimes(1);
  });

  it('splits RERANK_BATCH_SIZE+1 pairs across two LLM calls and preserves order', async () => {
    const pairs: RerankPair[] = [];
    for (let i = 0; i < RERANK_BATCH_SIZE + 1; i++) {
      pairs.push(pair(i, true));
    }
    // First call gets indices 0..RERANK_BATCH_SIZE-1; second call sees the
    // last pair re-indexed to 0 (each batch re-numbers `i` from 0).
    const firstBatch = Array.from({ length: RERANK_BATCH_SIZE }, (_v, i) => ({
      i,
      same_event: true,
    }));
    const secondBatch = [{ i: 0, same_event: false }];
    const env = makeAiSequence([
      verdictResponse(firstBatch),
      verdictResponse(secondBatch),
    ]);
    const verdicts = await rerankBorderlinePairsBatch(env, pairs);
    expect(verdicts).toHaveLength(RERANK_BATCH_SIZE + 1);
    for (let i = 0; i < RERANK_BATCH_SIZE; i++) {
      expect(verdicts[i]).toBe(true);
    }
    expect(verdicts[RERANK_BATCH_SIZE]).toBe(false);
    expect((env.AI as unknown as { run: ReturnType<typeof vi.fn> }).run).toHaveBeenCalledTimes(2);
  });

  it('returns all-false for a batch when the LLM emits unparseable JSON', async () => {
    const env = makeAi({ response: 'not-json' });
    const verdicts = await rerankBorderlinePairsBatch(env, [
      pair(0, true),
      pair(1, true),
      pair(2, true),
    ]);
    expect(verdicts).toEqual([false, false, false]);
  });

  it('returns all-false when the AI binding throws', async () => {
    const env = {
      AI: { run: vi.fn().mockRejectedValue(new Error('boom')) },
    } as unknown as Pick<Env, 'AI'>;
    const verdicts = await rerankBorderlinePairsBatch(env, [
      pair(0, true),
      pair(1, true),
    ]);
    expect(verdicts).toEqual([false, false]);
  });

  it('returns all-false when the response is missing a verdicts array', async () => {
    const env = makeAi({ response: '{"other_field":true}' });
    const verdicts = await rerankBorderlinePairsBatch(env, [pair(0, true)]);
    expect(verdicts).toEqual([false]);
  });

  it('defaults a pair to false when the model drops its verdict entry', async () => {
    // Model returns only one verdict for a two-pair input.
    const env = makeAi(verdictResponse([{ i: 0, same_event: true }]));
    const verdicts = await rerankBorderlinePairsBatch(env, [
      pair(0, true),
      pair(1, true),
    ]);
    expect(verdicts).toEqual([true, false]);
  });

  it('ignores verdict entries with out-of-range indices', async () => {
    const env = makeAi(
      verdictResponse([
        { i: 0, same_event: true },
        { i: 99, same_event: true },
      ]),
    );
    const verdicts = await rerankBorderlinePairsBatch(env, [pair(0, true)]);
    expect(verdicts).toEqual([true]);
  });

  it('handles direct-object response shape (no string wrapping)', async () => {
    const env = makeAi({
      response: { verdicts: [{ i: 0, same_event: true }] },
    });
    const verdicts = await rerankBorderlinePairsBatch(env, [pair(0, true)]);
    expect(verdicts).toEqual([true]);
  });
});
