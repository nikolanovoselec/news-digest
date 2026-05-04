// Implements REQ-PIPE-001
// Implements REQ-PIPE-003
//
// Google News emits aggregator-wrapper URLs (https://news.google.com/articles/CCAi…)
// that canonicalize to a different form than the underlying publisher
// or community link, so the canonical-URL dedup pass in fanOutForTags
// treats the Google News copy and the direct copy of the same story
// as separate articles. The user's reported symptom: one trending
// story appearing 4× on /digest, ingested at slightly different times
// from "Google News — X" wrappers and the original direct source.
//
// The user's heuristic: "Google News should only be accepted as a
// source if no other direct source is available." This module
// implements that as a post-canonical-dedup pass:
//
//   1. Detect Google News headlines by URL host (works for both the
//      hardcoded GENERIC_SOURCES.googlenews adapter and the curated
//      `google-news-*` feeds whose URLs all live under news.google.com).
//   2. For each Google News headline, scan the remaining headlines for
//      a non-Google headline that shares ≥3 meaningful tokens with the
//      Google News title.
//   3. If a match is found, drop the Google News headline and merge its
//      `source_tags` into the surviving direct headline so the user's
//      tag-of-discovery is preserved.
//
// The token threshold is ≥3 (not ≥1 like `titlesShareAnyToken` in
// title-overlap.ts, and not ≥2 as in the first cut of this module):
// we are acting on the signal to DROP an article, so high precision
// matters more than recall. ≥2 was over-aggressive — two unrelated
// stories that share generic tokens like ("synthetic", "data") could
// collapse into one. ≥3 keeps the user's reported case ("Anthropic
// releases Claude Sonnet 4.6" mirrored across HN + Google News
// shares 5+ tokens) safely above the threshold while pushing
// false-positive collisions below it.
//
// When no direct duplicate exists for a Google News headline, it is
// kept — the heuristic is "prefer direct if available", not "delete
// Google News".

import type { Headline } from '~/lib/types';
import { tokenizeTitle } from '~/lib/title-overlap';

/** Match Google News URLs regardless of which feed they came from
 *  (hardcoded adapter vs curated wrapper).
 *
 *  Exported for unit testing. Production code should reach this via
 *  {@link preferDirectOverGoogleNews}. */
export function isGoogleNewsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'news.google.com';
  } catch {
    return false;
  }
}

/** Count of tokens shared between two titles (lowercase, length ≥ 4,
 *  stopwords excluded — same canonical tokenisation used elsewhere). */
function sharedTokenCount(a: string, b: string): number {
  const tokensA = tokenizeTitle(a);
  const tokensB = tokenizeTitle(b);
  let count = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) count += 1;
  }
  return count;
}

/** Minimum shared-token count required to treat a Google News
 *  headline as a duplicate of a direct headline. See module header
 *  for the rationale on the threshold (precision over recall). */
const DROP_THRESHOLD = 3;

/** Drop Google News headlines whose title shares ≥{@link DROP_THRESHOLD}
 *  meaningful tokens with a non-Google-News headline already in the
 *  list. Surviving direct headlines absorb the dropped Google News
 *  entry's `source_tags` so multi-tag discovery state is preserved.
 *
 *  Input order is preserved for the survivors. The function is pure;
 *  it returns a new array and does not mutate inputs (immutability
 *  rule across the pipeline).
 */
export function preferDirectOverGoogleNews(
  headlines: readonly Headline[],
): Headline[] {
  // Track index-keyed absorbed-tag updates without mutating the cloned
  // direct headlines in place — keep the rebuild-don't-mutate
  // discipline consistent with the rest of the pipeline.
  const absorbedTagsByDirectIdx = new Map<number, Set<string>>();
  const droppedGoogleIdxs = new Set<number>();

  // Partition once so the inner loop only walks direct headlines.
  type Indexed = { h: Headline; idx: number };
  const direct: Indexed[] = [];
  const google: Indexed[] = [];
  headlines.forEach((h, idx) => {
    if (isGoogleNewsUrl(h.url)) google.push({ h, idx });
    else direct.push({ h, idx });
  });

  if (google.length === 0) return [...headlines];

  for (const g of google) {
    for (const d of direct) {
      if (sharedTokenCount(g.h.title, d.h.title) >= DROP_THRESHOLD) {
        const existing =
          absorbedTagsByDirectIdx.get(d.idx) ??
          new Set<string>(d.h.source_tags ?? []);
        for (const t of g.h.source_tags ?? []) existing.add(t);
        absorbedTagsByDirectIdx.set(d.idx, existing);
        droppedGoogleIdxs.add(g.idx);
        break;
      }
    }
  }

  // Reassemble in the original input order so downstream truncation
  // (MAX_COMBINED_HEADLINES cap) stays deterministic.
  const out: Headline[] = [];
  headlines.forEach((h, idx) => {
    if (droppedGoogleIdxs.has(idx)) return;
    const absorbed = absorbedTagsByDirectIdx.get(idx);
    if (absorbed !== undefined) {
      out.push({ ...h, source_tags: Array.from(absorbed) });
    } else {
      out.push(h);
    }
  });
  return out;
}
