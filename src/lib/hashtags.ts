// Implements REQ-MAIL-001
// Implements REQ-READ-001
//
// Shared parser for the JSON-encoded hashtag array stored in
// `users.hashtags_json`. Thin wrapper over the generic
// `parseJsonStringArray` helper — kept as its own export so calling
// sites read at the domain ("parse this user's hashtags") rather than
// at the implementation level ("parse a JSON string array").

import { parseJsonStringArray } from './json-string-array';

export function parseHashtags(hashtagsJson: string | null): string[] {
  return parseJsonStringArray(hashtagsJson);
}
