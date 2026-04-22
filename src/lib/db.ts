// Implements REQ-DATA-001
//
// Thin D1 wrapper — helpers that make the D1 client behave the way the rest
// of the app expects. Deliberately NOT a repository abstraction: domain
// modules own their queries so SQL stays visible and greppable.
//
// Per CON-DATA-001, D1 holds strongly-consistent state (users, digests,
// articles, pending_discoveries). D1 does not support interactive
// transactions over HTTP, so `batch()` is the only way to write multiple
// rows atomically — the whole array commits or rolls back together.

/**
 * Enable foreign key enforcement on the current D1 connection.
 *
 * D1 requires `PRAGMA foreign_keys = ON` per connection; it is not a
 * database-level setting. Call this at the top of any request handler that
 * relies on cascade deletes or FK constraint checks (for example,
 * REQ-AUTH-005 account deletion depends on the cascade from `users` to
 * `digests`, `articles`, and `pending_discoveries`).
 */
export async function applyForeignKeysPragma(db: D1Database): Promise<void> {
  await db.exec('PRAGMA foreign_keys = ON');
}

/**
 * Atomically execute multiple prepared statements.
 *
 * Thin pass-through over `db.batch` with a typed result. Used by multi-row
 * writes that must succeed or fail as a unit — most notably the digest
 * finalization write (one `digests` row + many `articles` rows) performed
 * by `generateDigest` in the Phase 5 queue consumer.
 *
 * Ordering is preserved; results are returned in the same order as the
 * input statements. If any statement fails the entire batch rolls back and
 * the promise rejects.
 */
export async function batch<T = unknown>(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<D1Result<T>[]> {
  return db.batch<T>(statements);
}
