-- Implements REQ-AUTH-002, REQ-AUTH-008
--
-- Long-lived refresh tokens for the access/refresh-token auth model.
--
-- The previous model — single 1-hour JWT cookie with 5-min silent
-- refresh — meant any user who closed the tab and came back >1 hour
-- later was logged out. Every consumer-grade webapp uses an access +
-- refresh token split: short-lived access JWT (5 min) on every
-- request, long-lived opaque refresh token (30 days) used ONLY against
-- /api/auth/refresh to mint new access tokens.
--
-- Schema notes:
-- * `id` is an internal row identifier (random 16-byte hex) that is
--   NEVER the cookie value. The cookie value is hashed with SHA-256
--   and stored in `token_hash`; lookups always go through `token_hash`.
--   Keeping `id` separate ensures a leaked DB dump (backup, ops query,
--   error log) does not expose live refresh tokens — only their
--   irreversible hashes. (CodeQL js/sensitive-data-treatment.)
-- * `device_fingerprint_hash` = SHA-256(User-Agent + Cf-IPCountry).
--   Country, not /24 — mobile networks rotate IPs across the same
--   country all day, /24 would lock people out. UA + country is
--   stable per-device.
-- * `parent_id` chains rotated tokens. When a refresh succeeds the
--   old row's `revoked_at` is set and a new row is inserted with
--   `parent_id` = old id. If a token whose `revoked_at` is set is
--   ever presented again, that's theft — REQ-AUTH-008 AC 4 forces
--   revocation of every refresh row for the user and bumps
--   `users.session_version` to kill in-flight access JWTs.
-- * Cleanup is run by the existing scheduled-cleanup cron sweep —
--   `revoked_at < now - 7d` and `expires_at < now - 7d` rows are
--   deleted. The 7-day grace lets the reuse-detection branch see
--   the `revoked_at` row before it's pruned.

PRAGMA foreign_keys = ON;

CREATE TABLE refresh_tokens (
  id                       TEXT PRIMARY KEY,
  token_hash               TEXT NOT NULL UNIQUE,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_fingerprint_hash  TEXT NOT NULL,
  issued_at                INTEGER NOT NULL,
  last_used_at             INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,
  revoked_at               INTEGER,
  parent_id                TEXT REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  rotation_count           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_refresh_tokens_user_active
  ON refresh_tokens(user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_refresh_tokens_hash
  ON refresh_tokens(token_hash);

CREATE INDEX idx_refresh_tokens_cleanup
  ON refresh_tokens(expires_at, revoked_at);

-- `findUnrevokedChild(parent_id)` is hit on every grace-window
-- collision. In normal operation each parent has at most one child
-- (linear rotation chain), but indexing the lookup keeps it O(log n)
-- regardless of how the chain grows.
CREATE INDEX idx_refresh_tokens_parent
  ON refresh_tokens(parent_id)
  WHERE parent_id IS NOT NULL;
