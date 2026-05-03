// Implements REQ-MAIL-001
// Implements REQ-READ-001
//
// Shared parser for the JSON-encoded hashtag array stored in
// `users.hashtags_json`. Thin wrapper over the generic
// `parseJsonStringArray` helper — kept as its own export so calling
// sites read at the domain ("parse this user's hashtags") rather than
// at the implementation level ("parse a JSON string array").
//
// Also home of the canonical {@link normalizeHashtag} helper, which
// CF-034 consolidated from inline repetitions across settings.ts,
// scrape-chunk-consumer.ts, and the four UI/admin sites that built
// their own ad-hoc lowercase + #-strip + filter chains. New code
// MUST import from here.

import { parseJsonStringArray } from './json-string-array';

export function parseHashtags(hashtagsJson: string | null): string[] {
  return parseJsonStringArray(hashtagsJson);
}

/**
 * Canonical normaliser for a single hashtag string. Strips a leading
 * `#`, lowercases, and drops every character outside `[a-z0-9-]`.
 * The result is NOT length-checked here — callers validate with
 * {@link HASHTAG_REGEX} after collecting the full list so error
 * messages can reference the original input.
 */
export function normalizeHashtag(raw: string): string {
  const lowered = raw.toLowerCase();
  const unHashed = lowered.startsWith('#') ? lowered.slice(1) : lowered;
  return unHashed.replace(/[^a-z0-9-]/g, '');
}

/** Tag-shape contract: 2..32 chars, lowercase letters/digits/dashes. */
export const HASHTAG_REGEX = /^[a-z0-9-]{2,32}$/;
