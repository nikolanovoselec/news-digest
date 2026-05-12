// Tests for src/lib/bidirectional-dedup.ts — REQ-PIPE-003 / REQ-PIPE-009.
// CF-025: the shared classifier carries dense boundary logic
// (threshold equality, same-vendor penalty, time-window cutoff, ULID
// tie-break) that previously had no direct unit coverage. Both
// finalize and historical sweep route through this expression, so a
// regression here silently splits or merges every cluster.

import { describe, it, expect } from 'vitest';
import {
  classifyMatchPair,
  type ClassifierParams,
  type SelfArticle,
  type MatchInput,
} from '~/lib/bidirectional-dedup';

const PARAMS: ClassifierParams = {
  threshold: 0.88,
  sameVendorPenalty: 0.05,
  rerankFloor: 0.7,
  timeWindowSeconds: 7 * 24 * 60 * 60, // 7d
  highConfidenceCosine: 0.92,
};

function self(over: Partial<SelfArticle> = {}): SelfArticle {
  return {
    id: '01HXX0000000000000000000A1',
    published_at: 1_700_000_000,
    primary_source_url: 'https://blog.acme.example/post-1',
    ...over,
  };
}

function match(over: Partial<MatchInput> & {
  publishedAt?: number;
  url?: string;
} = {}): MatchInput {
  const meta: Record<string, unknown> = {};
  if (over.publishedAt !== undefined) meta.published_at = over.publishedAt;
  if (over.url !== undefined) meta.primary_source_url = over.url;
  return {
    id: over.id ?? '01HXX0000000000000000000B2',
    score: over.score ?? 0.85,
    metadata: over.metadata ?? meta,
  };
}

describe('classifyMatchPair — no_metadata branch', () => {
  it('returns no_metadata when published_at is missing', () => {
    const r = classifyMatchPair(
      self(),
      match({ score: 0.95, url: 'https://b.example/x' }), // no publishedAt
      PARAMS,
    );
    expect(r.kind).toBe('no_metadata');
  });

  it('returns no_metadata when metadata is undefined', () => {
    const r = classifyMatchPair(
      self(),
      { id: 'b', score: 0.95 },
      PARAMS,
    );
    expect(r.kind).toBe('no_metadata');
  });

  it('returns no_metadata when published_at is the wrong type', () => {
    const r = classifyMatchPair(
      self(),
      {
        id: 'b',
        score: 0.95,
        metadata: { published_at: 'not-a-number' as unknown as number },
      },
      PARAMS,
    );
    expect(r.kind).toBe('no_metadata');
  });
});

describe('classifyMatchPair — out_of_window branch', () => {
  it('rejects a pair separated by more than timeWindowSeconds regardless of score', () => {
    const r = classifyMatchPair(
      self({ published_at: 1_700_000_000 }),
      match({
        score: 0.99,
        publishedAt: 1_700_000_000 + PARAMS.timeWindowSeconds + 1,
        url: 'https://b.example/x',
      }),
      PARAMS,
    );
    expect(r.kind).toBe('out_of_window');
    if (r.kind === 'out_of_window') {
      expect(r.deltaSeconds).toBe(PARAMS.timeWindowSeconds + 1);
    }
  });

  it('accepts a pair exactly at the window edge (boundary inclusive)', () => {
    const r = classifyMatchPair(
      self({ published_at: 1_700_000_000 }),
      match({
        score: 0.95,
        publishedAt: 1_700_000_000 + PARAMS.timeWindowSeconds,
        url: 'https://b.example/x',
      }),
      PARAMS,
    );
    // Window is inclusive: `>` means strictly outside.
    expect(r.kind).toBe('eligible');
  });
});

describe('classifyMatchPair — eligible branch threshold boundary', () => {
  it('auto-merges at exactly the threshold (cross-vendor, no penalty)', () => {
    const r = classifyMatchPair(
      self(),
      match({
        score: PARAMS.threshold, // exactly the bar
        publishedAt: 1_700_000_000,
        url: 'https://other.example/post',
      }),
      PARAMS,
    );
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') {
      expect(r.isAutoMerge).toBe(true);
      expect(r.adjustedScore).toBe(PARAMS.threshold);
      expect(r.sameEtld1).toBe(false);
    }
  });

  it('does not auto-merge just below the threshold', () => {
    const r = classifyMatchPair(
      self(),
      match({
        score: PARAMS.threshold - 0.001,
        publishedAt: 1_700_000_000,
        url: 'https://other.example/post',
      }),
      PARAMS,
    );
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') {
      expect(r.isAutoMerge).toBe(false);
      expect(r.isBorderline).toBe(true); // still above rerankFloor
    }
  });

  it('does not flag borderline below the rerank floor', () => {
    const r = classifyMatchPair(
      self(),
      match({
        score: PARAMS.rerankFloor - 0.01,
        publishedAt: 1_700_000_000,
        url: 'https://other.example/post',
      }),
      PARAMS,
    );
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') {
      expect(r.isAutoMerge).toBe(false);
      expect(r.isBorderline).toBe(false);
    }
  });
});

describe('classifyMatchPair — same-vendor penalty', () => {
  it('applies the penalty when both URLs share an eTLD+1', () => {
    const r = classifyMatchPair(
      self({ primary_source_url: 'https://blog.acme.example/a' }),
      match({
        score: PARAMS.threshold + 0.01,
        publishedAt: 1_700_000_000,
        url: 'https://news.acme.example/b', // same eTLD+1
      }),
      PARAMS,
    );
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') {
      expect(r.sameEtld1).toBe(true);
      // adjusted = raw - penalty; that drops it BELOW the threshold here.
      expect(r.adjustedScore).toBeCloseTo(
        PARAMS.threshold + 0.01 - PARAMS.sameVendorPenalty,
        6,
      );
      expect(r.isAutoMerge).toBe(false);
    }
  });

  it('does NOT apply the penalty cross-vendor', () => {
    const r = classifyMatchPair(
      self({ primary_source_url: 'https://blog.acme.example/a' }),
      match({
        score: PARAMS.threshold + 0.01,
        publishedAt: 1_700_000_000,
        url: 'https://other.example/b',
      }),
      PARAMS,
    );
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') {
      expect(r.sameEtld1).toBe(false);
      expect(r.adjustedScore).toBeCloseTo(PARAMS.threshold + 0.01, 6);
      expect(r.isAutoMerge).toBe(true);
    }
  });
});

describe('classifyMatchPair — high-confidence bypass', () => {
  it('auto-merges at high-confidence regardless of same-vendor penalty', () => {
    const r = classifyMatchPair(
      self({ primary_source_url: 'https://blog.acme.example/a' }),
      match({
        score: PARAMS.highConfidenceCosine + 0.001,
        publishedAt: 1_700_000_000,
        url: 'https://news.acme.example/b', // same eTLD+1
      }),
      PARAMS,
    );
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') {
      expect(r.isHighConfidence).toBe(true);
      // raw score preserved at high-confidence (penalty skipped).
      expect(r.adjustedScore).toBe(PARAMS.highConfidenceCosine + 0.001);
      expect(r.isAutoMerge).toBe(true);
    }
  });
});

describe('classifyMatchPair — selfIsOlder tie-break by ULID', () => {
  it('marks self as older when published_at is strictly earlier', () => {
    const r = classifyMatchPair(
      self({ published_at: 100 }),
      match({ score: 0.95, publishedAt: 200, url: 'https://b.example/x' }),
      PARAMS,
    );
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') expect(r.selfIsOlder).toBe(true);
  });

  it('marks self as older when published_at ties but ULID is lower', () => {
    const r = classifyMatchPair(
      self({ id: 'AAA', published_at: 100 }),
      match({
        id: 'ZZZ',
        score: 0.95,
        publishedAt: 100,
        url: 'https://b.example/x',
      }),
      PARAMS,
    );
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') expect(r.selfIsOlder).toBe(true);
  });

  it('marks match as older when published_at ties but match ULID is lower', () => {
    const r = classifyMatchPair(
      self({ id: 'ZZZ', published_at: 100 }),
      match({
        id: 'AAA',
        score: 0.95,
        publishedAt: 100,
        url: 'https://b.example/x',
      }),
      PARAMS,
    );
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') expect(r.selfIsOlder).toBe(false);
  });
});
