-- Implements REQ-AUTH-006
-- Cross-provider user dedup. Without this table, signing in via GitHub and
-- then via Google with the same verified email creates two `users` rows
-- (different `id` shapes — bare numeric for GitHub, `google:<sub>` for
-- Google), and the daily-digest dispatcher fans out one email per row,
-- so the user receives the same digest twice.
--
-- New flow keyed off this table:
--   1. OAuth callback looks up `(provider, provider_sub)` here. If found,
--      that's the user_id — done.
--   2. If not found, the callback looks up `users` by verified email.
--      If a user with that email already exists (i.e. a different
--      provider beat us to it), we INSERT a new auth_links row pointing
--      to that existing user_id and reuse the row.
--   3. Only when neither lookup matches do we create a new users row
--      AND a new auth_links row in tandem.
--
-- This migration also performs a one-time merge for any duplicate-email
-- pairs that already exist in the database (e.g. the production case
-- where mafijozo@gmail.com signed in via both providers).

PRAGMA foreign_keys = ON;

-- 1. Create the alias table.
CREATE TABLE auth_links (
  provider     TEXT    NOT NULL,
  provider_sub TEXT    NOT NULL,
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at    INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_sub)
);
CREATE INDEX idx_auth_links_user ON auth_links(user_id);

-- 2. Identify duplicate-email groups and pick a winner per group.
--    Winner = oldest by created_at, with id ASC tiebreaker for
--    determinism. Losers = every other row in the same email group.
CREATE TEMP TABLE _email_winners AS
  SELECT email, MIN(created_at) AS winner_created_at
  FROM users
  WHERE id != '__system__' AND email IS NOT NULL AND email != ''
  GROUP BY email
  HAVING COUNT(*) > 1;

CREATE TEMP TABLE _user_merges AS
  SELECT
    (SELECT u.id FROM users u
       WHERE u.email = w.email
         AND u.created_at = w.winner_created_at
         AND u.id != '__system__'
       ORDER BY u.id ASC LIMIT 1) AS winner_id,
    u.id AS loser_id
  FROM _email_winners w
  JOIN users u ON u.email = w.email AND u.id != '__system__'
  WHERE u.id != (
    SELECT u2.id FROM users u2
       WHERE u2.email = w.email
         AND u2.created_at = w.winner_created_at
         AND u2.id != '__system__'
       ORDER BY u2.id ASC LIMIT 1
  );

-- 3. Capture each loser's (provider, provider_sub) BEFORE we delete the
--    loser row — we will write these as auth_links rows pointing at the
--    winner so that future logins by the same provider find the winner
--    instead of creating a fresh row.
CREATE TEMP TABLE _loser_links AS
  SELECT
    CASE WHEN u.id LIKE '%:%' THEN substr(u.id, 1, instr(u.id, ':') - 1) ELSE 'github' END AS provider,
    CASE WHEN u.id LIKE '%:%' THEN substr(u.id, instr(u.id, ':') + 1) ELSE u.id END AS provider_sub,
    m.winner_id AS user_id,
    COALESCE(u.created_at, CAST(strftime('%s', 'now') AS INTEGER)) AS linked_at
  FROM users u
  JOIN _user_merges m ON u.id = m.loser_id;

-- 4. Re-point child rows from loser → winner. INSERT OR IGNORE collapses
--    the case where the user has the same article starred under both
--    accounts.
INSERT OR IGNORE INTO article_stars (user_id, article_id, starred_at)
  SELECT m.winner_id, s.article_id, s.starred_at
    FROM article_stars s
    JOIN _user_merges m ON s.user_id = m.loser_id;

INSERT OR IGNORE INTO article_reads (user_id, article_id, read_at)
  SELECT m.winner_id, r.article_id, r.read_at
    FROM article_reads r
    JOIN _user_merges m ON r.user_id = m.loser_id;

INSERT OR IGNORE INTO pending_discoveries (user_id, tag, added_at)
  SELECT m.winner_id, p.tag, p.added_at
    FROM pending_discoveries p
    JOIN _user_merges m ON p.user_id = m.loser_id;

-- 5. Delete the loser users. FK ON DELETE CASCADE on article_stars,
--    article_reads, pending_discoveries removes any unmigrated child
--    rows (e.g. if INSERT OR IGNORE above bounced because the winner
--    already had the same row).
DELETE FROM users WHERE id IN (SELECT loser_id FROM _user_merges);

-- 6. Backfill auth_links for every surviving user. Each users row
--    contributes exactly one alias derived from its current id.
INSERT OR IGNORE INTO auth_links (provider, provider_sub, user_id, linked_at)
  SELECT
    CASE WHEN id LIKE '%:%' THEN substr(id, 1, instr(id, ':') - 1) ELSE 'github' END,
    CASE WHEN id LIKE '%:%' THEN substr(id, instr(id, ':') + 1) ELSE id END,
    id,
    COALESCE(created_at, CAST(strftime('%s', 'now') AS INTEGER))
  FROM users
  WHERE id != '__system__';

-- 7. Add the loser provider/sub → winner aliases so subsequent logins
--    via the loser's provider find the winner.
INSERT OR IGNORE INTO auth_links (provider, provider_sub, user_id, linked_at)
  SELECT provider, provider_sub, user_id, linked_at FROM _loser_links;

-- 8. Drop temp tables.
DROP TABLE _loser_links;
DROP TABLE _user_merges;
DROP TABLE _email_winners;
