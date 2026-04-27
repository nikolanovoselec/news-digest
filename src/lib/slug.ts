// Implements REQ-READ-001
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

/** Remove leading and trailing hyphens. */
function stripHyphens(s: string): string {
  return s.replace(/^-+|-+$/g, '');
}
