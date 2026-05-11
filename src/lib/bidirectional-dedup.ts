// Implements REQ-PIPE-003
// Implements REQ-PIPE-009
//
// Shared per-match classifier used by both the per-tick finalize
// consumer (`src/queue/scrape-finalize-consumer.ts`) and the
// historical sweep (`src/lib/historical-dedup.ts`). Pre-extraction,
// each call site reimplemented the same scoring/banding logic with
// drift between them (CF-002): same-vendor penalty, high-confidence
// band, time-window gate, equal-time tie-break, direction flag —
// all encoded twice with subtle wording differences. The shared
// classifier resolves the drift by routing both call sites through
// one expression.
//
// The classifier is per-match only. It does NOT pick a winner —
// each call site has its own outer control flow (finalize picks one
// chosen pair per article + reranks borderline candidates capped at
// RERANK_CANDIDATE_CAP; historical-dedup runs PASS 1 + PASS 2 with
// no rerank cap because the queue consumer has a 15-min budget per
// message). The decision shape (best-auto, borderline candidate
// list, decision label) stays at the call site.

import { sameVendor } from '~/lib/etld';

export interface ClassifierParams {
  threshold: number;
  sameVendorPenalty: number;
  rerankFloor: number;
  timeWindowSeconds: number;
  highConfidenceCosine: number;
}

export interface SelfArticle {
  id: string;
  published_at: number;
  primary_source_url: string;
}

export interface MatchInput {
  id: string;
  score: number;
  /** Matches `VectorizeMatch.metadata` shape — optional record. */
  metadata?: Record<string, unknown> | undefined;
}

export type ClassifyOutcome =
  /** Match published_at missing — Vectorize metadata corrupt or pre-AD40 vector. */
  | { kind: 'no_metadata' }
  /** Pair separated by more than the configured time window — skipped regardless of cosine. */
  | { kind: 'out_of_window'; matchPublishedAt: number; deltaSeconds: number }
  /** Eligible candidate with full scoring derived. The call site decides what to do with it. */
  | {
      kind: 'eligible';
      matchPublishedAt: number;
      deltaSeconds: number;
      adjustedScore: number;
      isHighConfidence: boolean;
      /** True iff `(highConfidence) || (adjustedScore >= threshold)` — clears the auto-merge gate. */
      isAutoMerge: boolean;
      /** True iff `!isAutoMerge && adjustedScore >= rerankFloor` — needs the LLM rerank to decide. */
      isBorderline: boolean;
      /** Direction flag. true ⇒ self is older (equal-time tie-broken by lower ULID). */
      selfIsOlder: boolean;
      /** Same registrable domain (`eTLD+1`) — true when both URLs share a vendor. */
      sameEtld1: boolean;
    };

/** Classify one (self, match) pair under the supplied dedup params.
 *  Both finalize and historical sweep call this for every candidate
 *  returned by Vectorize.queryById. */
export function classifyMatchPair(
  self: SelfArticle,
  match: MatchInput,
  params: ClassifierParams,
): ClassifyOutcome {
  const meta = match.metadata;
  const matchPublishedAt =
    typeof meta?.['published_at'] === 'number'
      ? (meta['published_at'] as number)
      : null;
  if (matchPublishedAt === null) return { kind: 'no_metadata' };

  const deltaSeconds = Math.abs(self.published_at - matchPublishedAt);
  if (deltaSeconds > params.timeWindowSeconds) {
    return { kind: 'out_of_window', matchPublishedAt, deltaSeconds };
  }

  const isHighConfidence = match.score >= params.highConfidenceCosine;
  const matchUrl =
    typeof meta?.['primary_source_url'] === 'string'
      ? (meta['primary_source_url'] as string)
      : '';
  const sameEtld1 =
    matchUrl !== '' && sameVendor(self.primary_source_url, matchUrl);
  const adjustedScore =
    sameEtld1 && !isHighConfidence
      ? match.score - params.sameVendorPenalty
      : match.score;

  const isAutoMerge = isHighConfidence || adjustedScore >= params.threshold;
  const isBorderline = !isAutoMerge && adjustedScore >= params.rerankFloor;

  // Equal-time tie-break: lower ULID = older (deterministic across
  // both consumers so the chosen winner is consistent regardless of
  // which path observed the pair first).
  const selfIsOlder =
    self.published_at < matchPublishedAt ||
    (self.published_at === matchPublishedAt && self.id < match.id);

  return {
    kind: 'eligible',
    matchPublishedAt,
    deltaSeconds,
    adjustedScore,
    isHighConfidence,
    isAutoMerge,
    isBorderline,
    selfIsOlder,
    sameEtld1,
  };
}
