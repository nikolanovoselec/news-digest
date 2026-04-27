-- Implements REQ-AUTH-001
--
-- Synthetic e2e-test user. Without this row, scripts/e2e-test.sh
-- (gated by DEV_BYPASS_TOKEN) would mint a session for whichever
-- non-system row sorts first by created_at — i.e. the operator's
-- own account. Every e2e run then mutated the operator's tags,
-- stars, settings, and triggered a real scrape.
--
-- The fix is to install a dedicated `__e2e__` row up-front so
-- /api/dev/login lands on it by default. Mutations stay sandboxed
-- to this row; the operator's account is never touched. The id is
-- a sentinel string that no OAuth provider can return as a user id
-- (GitHub returns a numeric id; Google/etc. return `provider:sub`),
-- so the row is unreachable from a real sign-in.
--
-- email is set to a non-deliverable @invalid.local address (RFC 2606)
-- so a misqueued outbound email would bounce rather than spam a real
-- recipient. email_enabled = 0 so the daily-digest dispatcher skips
-- this row outright. digest_hour = 8 — a non-null value so the
-- settings gate (REQ-SET-006) does not bounce the session (the gate
-- only checks digest_hour IS NULL). created_at is stamped at
-- migration time, which precedes any OAuth sign-up, so the row is
-- the deterministic landing target for `/api/dev/login`.

INSERT OR IGNORE INTO users (
  id,
  email,
  gh_login,
  tz,
  digest_hour,
  digest_minute,
  hashtags_json,
  model_id,
  email_enabled,
  refresh_window_start,
  refresh_count_24h,
  session_version,
  created_at
) VALUES (
  '__e2e__',
  'e2e@invalid.local',
  '__e2e__',
  'UTC',
  8,
  0,
  '["ai", "llm"]',
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
  0,
  0,
  0,
  1,
  strftime('%s', 'now') * 1
);
