// Implements REQ-PIPE-002
//
// Helper to spread an optional property into an object literal while
// honoring `exactOptionalPropertyTypes`. Replaces the verbose
// `...(value !== null ? { key: value } : {})` idiom — see CF-053.

/**
 * Returns `{ [key]: value }` when `value` is non-null and non-undefined,
 * otherwise returns `{}`. Use as a spread inside an object literal:
 *
 * ```ts
 * out.push({
 *   title,
 *   url,
 *   ...definedProp('snippet', snippet),
 *   ...definedProp('published_at', publishedAt),
 * });
 * ```
 *
 * The result type is `{ [P in K]?: V }` so the consumer's exact-optional
 * field type (`field?: V`) is satisfied — the property is either absent
 * entirely (preserving the optional shape) or present with a non-nullish
 * value. This is the correct shape for D1/JSON serialization where
 * an explicit `field: null` would be semantically different from
 * "field omitted".
 */
export function definedProp<K extends string, V>(
  key: K,
  value: V | null | undefined,
): { [P in K]?: V } {
  if (value === null || value === undefined) return {};
  return { [key]: value } as { [P in K]: V };
}
