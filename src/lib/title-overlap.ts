// Implements REQ-PIPE-002
//
// Token-overlap check used as a defense-in-depth signal during chunk
// processing. The chunk-consumer pipeline matches LLM-summarised
// articles back to the input candidate list by echoed index; the
// overlap check guards against the LLM echoing a correct index but
// describing a different candidate's story. CF-058 extracted this
// helper from `scrape-chunk-consumer.ts` so the pure-string logic
// can be tested in isolation.
//
// Conservative by design: when either side has fewer than 2 tokens
// the signal is too noisy and we accept rather than drop — the cost
// of a false-reject (lost article) is higher than a false-accept
// (one mismatched story sneaking through). The chunk consumer carries
// other guards (canonical-URL match, source name match) that catch
// the misalignment in the next round of dedup.

const TITLE_STOPWORDS = new Set([
  'the', 'that', 'this', 'with', 'from', 'into', 'over', 'your', 'their',
  'have', 'will', 'been', 'were', 'what', 'when', 'about', 'after',
  'announce', 'announces', 'announced', 'release', 'released', 'launches',
  'launch', 'update', 'updates', 'updated', 'says', 'said', 'introduces',
  'introduced', 'adds', 'added', 'gets', 'gains', 'makes', 'made',
  'using', 'uses', 'based', 'new', 'via', 'now', 'for', 'and',
]);

/** Extract meaningful tokens from a title for the overlap check:
 *  lowercase, alnum only, length ≥ 4, not in the small stopword list. */
export function tokenizeTitle(title: string): Set<string> {
  const out = new Set<string>();
  const lowered = title.toLowerCase();
  const words = lowered.split(/[^a-z0-9]+/);
  for (const w of words) {
    if (w.length < 4) continue;
    if (TITLE_STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

/** True when {@link a} and {@link b} share at least one non-trivial
 *  token (alnum, length ≥ 4, case-insensitive, stopwords excluded).
 *  Trivially true when either title produces fewer than 2 meaningful
 *  tokens — short titles can't generate a reliable overlap signal. */
export function titlesShareAnyToken(a: string, b: string): boolean {
  const tokensA = tokenizeTitle(a);
  const tokensB = tokenizeTitle(b);
  if (tokensA.size < 2 || tokensB.size < 2) return true;
  for (const t of tokensA) {
    if (tokensB.has(t)) return true;
  }
  return false;
}
