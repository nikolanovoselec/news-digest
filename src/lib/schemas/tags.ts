// Implements REQ-SET-002
// Implements CF-013
//
// Zod schema for the POST /api/tags JSON body. Replaces `as TagsBody`.
//
// `tags` stays `unknown` because the downstream validator
// (`validateHashtags` in src/pages/api/settings.ts) does deep,
// domain-specific checks (per-element regex, dedupe, MAX_HASHTAGS
// ceiling). Encoding that in Zod would duplicate the validator;
// keeping it as `unknown` preserves exact existing behavior, including
// the `invalid_hashtags` error code the route emits.
//
// `.strict()` rejects extra fields - the security benefit of CF-013.

import { z } from 'zod';

export const TagsPostBodySchema = z
  .object({
    tags: z.unknown().optional(),
  })
  .strict();

export type TagsPostBody = z.infer<typeof TagsPostBodySchema>;
