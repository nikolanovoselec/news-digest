// Tests for src/lib/dedupe.ts — REQ-PIPE-003.
//
// Two-level dedupe: canonical-URL clustering first, then LLM-hinted
// cluster merging. Both functions are pure, so these tests are simple
// input/output assertions.

import { describe, it, expect } from 'vitest';
import {
  clusterByCanonical,
  mergeClustersByLlmHints,
  normaliseRawDedupGroups,
  type Candidate,
  type Cluster,
} from '~/lib/dedupe';

function mkCandidate(overrides: Partial<Candidate> & Pick<Candidate, 'canonical_url' | 'published_at'>): Candidate {
  return {
    source_url: overrides.source_url ?? overrides.canonical_url,
    source_name: overrides.source_name ?? 'test-source',
    title: overrides.title ?? 'Test Title',
    canonical_url: overrides.canonical_url,
    published_at: overrides.published_at,
    ...(overrides.body_snippet !== undefined ? { body_snippet: overrides.body_snippet } : {}),
  };
}

describe('dedupe — REQ-PIPE-003', () => {
  describe('clusterByCanonical', () => {
    it('REQ-PIPE-003: clusterByCanonical groups candidates sharing a canonical URL', () => {
      const a = mkCandidate({
        canonical_url: 'https://example.com/a',
        published_at: 100,
        source_name: 'blog',
      });
      const b = mkCandidate({
        canonical_url: 'https://example.com/a',
        published_at: 200,
        source_name: 'hn',
      });
      const c = mkCandidate({
        canonical_url: 'https://example.com/b',
        published_at: 150,
        source_name: 'reddit',
      });

      const clusters = clusterByCanonical([a, b, c]);

      expect(clusters).toHaveLength(2);
      const first = clusters[0] as Cluster;
      expect(first.primary.canonical_url).toBe('https://example.com/a');
      expect(first.alternatives).toHaveLength(1);
      expect(first.alternatives[0]?.source_name).toBe('hn');

      const second = clusters[1] as Cluster;
      expect(second.primary.canonical_url).toBe('https://example.com/b');
      expect(second.alternatives).toHaveLength(0);
    });

    it('REQ-PIPE-003: clusterByCanonical picks the earliest-published-at as primary', () => {
      const later = mkCandidate({
        canonical_url: 'https://example.com/story',
        published_at: 500,
        source_name: 'late',
      });
      const earlier = mkCandidate({
        canonical_url: 'https://example.com/story',
        published_at: 100,
        source_name: 'early',
      });
      const middle = mkCandidate({
        canonical_url: 'https://example.com/story',
        published_at: 300,
        source_name: 'mid',
      });

      // Input order deliberately NOT sorted by time — primary selection
      // must be independent of arrival order.
      const clusters = clusterByCanonical([later, middle, earlier]);

      expect(clusters).toHaveLength(1);
      const cluster = clusters[0] as Cluster;
      expect(cluster.primary.source_name).toBe('early');
      expect(cluster.primary.published_at).toBe(100);
      expect(cluster.alternatives).toHaveLength(2);
      // alternatives retain the two non-primary candidates
      const altNames = cluster.alternatives.map((c) => c.source_name).sort();
      expect(altNames).toEqual(['late', 'mid']);
    });

    it('REQ-PIPE-003: clusterByCanonical leaves singleton clusters with empty alternatives', () => {
      const solo = mkCandidate({
        canonical_url: 'https://solo.example/one',
        published_at: 42,
      });
      const clusters = clusterByCanonical([solo]);
      expect(clusters).toHaveLength(1);
      const cluster = clusters[0] as Cluster;
      expect(cluster.primary).toBe(solo);
      expect(cluster.alternatives).toEqual([]);
    });

    it('REQ-PIPE-003: clusterByCanonical preserves first-seen order across clusters', () => {
      const c1 = mkCandidate({ canonical_url: 'https://a.example/x', published_at: 1 });
      const c2 = mkCandidate({ canonical_url: 'https://b.example/x', published_at: 1 });
      const c3 = mkCandidate({ canonical_url: 'https://a.example/x', published_at: 2 });
      const c4 = mkCandidate({ canonical_url: 'https://c.example/x', published_at: 1 });

      const clusters = clusterByCanonical([c1, c2, c3, c4]);
      const urls = clusters.map((c) => c.primary.canonical_url);
      expect(urls).toEqual([
        'https://a.example/x',
        'https://b.example/x',
        'https://c.example/x',
      ]);
    });

    it('REQ-PIPE-003: clusterByCanonical returns empty output on empty input', () => {
      expect(clusterByCanonical([])).toEqual([]);
    });
  });

  describe('mergeClustersByLlmHints', () => {
    function clusterOf(canonical: string, publishedAt: number, name = 'src'): Cluster {
      return {
        primary: mkCandidate({
          canonical_url: canonical,
          published_at: publishedAt,
          source_name: name,
        }),
        alternatives: [],
      };
    }

    it('REQ-PIPE-003: mergeClustersByLlmHints merges clusters by index group and keeps others intact', () => {
      // Four clusters [0, 1, 2, 3]; merge group [0, 2] — output should
      // have the merged cluster at index 0, cluster 1 at index 1, and
      // cluster 3 at index 2 (cluster 2 is consumed into the merge).
      const c0 = clusterOf('https://example.com/a', 100, 'a');
      const c1 = clusterOf('https://example.com/b', 150, 'b');
      const c2 = clusterOf('https://example.com/c', 200, 'c');
      const c3 = clusterOf('https://example.com/d', 250, 'd');

      const merged = mergeClustersByLlmHints([c0, c1, c2, c3], [[0, 2]]);

      expect(merged).toHaveLength(3);
      // index 0: merged cluster (earliest published_at wins for primary)
      expect(merged[0]?.primary.source_name).toBe('a');
      expect(merged[0]?.alternatives).toHaveLength(1);
      expect(merged[0]?.alternatives[0]?.source_name).toBe('c');
      // index 1: c1 untouched
      expect(merged[1]).toBe(c1);
      // index 2: c3 (formerly index 3) untouched, just shifted
      expect(merged[2]).toBe(c3);
    });

    it('REQ-PIPE-003: mergeClustersByLlmHints picks global earliest as primary across merged union', () => {
      // Each cluster already has alternatives — the merge must look at
      // every candidate (primary + alternatives) across all clusters,
      // not just the cluster primaries, to pick the global earliest.
      const c0: Cluster = {
        primary: mkCandidate({ canonical_url: 'https://a/', published_at: 500, source_name: 'a-primary' }),
        alternatives: [
          mkCandidate({ canonical_url: 'https://a/', published_at: 50, source_name: 'a-alt-earliest' }),
        ],
      };
      const c1: Cluster = {
        primary: mkCandidate({ canonical_url: 'https://b/', published_at: 100, source_name: 'b-primary' }),
        alternatives: [
          mkCandidate({ canonical_url: 'https://b/', published_at: 600, source_name: 'b-alt' }),
        ],
      };

      const merged = mergeClustersByLlmHints([c0, c1], [[0, 1]]);

      expect(merged).toHaveLength(1);
      // Earliest across every candidate is a-alt-earliest@50
      expect(merged[0]?.primary.source_name).toBe('a-alt-earliest');
      expect(merged[0]?.primary.published_at).toBe(50);
      expect(merged[0]?.alternatives).toHaveLength(3);
    });

    it('REQ-PIPE-003: mergeClustersByLlmHints passes through when no hints provided', () => {
      const c0 = clusterOf('https://a/', 1);
      const c1 = clusterOf('https://b/', 2);
      const merged = mergeClustersByLlmHints([c0, c1], []);
      expect(merged).toEqual([c0, c1]);
    });

    it('REQ-PIPE-003: mergeClustersByLlmHints ignores singleton groups', () => {
      const c0 = clusterOf('https://a/', 1);
      const c1 = clusterOf('https://b/', 2);
      // `[0]` alone is not a merge, it's a no-op.
      const merged = mergeClustersByLlmHints([c0, c1], [[0]]);
      expect(merged).toEqual([c0, c1]);
    });

    it('REQ-PIPE-003: mergeClustersByLlmHints silently drops out-of-range indices', () => {
      const c0 = clusterOf('https://a/', 1);
      const c1 = clusterOf('https://b/', 2);
      // Group [0, 99] has one valid index; falls back to singleton no-op.
      const merged = mergeClustersByLlmHints([c0, c1], [[0, 99]]);
      expect(merged).toEqual([c0, c1]);
    });

    it('REQ-PIPE-003: mergeClustersByLlmHints handles multiple disjoint groups', () => {
      const c0 = clusterOf('https://a/', 10, 'a');
      const c1 = clusterOf('https://b/', 20, 'b');
      const c2 = clusterOf('https://c/', 30, 'c');
      const c3 = clusterOf('https://d/', 40, 'd');

      // Merge {0,1} and {2,3} — two merged clusters in output.
      const merged = mergeClustersByLlmHints([c0, c1, c2, c3], [
        [0, 1],
        [2, 3],
      ]);

      expect(merged).toHaveLength(2);
      expect(merged[0]?.primary.source_name).toBe('a');
      expect(merged[0]?.alternatives.map((c) => c.source_name)).toEqual(['b']);
      expect(merged[1]?.primary.source_name).toBe('c');
      expect(merged[1]?.alternatives.map((c) => c.source_name)).toEqual(['d']);
    });
  });

  describe('normaliseRawDedupGroups — REQ-PIPE-003', () => {
    it('REQ-PIPE-003: dedupes repeated indices within a group via Set', () => {
      // CF-005 — an LLM emitting [0, 1, 1] would otherwise inflate
      // `losers_deleted` and queue redundant merge SQL for the
      // duplicated index. The chunk consumer's previous private copy
      // was missing this set-uniquing.
      const out = normaliseRawDedupGroups([[0, 1, 1]]);
      expect(out).toHaveLength(1);
      const indices = (out[0] ?? []).slice().sort((a, b) => a - b);
      expect(indices).toEqual([0, 1]);
    });

    it('REQ-PIPE-003: drops groups whose unique-index size falls below 2', () => {
      // [0, 0] reduces to {0} which can't be a merge group; must be
      // dropped silently.
      const out = normaliseRawDedupGroups([[0, 0], [3, 3, 3]]);
      expect(out).toEqual([]);
    });

    it('REQ-PIPE-003: drops non-array groups, non-integer entries, negative indices', () => {
      const out = normaliseRawDedupGroups([
        'not-an-array',
        [1, 2, 3],
        [4, '5', 6],
        [-1, 7, 8],
        [9, null, 10],
      ]);
      // First group survives intact (1,2,3).
      // Second group filters '5' (string) → {4, 6} → kept (size 2).
      // Third group filters -1 → {7, 8} → kept.
      // Fourth group filters null → {9, 10} → kept.
      expect(out).toHaveLength(4);
      expect(out[0]).toEqual([1, 2, 3]);
      expect((out[1] ?? []).slice().sort()).toEqual([4, 6]);
      expect((out[2] ?? []).slice().sort()).toEqual([7, 8]);
      expect((out[3] ?? []).slice().sort()).toEqual([10, 9]);
    });

    it('REQ-PIPE-003: returns [] for non-array input (LLM returned wrong shape)', () => {
      expect(normaliseRawDedupGroups(undefined)).toEqual([]);
      expect(normaliseRawDedupGroups(null)).toEqual([]);
      expect(normaliseRawDedupGroups({ feeds: [] })).toEqual([]);
      expect(normaliseRawDedupGroups('a string')).toEqual([]);
    });
  });
});
