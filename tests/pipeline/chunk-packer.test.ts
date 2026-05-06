// Tests for `packCandidatesIntoChunks` / `estimateCandidateChars` in
// src/queue/scrape-coordinator.ts. These are the pure helpers behind
// the budget-aware packing the coordinator uses to size queue messages
// for the chunk-consumer LLM call. Tests run the helpers directly with
// hand-built inputs and assert observable structural invariants of the
// returned chunks (count, sizes, total preservation).
//
// Implements REQ-PIPE-001.

import { describe, it, expect } from 'vitest';
import {
  type ChunkCandidate,
  estimateCandidateChars,
  packCandidatesIntoChunks,
} from '~/queue/scrape-coordinator';
import { SNIPPET_FLOOR } from '~/queue/scrape-chunk-consumer';

function makeCandidate(overrides: Partial<ChunkCandidate> = {}): ChunkCandidate {
  const base: ChunkCandidate = {
    canonical_url: 'https://example.com/a',
    source_url: 'https://example.com/a',
    source_name: 'Example',
    title: 'Title',
    published_at: 1_700_000_000,
    alternatives: [],
  };
  return { ...base, ...overrides };
}

describe('estimateCandidateChars (REQ-PIPE-001)', () => {
  it('uses ESTIMATED_BODY_FETCH_CHARS (3000) when snippet is omitted', () => {
    // body_snippet absent — coordinator hasn't fetched it yet.
    const cost = estimateCandidateChars(makeCandidate());
    // 3000 (estimated body) + 400 (overhead) = 3400
    expect(cost).toBe(3400);
  });

  it('uses ESTIMATED_BODY_FETCH_CHARS when snippet is shorter than SNIPPET_FLOOR', () => {
    const cost = estimateCandidateChars(makeCandidate({ body_snippet: 'short' }));
    expect(cost).toBe(3400);
  });

  it('uses snippet.length when snippet meets the SNIPPET_FLOOR', () => {
    const snippet = 'x'.repeat(5_000);
    const cost = estimateCandidateChars(makeCandidate({ body_snippet: snippet }));
    expect(cost).toBe(5_000 + 400);
  });

  it('treats exactly-SNIPPET_FLOOR snippets as already-fetched (boundary upper)', () => {
    const snippet = 'x'.repeat(SNIPPET_FLOOR);
    const cost = estimateCandidateChars(makeCandidate({ body_snippet: snippet }));
    expect(cost).toBe(SNIPPET_FLOOR + 400);
  });

  it('treats SNIPPET_FLOOR-1 snippets as not-yet-fetched (boundary lower)', () => {
    // Pins the `>=` semantics of the comparison. A future refactor that
    // flipped to `>` would silently change behaviour at exactly
    // SNIPPET_FLOOR; this test catches that.
    const snippet = 'x'.repeat(SNIPPET_FLOOR - 1);
    const cost = estimateCandidateChars(makeCandidate({ body_snippet: snippet }));
    expect(cost).toBe(3400);
  });
});

describe('packCandidatesIntoChunks (REQ-PIPE-001)', () => {
  it('returns no chunks for an empty input', () => {
    expect(packCandidatesIntoChunks([])).toEqual([]);
  });

  it('packs thin candidates up to the count cap (100)', () => {
    // 200 thin candidates (3400 chars each) — budget would allow ~82
    // per chunk if the count cap were not the binding constraint, but
    // here we set a generous budget so the count cap fires first.
    const candidates = Array.from({ length: 200 }, (_, i) =>
      makeCandidate({ canonical_url: `https://example.com/${i}` }),
    );
    const chunks = packCandidatesIntoChunks(candidates, 10_000_000, 100);
    expect(chunks.map((c) => c.length)).toEqual([100, 100]);
  });

  it('packs thin candidates up to the budget cap (280K) when budget binds first', () => {
    // 100 candidates × 3400 chars = 340K total. With the 280K budget
    // and a count cap higher than 100, the budget is the binding cap.
    // 280_000 / 3_400 = 82.35 → 82 per chunk before overflow.
    const candidates = Array.from({ length: 100 }, (_, i) =>
      makeCandidate({ canonical_url: `https://example.com/${i}` }),
    );
    const chunks = packCandidatesIntoChunks(candidates, 280_000, 200);
    // First chunk is full to budget; second carries the remainder.
    expect(chunks.map((c) => c.length)).toEqual([82, 100 - 82]);
    // Total preserved.
    expect(chunks.flat()).toHaveLength(100);
  });

  it('places a single oversized candidate in its own chunk rather than dropping it', () => {
    // One candidate whose own cost exceeds the budget. The packer
    // accepts the first candidate of an empty chunk unconditionally.
    const huge = makeCandidate({ body_snippet: 'x'.repeat(500_000) });
    const chunks = packCandidatesIntoChunks([huge], 280_000, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual([huge]);
  });

  it('preserves every candidate across mixed thin and fat inputs', () => {
    const fat = (n: number): ChunkCandidate =>
      makeCandidate({
        canonical_url: `https://example.com/fat/${n}`,
        body_snippet: 'x'.repeat(15_000),
      });
    const thin = (n: number): ChunkCandidate =>
      makeCandidate({ canonical_url: `https://example.com/thin/${n}` });
    const candidates = [
      fat(0), thin(0), thin(1), fat(1), thin(2), fat(2), thin(3),
      fat(3), thin(4), thin(5), fat(4), thin(6), fat(5),
    ];
    const chunks = packCandidatesIntoChunks(candidates, 50_000, 100);
    // No chunk exceeds the budget (except a single-oversized candidate,
    // which doesn't apply here since each fat candidate is 15.4K < 50K).
    for (const chunk of chunks) {
      const total = chunk.reduce((s, c) => s + estimateCandidateChars(c), 0);
      // Either the chunk is a single candidate, or its total fits.
      if (chunk.length > 1) expect(total).toBeLessThanOrEqual(50_000);
    }
    expect(chunks.flat()).toHaveLength(candidates.length);
    // Order preserved.
    expect(chunks.flat().map((c) => c.canonical_url)).toEqual(
      candidates.map((c) => c.canonical_url),
    );
  });

  it('starts a new chunk when adding the next candidate would exceed the budget', () => {
    // Two fat candidates of 30K each + 400 overhead = 30_400 each.
    // Budget 50_000 → first fits, second would push to 60_800 > 50_000
    // so it starts a new chunk.
    const a = makeCandidate({
      canonical_url: 'https://example.com/a',
      body_snippet: 'x'.repeat(30_000),
    });
    const b = makeCandidate({
      canonical_url: 'https://example.com/b',
      body_snippet: 'x'.repeat(30_000),
    });
    const chunks = packCandidatesIntoChunks([a, b], 50_000, 100);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual([a]);
    expect(chunks[1]).toEqual([b]);
  });

  it('respects the count cap even when the budget is unbounded', () => {
    const candidates = Array.from({ length: 7 }, (_, i) =>
      makeCandidate({ canonical_url: `https://example.com/${i}` }),
    );
    const chunks = packCandidatesIntoChunks(candidates, 10_000_000, 3);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.length)).toEqual([3, 3, 1]);
  });
});
