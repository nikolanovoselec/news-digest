// Implements REQ-DISC-004
// Implements CF-013
//
// Zod schema for the POST /api/admin/discovery/retry JSON body
// (form-encoded path is unaffected - it reads `request.formData()`
// directly). Replaces `as RetryBody`.
//
// `tag` stays `unknown` because the downstream coercion is
// `typeof rawTag === 'string' ? rawTag.trim() : ''` followed by a
// non-empty check; keeping the schema permissive here preserves the
// exact `bad_request` vs `unknown_tag` distinction the route emits.
//
// `.strict()` rejects extra fields.

import { z } from 'zod';

export const DiscoveryRetryBodySchema = z
  .object({
    tag: z.unknown().optional(),
  })
  .strict();

type DiscoveryRetryBody = z.infer<typeof DiscoveryRetryBodySchema>;
