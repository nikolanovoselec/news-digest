// Implements REQ-MAIL-001
// Implements REQ-READ-001
//
// Shared parser for the JSON-encoded hashtag array stored in
// `users.hashtags_json`. Used by both the dashboard query path
// (src/pages/api/digest/today.ts) and the email dispatcher
// (src/lib/email-dispatch.ts) — keeping the parse logic in one place
// avoids drift between the two code paths that consume the column.

/**
 * Parse the stored `hashtags_json` column into a string array. Returns
 * `[]` when the column is null, empty, or malformed. Defensive: never
 * throws on invalid JSON or non-array shapes — the dashboard / email
 * surfaces both prefer "no tags" over crashing.
 */
export function parseHashtags(hashtagsJson: string | null): string[] {
  if (hashtagsJson === null || hashtagsJson === '') return [];
  try {
    const parsed = JSON.parse(hashtagsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}
