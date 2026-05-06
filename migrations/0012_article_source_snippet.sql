-- Implements REQ-PIPE-003
--
-- Adds a `source_snippet` column on articles to store the raw scraped
-- body text used as the embedding input. Switching the embedding input
-- from the LLM-rewritten `details_json` to the raw source text widens
-- the cosine distribution: same-event articles from different vendors
-- climb closer to 0.85 instead of being compressed into the 0.55-0.71
-- baseline created by the chunk-consumer's summarisation template.
--
-- Historical rows leave `source_snippet` NULL. The buildEmbeddingInput
-- helper falls back to `details_json` when `source_snippet IS NULL` so
-- a re-embed of an old row still produces a valid (if less precise)
-- vector. Newly-scraped rows always populate the column.

ALTER TABLE articles ADD COLUMN source_snippet TEXT;
