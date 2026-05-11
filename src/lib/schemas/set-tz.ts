// Implements REQ-SET-007
// Implements REQ-AUTH-003
// Implements CF-013
//
// Zod schema for the POST /api/auth/set-tz JSON body. Replaces
// `as SetTzBody`.
//
// `tz` stays `unknown` because the route emits a single `invalid_tz`
// error code that covers "not a string", "empty string", and "not a
// valid IANA zone" via the existing `isValidTz` check. Tightening
// the field type in Zod would split that into a generic `bad_request`
// for the first two cases, relaxing the public error contract.
//
// `.strict()` rejects unknown extra fields - the CF-013 security
// benefit. The body parse via `safeParse` also rejects non-object
// payloads (array, scalar, null) that the previous `as` cast accepted.

import { z } from 'zod';

export const SetTzBodySchema = z
  .object({
    tz: z.unknown().optional(),
  })
  .strict();

type SetTzBody = z.infer<typeof SetTzBodySchema>;
