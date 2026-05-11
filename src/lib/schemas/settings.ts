// Implements CF-013
//
// Zod schema for the PUT /api/settings JSON body. Replaces the
// previous `as PutSettingsBody` cast so the runtime body is actually
// validated against a declared shape before the route reads it.
//
// Design notes:
//
// All fields stay `unknown` here because the route emits distinct
// per-field error codes (`invalid_hashtags`, `invalid_time`,
// `invalid_tz`, `invalid_model_id`, `invalid_email_enabled`) via its
// existing `validateHashtags`, `isIntegerInRange`, `isValidTz`, and
// `MODELS` catalog checks. Encoding type-narrowing in Zod here would
// collapse those distinct codes into a single `invalid_body`, relaxing
// the contract observable through the API.
//
// The CF-013 security benefit of this change is twofold:
//   1. The body is parsed through `safeParse`, so a non-object body
//      (array, scalar, null) is rejected before the route reads it.
//   2. `.strict()` rejects unknown extra fields - the previous `as`
//      cast silently accepted arbitrary payloads.

import { z } from 'zod';

export const SettingsPutBodySchema = z
  .object({
    hashtags: z.unknown().optional(),
    digest_hour: z.unknown().optional(),
    digest_minute: z.unknown().optional(),
    tz: z.unknown().optional(),
    model_id: z.unknown().optional(),
    email_enabled: z.unknown().optional(),
  })
  .strict();

export type SettingsPutBody = z.infer<typeof SettingsPutBodySchema>;
