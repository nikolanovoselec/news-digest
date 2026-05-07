-- Implements REQ-PIPE-003 AC 9
--
-- `dedup_runs` is the audit table for the queue-driven historical
-- same-story sweep. Every operator-triggered run creates one row here
-- and updates it as the queue consumer self-chains across batches. The
-- table replaces the previous "browser tab loops POSTs" model: the
-- sweep continues even when the operator's tab is backgrounded,
-- throttled, or closed — the queue keeps re-enqueuing continuation
-- messages until `done = 1` or `status = 'failed'`.
--
-- Why a dedicated table instead of reusing scrape_runs:
--   - scrape_runs is the contract for the per-tick scrape pipeline;
--     overloading it with a different lifecycle (no chunks, no
--     LLM-cost columns, possibly hours apart from the cron tick) would
--     muddy the per-tick aggregation queries that drive the stats
--     widget and history page.
--   - The audit row is also the source of truth for the new
--     /api/admin/dedup-status?run_id=… polling endpoint that the
--     settings UI hits every 5s while a sweep is running. Keeping it
--     small and dedicated keeps the SELECT cheap.
--
-- Lifecycle:
--   status='running' on insert, set by the kicker.
--   status='running' continues across queue-consumer batches; the
--     consumer UPDATEs scanned, merged, last_cursor_pa, last_cursor_id
--     after every batch and then either re-enqueues (next batch) or
--     flips status='done' (sweep complete) / status='failed' (terminal
--     queue retry).
--   Terminal states are 'done' and 'failed'; nothing flips them back.
--
-- Multiple-run handling: a fresh kick creates a new run_id and a new
-- row. We do not lock the table to "one run at a time" — two concurrent
-- sweeps would just walk the same corpus twice and the second is
-- idempotent (already-merged rows produce no new merges). The settings
-- UI guards in JS by reading the most recent row's status.
--
-- The composite cursor (`last_cursor_pa`, `last_cursor_id`) is the same
-- shape returned by `runHistoricalDedupBatch` — published_at lower
-- bound + ULID lower bound for equal-time tie-breaking. NULL on insert
-- (sweep starts at the corpus head); set after every batch.

CREATE TABLE dedup_runs (
  id              TEXT PRIMARY KEY,            -- ULID
  status          TEXT NOT NULL,               -- 'running' | 'done' | 'failed'
  scanned         INTEGER NOT NULL DEFAULT 0,
  merged          INTEGER NOT NULL DEFAULT 0,
  batch_count     INTEGER NOT NULL DEFAULT 0,  -- queue messages processed
  last_cursor_pa  INTEGER,                     -- composite cursor: published_at
  last_cursor_id  TEXT,                        -- composite cursor: article id
  remaining       INTEGER NOT NULL DEFAULT 0,  -- last reported remaining
  error           TEXT,                        -- detail when status='failed'
  started_at      INTEGER NOT NULL,            -- unix seconds
  updated_at      INTEGER NOT NULL             -- unix seconds, bumped on every batch
);

-- Status filter on the polling endpoint plus most-recent-row lookup.
CREATE INDEX idx_dedup_runs_started_at ON dedup_runs (started_at DESC);
