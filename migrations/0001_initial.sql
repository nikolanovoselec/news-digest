-- Initial schema for news-digest
-- (superseded by 0003_global_feed.sql — see migrations/README.md)
-- Implements REQ-AUTH-001, REQ-AUTH-002, REQ-AUTH-005, REQ-SET-001..007,
-- REQ-DISC-001..004, REQ-GEN-001..008, REQ-HIST-001..002, REQ-READ-003
-- (historical — these REQs now point at the live shape in 0003)

PRAGMA foreign_keys = ON;

-- users.id IS the GitHub numeric id as TEXT. Single identity key.
CREATE TABLE users (
  id                          TEXT PRIMARY KEY,
  email                       TEXT NOT NULL,
  gh_login                    TEXT NOT NULL,
  tz                          TEXT NOT NULL,
  digest_hour                 INTEGER,
  digest_minute               INTEGER NOT NULL DEFAULT 0,
  hashtags_json               TEXT,
  model_id                    TEXT,
  email_enabled               INTEGER NOT NULL DEFAULT 1,
  last_generated_local_date   TEXT,
  last_refresh_at             INTEGER,
  refresh_window_start        INTEGER NOT NULL DEFAULT 0,
  refresh_count_24h           INTEGER NOT NULL DEFAULT 0,
  session_version             INTEGER NOT NULL DEFAULT 1,
  created_at                  INTEGER NOT NULL
);

CREATE TABLE digests (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date            TEXT NOT NULL,
  generated_at          INTEGER NOT NULL,
  execution_ms          INTEGER,
  tokens_in             INTEGER,
  tokens_out            INTEGER,
  estimated_cost_usd    REAL,
  model_id              TEXT NOT NULL,
  status                TEXT NOT NULL,
  error_code            TEXT,
  trigger               TEXT NOT NULL
);
CREATE INDEX idx_digests_user_generated ON digests(user_id, generated_at DESC);
CREATE INDEX idx_digests_user_date ON digests(user_id, local_date DESC);
CREATE INDEX idx_digests_status ON digests(status, generated_at);

CREATE TABLE articles (
  id              TEXT PRIMARY KEY,
  digest_id       TEXT NOT NULL REFERENCES digests(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL,
  source_url      TEXT NOT NULL,
  title           TEXT NOT NULL,
  one_liner       TEXT NOT NULL,
  details_json    TEXT NOT NULL,
  source_name     TEXT,
  published_at    INTEGER,
  rank            INTEGER NOT NULL,
  read_at         INTEGER
);
CREATE UNIQUE INDEX idx_articles_digest_slug ON articles(digest_id, slug);
CREATE INDEX idx_articles_digest_rank ON articles(digest_id, rank);
CREATE INDEX idx_articles_read ON articles(digest_id, read_at);

CREATE TABLE pending_discoveries (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, tag)
);
CREATE INDEX idx_pending_discoveries_added ON pending_discoveries(added_at);
CREATE INDEX idx_pending_discoveries_tag ON pending_discoveries(tag);
