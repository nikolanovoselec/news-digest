// Implements REQ-GEN-006
// Slug utilities — deterministic title -> URL-safe slug, plus collision suffixing.
// Pure string manipulation, no dependencies, Workers runtime compatible.

const MAX_SLUG_LENGTH = 60;

/**
 * Convert a title into a URL-safe slug.
 *
 * Rules:
 * - Lowercase the input.
 * - Collapse any run of non-`[a-z0-9]` characters into a single hyphen.
 * - Trim leading and trailing hyphens.
 * - Truncate to {@link MAX_SLUG_LENGTH} characters, then re-trim trailing
 *   hyphens exposed by truncation.
 *
 * Non-ASCII characters (accents, emoji, CJK) collapse to hyphens — the
 * project's REQ target is ASCII-clean slugs.
 */
export function slugify(title: string): string {
  const lowered = title.toLowerCase();
  const hyphenated = lowered.replace(/[^a-z0-9]+/g, '-');
  const trimmed = stripHyphens(hyphenated);
  if (trimmed.length <= MAX_SLUG_LENGTH) {
    return trimmed;
  }
  // Truncation may expose a trailing hyphen — strip it again.
  return stripHyphens(trimmed.slice(0, MAX_SLUG_LENGTH));
}

/**
 * Ensure {@link slug} does not collide with any value in {@link existing}.
 * When a collision is detected, append `-2`, `-3`, ... until a free slot
 * is found. The input array is not mutated.
 */
export function deduplicateSlug(slug: string, existing: string[]): string {
  const taken = new Set(existing);
  if (!taken.has(slug)) {
    return slug;
  }
  let suffix = 2;
  while (taken.has(`${slug}-${suffix}`)) {
    suffix++;
  }
  return `${slug}-${suffix}`;
}

/** Remove leading and trailing hyphens. */
function stripHyphens(s: string): string {
  return s.replace(/^-+|-+$/g, '');
}
