// Implements REQ-PIPE-003
//
// Deduplication helpers for the global-feed pipeline. Two levels of
// dedupe run per scrape tick:
//
//   1. `clusterByCanonical` — after URL canonicalisation, any two
//      candidates that share a canonical form are merged into a single
//      cluster. Primary = earliest `published_at`; others become
//      alternate sources for the same article.
//
//   2. `mergeClustersByLlmHints` — the LLM chunk-consumer may emit
//      `dedup_groups` hints when two distinct canonical URLs describe
//      the same story (e.g. a vendor blog post + a Hacker News mirror).
//      The hints are index groups into the already-clustered list; each
//      group collapses to a single cluster whose primary is the earliest
//      published_at across the merged union.
//
// Both functions are pure — they never touch D1/KV/fetch — so they're
// trivially testable and reusable from anywhere in the pipeline.

/**
 * A single article candidate that came out of a curated-source fetch.
 * `canonical_url` is the output of `canonicalize(source_url)`; callers
 * compute it once up-front so every downstream helper can assume it's
 * already in canonical form.
 */
export interface Candidate {
  canonical_url: string;
  source_url: string;
  source_name: string;
  title: string;
  /** Unix seconds. Used as the tiebreaker when two candidates canonicalise
   * to the same URL — earliest wins so the first-published source
   * becomes the authoritative primary. */
  published_at: number;
  /** Optional body excerpt used downstream by the LLM prompt. Never
   * relied on for dedupe. */
  body_snippet?: string;
}

/**
 * A group of candidates that all describe the same article. `primary`
 * is the authoritative record (earliest-published wins); `alternatives`
 * are the other rows that will land in `article_sources` so the UI can
 * render an alt-source modal.
 */
export interface Cluster {
  primary: Candidate;
  alternatives: Candidate[];
}

/**
 * Group {@link candidates} by their `canonical_url`. Within each group
 * the earliest `published_at` is the `primary`; everything else lands in
 * `alternatives` in their original input order.
 *
 * Input order is otherwise preserved: the returned clusters come out
 * sorted by the first-appearance index of their canonical URL. Stable
 * ordering matters because the LLM chunking downstream is index-based.
 */
export function clusterByCanonical(candidates: Candidate[]): Cluster[] {
  // Use a Map keyed by canonical_url so insertion order == first-seen order.
  const buckets = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const existing = buckets.get(candidate.canonical_url);
    if (existing === undefined) {
      buckets.set(candidate.canonical_url, [candidate]);
    } else {
      existing.push(candidate);
    }
  }

  const clusters: Cluster[] = [];
  for (const bucket of buckets.values()) {
    const primary = pickEarliest(bucket);
    const alternatives = bucket.filter((c) => c !== primary);
    clusters.push({ primary, alternatives });
  }
  return clusters;
}

/**
 * Collapse clusters according to LLM-provided dedup_groups hints. Each
 * group is an array of indices into {@link clusters}; every cluster
 * mentioned in a group merges into a single output cluster. Clusters
 * whose index is not mentioned in any group are preserved as-is.
 *
 * Output ordering follows input order: each output cluster is positioned
 * at the minimum index of the source clusters it came from. Groups with
 * fewer than 2 valid indices collapse to a single-cluster no-op.
 *
 * Invalid indices (out of range, negative, non-integer) are silently
 * dropped — the LLM is untrusted and `parseLLMPayload` already shape-checks,
 * but belt-and-suspenders keeps this helper resilient to malformed hints.
 */
export function mergeClustersByLlmHints(
  clusters: Cluster[],
  dedupGroups: number[][],
): Cluster[] {
  // Canonicalise the hint list: strip invalid indices, dedupe within a
  // group, drop empty groups. Track every index that belongs to a
  // non-singleton group so the second pass knows which clusters to omit
  // from the pass-through output.
  const cleanedGroups: number[][] = [];
  const mergedIndices = new Set<number>();
  for (const group of dedupGroups) {
    const unique = new Set<number>();
    for (const idx of group) {
      if (!Number.isInteger(idx)) continue;
      if (idx < 0 || idx >= clusters.length) continue;
      unique.add(idx);
    }
    if (unique.size < 2) continue; // a single-element group is a no-op
    const sorted = Array.from(unique).sort((a, b) => a - b);
    cleanedGroups.push(sorted);
    for (const idx of sorted) {
      mergedIndices.add(idx);
    }
  }

  // Build one merged cluster per group. The anchor index is the minimum
  // of the group so the merged cluster slots back into the output at
  // that position, preserving stable ordering.
  interface Insertion {
    anchor: number;
    cluster: Cluster;
  }
  const insertions: Insertion[] = [];
  for (const group of cleanedGroups) {
    const groupClusters = group.map((idx) => clusters[idx]).filter(isDefined);
    if (groupClusters.length === 0) continue;
    const merged = mergeClusters(groupClusters);
    const anchor = group[0] ?? 0;
    insertions.push({ anchor, cluster: merged });
  }

  // Emit in-order: at each original position emit either (a) the merged
  // cluster anchored here, (b) the original cluster if it wasn't merged,
  // or (c) nothing (it was merged into a group whose anchor is earlier).
  const insertByAnchor = new Map<number, Cluster>();
  for (const insertion of insertions) {
    insertByAnchor.set(insertion.anchor, insertion.cluster);
  }

  const out: Cluster[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const merged = insertByAnchor.get(i);
    if (merged !== undefined) {
      out.push(merged);
      continue;
    }
    if (mergedIndices.has(i)) continue; // merged into a group anchored earlier
    const original = clusters[i];
    if (original !== undefined) {
      out.push(original);
    }
  }
  return out;
}

// ---------- internal helpers ---------------------------------------------

function pickEarliest(candidates: Candidate[]): Candidate {
  // Non-empty by construction — caller only builds buckets from real rows.
  let best = candidates[0] as Candidate;
  for (let i = 1; i < candidates.length; i++) {
    const current = candidates[i] as Candidate;
    if (current.published_at < best.published_at) {
      best = current;
    }
  }
  return best;
}

function mergeClusters(clusters: Cluster[]): Cluster {
  // Flatten every candidate (primary + alternatives) across the merged
  // clusters, then re-pick the global earliest as the merged primary.
  const allCandidates: Candidate[] = [];
  for (const cluster of clusters) {
    allCandidates.push(cluster.primary);
    for (const alt of cluster.alternatives) {
      allCandidates.push(alt);
    }
  }
  const primary = pickEarliest(allCandidates);
  const alternatives = allCandidates.filter((c) => c !== primary);
  return { primary, alternatives };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
