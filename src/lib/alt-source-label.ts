// Implements REQ-READ-001 AC 7
//
// Pure formatter for the multi-source `+N` suffix the dashboard card
// renders next to the primary publisher name. Extracted from
// `src/components/DigestCard.astro` so the suffix string and the
// accessibility label are unit-testable without an Astro renderer
// in the test harness.
//
// The component imports `formatAltSourceLabel` and renders the
// returned `suffix` inline next to the source name when
// `altCount > 0`; the `ariaLabel` is set on the suffix span so
// screen readers announce a complete sentence ("plus 1 other source"
// / "plus 3 other sources") rather than the bare token "+N".

export interface AltSourceLabel {
  /** When the article has alt sources, the inline suffix to render
   *  next to the publisher name (leading space included). When it
   *  has none, the empty string. */
  suffix: string;
  /** Accessibility label for the suffix span. Empty when the suffix
   *  is empty so callers can omit the span entirely. */
  ariaLabel: string;
}

/**
 * Resolve the dashboard card's alt-source suffix and aria-label for a
 * given alt-source count. `altCount` is the number of additional
 * sources beyond the primary (so a single-source article passes 0).
 */
export function formatAltSourceLabel(altCount: number): AltSourceLabel {
  if (!Number.isFinite(altCount) || altCount <= 0) {
    return { suffix: '', ariaLabel: '' };
  }
  const noun = altCount === 1 ? 'source' : 'sources';
  return {
    suffix: ` +${altCount}`,
    ariaLabel: `plus ${altCount} other ${noun}`,
  };
}
