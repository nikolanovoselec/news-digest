// Infrastructure utility — no REQ.
//
// CF-054: single helper that converts an unknown catch-clause value to a
// truncated string safe for logging. Replaces the ~30 inline
// `String(err).slice(0, 500)` call sites scattered across queue
// consumers, middleware, and API routes.
//
// Why a helper:
//   - The truncation length is a site-specific detail (`slice(0, 200)`
//     in some places, `slice(0, 500)` in others). Centralising with a
//     default of 500 (and an optional override) lets callers opt down
//     on inner-loop paths where log volume matters more.
//   - TypeScript `catch` clauses type `err` as `unknown`; `String()`
//     is the safe coercion. One helper eliminates the cognitive overhead
//     of repeating that reasoning at every error site.
//   - A future change (e.g. extracting `.message` from Error instances)
//     touches exactly one place.

/**
 * Convert an unknown catch-clause error to a truncated string for
 * structured logging. Never throws.
 *
 * @param err  The raw caught value — may be any type.
 * @param max  Maximum character length of the returned string (default 500).
 * @returns    `String(err).slice(0, max)`.
 */
export function errMsg(err: unknown, max = 500): string {
  return String(err).slice(0, max);
}
