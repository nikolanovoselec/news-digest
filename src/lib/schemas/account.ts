// Implements CF-013
//
// Zod schema for the DELETE /api/auth/account JSON body. Replaces
// `as DeleteAccountBody`. The downstream check is the literal
// equality `confirm === 'DELETE'`; declaring `confirm` as `unknown`
// here preserves that contract exactly (the route returns the
// distinct `confirmation_required` error code when the value is
// present-but-wrong, which a stricter `z.literal('DELETE')` here
// would replace with a generic `invalid_body`).
//
// `.strict()` rejects extra fields - the security benefit of CF-013.

import { z } from 'zod';

export const AccountDeleteBodySchema = z
  .object({
    confirm: z.unknown().optional(),
  })
  .strict();

export type AccountDeleteBody = z.infer<typeof AccountDeleteBodySchema>;
