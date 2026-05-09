// Tests for src/lib/embeddings.ts — REQ-PIPE-003
import { describe, it, expect, vi } from 'vitest';
import {
  buildEmbeddingInput,
  cosineSimilarity,
  embedTexts,
  deleteVectorsBatched,
  readCosineThreshold,
  readHighConfidenceCosine,
  readSameVendorPenalty,
  readTimeWindowSeconds,
  EMBEDDING_MODEL_ID,
  DEFAULT_COSINE_THRESHOLD,
  DEFAULT_HIGH_CONFIDENCE_COSINE,
  DEFAULT_SAME_VENDOR_PENALTY,
  DEFAULT_TIME_WINDOW_SECONDS,
} from '~/lib/embeddings';

describe('buildEmbeddingInput', () => {
  it('REQ-PIPE-003: prefixes title before body so leading-token attention favours headlines', () => {
    const out = buildEmbeddingInput({
      title: 'Headline X',
      details_json: JSON.stringify(['body-1', 'body-2']),
    });
    expect(out.startsWith('Headline X')).toBe(true);
    expect(out).toContain('body-1');
    expect(out).toContain('body-2');
  });

  it('REQ-PIPE-003: collapses whitespace from multi-paragraph details', () => {
    const out = buildEmbeddingInput({
      title: 'T',
      details_json: JSON.stringify(['line one\n\nline two', '   line three   ']),
    });
    expect(out).not.toMatch(/\s\s/);
  });

  it('REQ-PIPE-003: caps total length at MAX_INPUT_CHARS', () => {
    const long = 'x'.repeat(5000);
    const out = buildEmbeddingInput({
      title: 'T',
      details_json: JSON.stringify([long]),
    });
    // The cap is 1800 — output must not exceed it.
    expect(out.length).toBeLessThanOrEqual(1800);
  });

  it('REQ-PIPE-003: tolerates malformed details_json JSON', () => {
    const out = buildEmbeddingInput({
      title: 'Headline',
      details_json: 'not-json{',
    });
    expect(out.startsWith('Headline')).toBe(true);
  });

  it('REQ-PIPE-003: falls back to body_summary when details_json is missing', () => {
    const out = buildEmbeddingInput({
      title: 'Headline',
      body_summary: 'plain body',
    });
    expect(out).toContain('plain body');
  });

  it('REQ-PIPE-003: prefers source_snippet over details_json when both present', () => {
    const out = buildEmbeddingInput({
      title: 'Headline',
      source_snippet: 'raw scraped text',
      details_json: JSON.stringify(['llm rewritten paragraph']),
    });
    expect(out).toContain('raw scraped text');
    expect(out).not.toContain('llm rewritten paragraph');
  });

  it('REQ-PIPE-003: falls back to details_json when source_snippet is null', () => {
    const out = buildEmbeddingInput({
      title: 'Headline',
      source_snippet: null,
      details_json: JSON.stringify(['llm body']),
    });
    expect(out).toContain('llm body');
  });

  it('REQ-PIPE-003: falls back to details_json when source_snippet is empty string', () => {
    const out = buildEmbeddingInput({
      title: 'Headline',
      source_snippet: '',
      details_json: JSON.stringify(['llm body']),
    });
    expect(out).toContain('llm body');
  });
});

describe('readSameVendorPenalty', () => {
  it('returns the default when env var is unset', () => {
    expect(readSameVendorPenalty({})).toBe(DEFAULT_SAME_VENDOR_PENALTY);
  });

  it('parses a valid float from the env', () => {
    expect(readSameVendorPenalty({ DEDUP_SAME_VENDOR_PENALTY: '0.1' })).toBe(0.1);
  });

  it('falls back to the default on out-of-range values', () => {
    expect(readSameVendorPenalty({ DEDUP_SAME_VENDOR_PENALTY: '-0.05' })).toBe(
      DEFAULT_SAME_VENDOR_PENALTY,
    );
    expect(readSameVendorPenalty({ DEDUP_SAME_VENDOR_PENALTY: '2' })).toBe(
      DEFAULT_SAME_VENDOR_PENALTY,
    );
  });

  it('falls back to the default on non-numeric values', () => {
    expect(readSameVendorPenalty({ DEDUP_SAME_VENDOR_PENALTY: 'banana' })).toBe(
      DEFAULT_SAME_VENDOR_PENALTY,
    );
  });

  it('accepts 0 as a valid penalty (disables the feature without falling back)', () => {
    expect(readSameVendorPenalty({ DEDUP_SAME_VENDOR_PENALTY: '0' })).toBe(0);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical unit vectors', () => {
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('returns -1 for anti-parallel vectors', () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 6);
  });

  it('returns 0 on empty input rather than throwing', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 0], [])).toBe(0);
  });

  it('returns 0 on mismatched lengths', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it('returns 0 when either vector has zero magnitude', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('readCosineThreshold', () => {
  it('returns the default when env var is unset', () => {
    expect(readCosineThreshold({})).toBe(DEFAULT_COSINE_THRESHOLD);
  });

  it('parses a valid float from the env', () => {
    expect(readCosineThreshold({ DEDUP_COSINE_THRESHOLD: '0.9' })).toBe(0.9);
  });

  it('falls back to the default on out-of-range values', () => {
    expect(readCosineThreshold({ DEDUP_COSINE_THRESHOLD: '-0.5' })).toBe(
      DEFAULT_COSINE_THRESHOLD,
    );
    expect(readCosineThreshold({ DEDUP_COSINE_THRESHOLD: '1.5' })).toBe(
      DEFAULT_COSINE_THRESHOLD,
    );
  });

  it('falls back to the default on non-numeric values', () => {
    expect(readCosineThreshold({ DEDUP_COSINE_THRESHOLD: 'banana' })).toBe(
      DEFAULT_COSINE_THRESHOLD,
    );
  });
});

describe('readTimeWindowSeconds', () => {
  it('REQ-PIPE-003 AC 13: returns the default (72h) when env var is unset', () => {
    expect(readTimeWindowSeconds({})).toBe(DEFAULT_TIME_WINDOW_SECONDS);
    expect(DEFAULT_TIME_WINDOW_SECONDS).toBe(259_200);
  });

  it('parses a valid positive number from the env', () => {
    expect(readTimeWindowSeconds({ DEDUP_TIME_WINDOW_SECONDS: '86400' })).toBe(
      86_400,
    );
  });

  it('falls back to the default on zero or negative values (never disables the gate silently)', () => {
    expect(readTimeWindowSeconds({ DEDUP_TIME_WINDOW_SECONDS: '0' })).toBe(
      DEFAULT_TIME_WINDOW_SECONDS,
    );
    expect(readTimeWindowSeconds({ DEDUP_TIME_WINDOW_SECONDS: '-1' })).toBe(
      DEFAULT_TIME_WINDOW_SECONDS,
    );
  });

  it('falls back to the default on non-numeric values', () => {
    expect(
      readTimeWindowSeconds({ DEDUP_TIME_WINDOW_SECONDS: 'banana' }),
    ).toBe(DEFAULT_TIME_WINDOW_SECONDS);
  });

  it('accepts a very large number to effectively disable the time gate', () => {
    expect(
      readTimeWindowSeconds({ DEDUP_TIME_WINDOW_SECONDS: '999999999' }),
    ).toBe(999_999_999);
  });
});

describe('readHighConfidenceCosine', () => {
  it('REQ-PIPE-003 AD40: returns the default (0.92) when env var is unset', () => {
    expect(readHighConfidenceCosine({})).toBe(DEFAULT_HIGH_CONFIDENCE_COSINE);
    expect(DEFAULT_HIGH_CONFIDENCE_COSINE).toBe(0.92);
  });

  it('parses a valid float in (0, 1] from the env', () => {
    expect(
      readHighConfidenceCosine({ DEDUP_HIGH_CONFIDENCE_COSINE: '0.95' }),
    ).toBe(0.95);
    expect(readHighConfidenceCosine({ DEDUP_HIGH_CONFIDENCE_COSINE: '1' })).toBe(
      1,
    );
  });

  it('falls back to the default on zero, negative, or out-of-range values', () => {
    expect(
      readHighConfidenceCosine({ DEDUP_HIGH_CONFIDENCE_COSINE: '0' }),
    ).toBe(DEFAULT_HIGH_CONFIDENCE_COSINE);
    expect(
      readHighConfidenceCosine({ DEDUP_HIGH_CONFIDENCE_COSINE: '-0.5' }),
    ).toBe(DEFAULT_HIGH_CONFIDENCE_COSINE);
    expect(
      readHighConfidenceCosine({ DEDUP_HIGH_CONFIDENCE_COSINE: '1.5' }),
    ).toBe(DEFAULT_HIGH_CONFIDENCE_COSINE);
  });

  it('falls back to the default on non-numeric values', () => {
    expect(
      readHighConfidenceCosine({ DEDUP_HIGH_CONFIDENCE_COSINE: 'banana' }),
    ).toBe(DEFAULT_HIGH_CONFIDENCE_COSINE);
  });
});

describe('embedTexts', () => {
  it('REQ-PIPE-003: calls Workers AI with the pinned bge-base model id', async () => {
    const run = vi.fn().mockResolvedValue({
      data: [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ],
    });
    await embedTexts({ run } as Pick<Ai, 'run'>, ['t1', 't2']);
    expect(run).toHaveBeenCalledTimes(1);
    const [model, params] = run.mock.calls[0] as [string, { text: string[] }];
    expect(model).toBe(EMBEDDING_MODEL_ID);
    expect(params.text).toEqual(['t1', 't2']);
  });

  it('REQ-PIPE-003: returns the vectors in input order', async () => {
    const run = vi.fn().mockResolvedValue({
      data: [
        [1, 1, 1],
        [2, 2, 2],
      ],
    });
    const out = await embedTexts({ run } as Pick<Ai, 'run'>, ['a', 'b']);
    expect(out[0]).toEqual([1, 1, 1]);
    expect(out[1]).toEqual([2, 2, 2]);
  });

  it('REQ-PIPE-003: throws on length mismatch between inputs and response', async () => {
    const run = vi.fn().mockResolvedValue({
      data: [[1, 1, 1]],
    });
    await expect(
      embedTexts({ run } as Pick<Ai, 'run'>, ['a', 'b']),
    ).rejects.toThrow(/expected 2 vectors, got 1/);
  });

  it('REQ-PIPE-003: throws on empty vector in response', async () => {
    const run = vi.fn().mockResolvedValue({
      data: [[], [1, 2, 3]],
    });
    await expect(
      embedTexts({ run } as Pick<Ai, 'run'>, ['a', 'b']),
    ).rejects.toThrow(/empty vector/);
  });

  it('REQ-PIPE-003: returns empty array for empty inputs without calling AI', async () => {
    const run = vi.fn();
    const out = await embedTexts({ run } as Pick<Ai, 'run'>, []);
    expect(out).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003: throws when batch exceeds the cap', async () => {
    const run = vi.fn();
    const huge = Array.from({ length: 200 }, (_, i) => `t${i}`);
    await expect(
      embedTexts({ run } as Pick<Ai, 'run'>, huge),
    ).rejects.toThrow(/batch size 200 exceeds cap/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('deleteVectorsBatched', () => {
  it('REQ-PIPE-003: no-ops when ids is empty (no platform call)', async () => {
    const deleteByIds = vi.fn();
    await deleteVectorsBatched({ deleteByIds }, []);
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003: passes a small id list through in a single call', async () => {
    const deleteByIds = vi.fn().mockResolvedValue({ count: 0, ids: [] });
    const ids = ['a', 'b', 'c'];
    await deleteVectorsBatched({ deleteByIds }, ids);
    expect(deleteByIds).toHaveBeenCalledTimes(1);
    expect(deleteByIds).toHaveBeenCalledWith(ids);
  });

  it('REQ-PIPE-003: pages oversized lists at the 100-id platform ceiling', async () => {
    const deleteByIds = vi.fn().mockResolvedValue({ count: 0, ids: [] });
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    await deleteVectorsBatched({ deleteByIds }, ids);
    // 250 ids → 100 + 100 + 50 → three calls.
    expect(deleteByIds).toHaveBeenCalledTimes(3);
    const firstSlice = deleteByIds.mock.calls[0]![0] as string[];
    const secondSlice = deleteByIds.mock.calls[1]![0] as string[];
    const thirdSlice = deleteByIds.mock.calls[2]![0] as string[];
    expect(firstSlice).toHaveLength(100);
    expect(secondSlice).toHaveLength(100);
    expect(thirdSlice).toHaveLength(50);
    // No id is dropped or duplicated across pages.
    const flattened = [...firstSlice, ...secondSlice, ...thirdSlice];
    expect(flattened).toEqual(ids);
  });

  it('REQ-PIPE-003: with no onPageError, propagates the underlying error', async () => {
    const deleteByIds = vi.fn().mockRejectedValueOnce(new Error('platform 503'));
    const ids = ['a', 'b'];
    await expect(deleteVectorsBatched({ deleteByIds }, ids)).rejects.toThrow(
      /platform 503/,
    );
  });

  it('REQ-PIPE-003: with onPageError, swallows per-page failures and continues paging', async () => {
    const deleteByIds = vi
      .fn()
      .mockResolvedValueOnce({ count: 0, ids: [] })
      .mockRejectedValueOnce(new Error('platform 503 on page 2'))
      .mockResolvedValueOnce({ count: 0, ids: [] });
    const errors: Array<{ err: unknown; sliceLen: number }> = [];
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    await deleteVectorsBatched({ deleteByIds }, ids, (err, slice) => {
      errors.push({ err, sliceLen: slice.length });
    });
    // All three pages were attempted despite the middle failure.
    expect(deleteByIds).toHaveBeenCalledTimes(3);
    expect(errors).toHaveLength(1);
    expect(String(errors[0]!.err)).toContain('platform 503 on page 2');
    expect(errors[0]!.sliceLen).toBe(100);
  });
});
