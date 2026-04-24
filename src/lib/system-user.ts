// Implements REQ-DISC-003
//
// Single source of truth for the synthetic user id stamped on system-
// queued rows (currently `pending_discoveries` entries emitted by the
// scrape coordinator when it auto-requeues a tag whose feeds have all
// been evicted — see REQ-DISC-003). Anything that inserts a row on
// behalf of "the system" uses this constant so the value can never
// drift between callers, and anything that scans `users` rows for
// human identities must exclude it.
//
// Matches the row provisioned by `migrations/0004_system_user.sql`.

/** User id of the sentinel row that represents the system. Never
 *  reachable via OAuth (GitHub cannot return this literal as a numeric
 *  user id). */
export const SYSTEM_USER_ID = '__system__';
