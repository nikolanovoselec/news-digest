// Implements REQ-AUTH-001
// Implements REQ-AUTH-002
//
// CF-028: shared auth-domain row types that were previously duplicated
// between the OAuth callback handler (src/pages/api/auth/[provider]/
// callback.ts) and the auth middleware (src/middleware/auth.ts).
// Centralising here lets a schema change touch exactly one file.

/**
 * Minimum columns the OAuth callback and the auth middleware need from
 * a `users` row on re-login / session validation. Any column added to
 * the `SELECT` must be reflected here so both callers stay in sync.
 */
export interface ExistingUserRow {
  id: string;
  tz: string;
  session_version: number;
  digest_hour: number | null;
  hashtags_json: string | null;
}
