-- Implements REQ-OPS-008
--
-- `pipeline_runs` is the audit table for the backend-driven full
-- pipeline orchestrator. Every "Full pipeline run" click on /settings
-- creates one row here; a self-chaining `pipeline-jobs` queue consumer
-- advances it through the phases server-side without depending on the
-- operator's browser tab staying open.
--
-- Why a backend orchestrator instead of the previous browser loop:
--   - Mobile tabs throttle/sleep aggressively. The previous loop in
--     settings.astro called POST /api/admin/embed-backfill in a tight
--     while-loop and only kicked the historical-dedup phase after the
--     embed-backfill loop returned `done: true`. If the tab slept
--     mid-loop, every phase after embedding silently never ran.
--   - The dedup-sweep already proved the queue self-chain pattern —
--     `dedup_runs` + `dedup-sweep-consumer` survives tab close because
--     the queue drives the loop, not JavaScript. This table extends
--     the same shape one level up: one row per pipeline kick, one
--     queue (`pipeline-jobs`) chaining the phases.
--
-- Phases (advanced via self-chained `pipeline-jobs` messages):
--   reembed_flip → reembed_drain → scrape_kick → scrape_wait
--                                                → embed_drain
--                                                → dedup_kick
--                                                → dedup_wait → done
--
--   Non-wipe (refresh-only) runs skip reembed_flip + reembed_drain and
--   start at scrape_kick. The "Refresh feeds" button on /settings
--   continues to use the existing /api/admin/force-refresh path
--   directly because it explicitly wants only phase 1; the orchestrator
--   is the "Full pipeline run" button only.
--
-- Lifecycle:
--   status='running' on insert, set by the kicker
--     (`/api/admin/pipeline-run`).
--   status='running' continues across queue-consumer batches; the
--     consumer UPDATEs current_phase, scrape_run_id, dedup_run_id
--     after each phase transition and re-enqueues the next phase as a
--     queue message (with a delaySeconds when waiting on an external
--     state machine like scrape_runs.status or dedup_runs.status).
--   Terminal states are 'done' and 'failed'; nothing flips them back.
--
-- The polling endpoint (`/api/admin/pipeline-status?id=...`) returns
-- this row plus a nested view of scrape_runs + dedup_runs lookups so
-- the UI can show progress without the operator's tab being part of
-- the orchestration. Closing the tab and re-opening /settings later
-- recovers full progress display from this audit row.

CREATE TABLE pipeline_runs (
  id              TEXT PRIMARY KEY,            -- ULID
  status          TEXT NOT NULL,               -- 'running' | 'done' | 'failed'
  mode            TEXT NOT NULL,               -- 'full' | 'wipe'
  current_phase   TEXT NOT NULL,               -- see phases comment above
  scrape_run_id   TEXT,                        -- set when scrape_kick lands
  dedup_run_id    TEXT,                        -- set when dedup_kick lands
  embed_processed INTEGER NOT NULL DEFAULT 0,  -- cumulative across batches
  embed_remaining INTEGER NOT NULL DEFAULT 0,  -- last-seen remaining
  error           TEXT,                        -- detail when status='failed'
  started_at      INTEGER NOT NULL,            -- unix seconds
  updated_at      INTEGER NOT NULL             -- unix seconds, bumped on every phase advance
);

-- Most-recent-row lookup for the polling endpoint when the operator
-- reopens /settings without a saved id (we surface the last run so
-- progress on a forgotten tab can still be resumed visually).
CREATE INDEX idx_pipeline_runs_started_at ON pipeline_runs (started_at DESC);
