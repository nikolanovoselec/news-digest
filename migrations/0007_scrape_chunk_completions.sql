-- Implements REQ-PIPE-002
--
-- Atomic chunk-completion tracking. Replaces the previous KV
-- read-modify-write decrement, which had a TOCTOU race window between
-- `KV.get(chunks_remaining)` and `KV.put(...)` — two concurrent chunk
-- consumers reading the same value before either could write would
-- decrement to the same target, finalizing the scrape twice (or
-- worse, never).
--
-- Each chunk consumer now does:
--
--   INSERT OR IGNORE INTO scrape_chunk_completions(...) VALUES (...);
--   SELECT COUNT(*) FROM scrape_chunk_completions WHERE scrape_run_id = ?;
--
-- The (run_id, chunk_index) primary key makes the INSERT idempotent
-- under retries / queue redelivery, and the COUNT(*) gives the exact
-- "completed so far" total without depending on a separate counter
-- that other writers might race.
--
-- A row's lifetime is bounded to the scrape run it belongs to.
-- NOTE: cleanup of stale `scrape_chunk_completions` rows for aged-out
-- runs is not yet wired into `runCleanup` (src/queue/cleanup.ts) and is
-- tracked as a follow-up. Growth is monotonic but bounded:
-- ~6 runs/day × ~10 chunks/run ≈ 22k rows/year per deployment, so the
-- table size is operationally manageable until the sweep lands.

CREATE TABLE scrape_chunk_completions (
  scrape_run_id TEXT NOT NULL,
  chunk_index   INTEGER NOT NULL,
  completed_at  INTEGER NOT NULL,
  PRIMARY KEY (scrape_run_id, chunk_index)
);

CREATE INDEX idx_chunk_completions_run ON scrape_chunk_completions(scrape_run_id);
