-- 0015_scrape_runs_wait_iterations.sql
-- CF-001: track how many times the pipeline scrape_wait phase has
-- re-enqueued itself for a given scrape_run, so the pipeline can fail
-- out of an unbounded wait loop instead of looping forever.

ALTER TABLE scrape_runs ADD COLUMN wait_iterations INTEGER NOT NULL DEFAULT 0;
