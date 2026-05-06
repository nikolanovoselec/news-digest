-- Implements REQ-PIPE-003
--
-- Article embedding lifecycle columns. The chunk-consumer embeds every
-- new article via Workers AI bge-base-en-v1.5 (768-dim) and upserts the
-- vector into the Cloudflare Vectorize index `ai-news-embeddings`.
--
-- D1 stores ONLY the lifecycle metadata, not the vector itself: the
-- vector is the authoritative copy in Vectorize and would inflate the
-- D1 row by ~3 KB if duplicated. A future schema migration could add a
-- BLOB column if a fully-offline reindex is needed.
--
-- Status values:
--   NULL       — pre-existing article from before this migration
--                 (the admin embed-backfill route walks these to embedded).
--   'embedded' — vector is in Vectorize. embedded_at carries the unix
--                 timestamp of the upsert.
--   'failed'   — Workers AI call failed and the article was inserted
--                 anyway (the article is real; the embedding will be
--                 retried by the backfill route).
--
-- The cleanup loop pairs `DELETE FROM articles` with
-- `Vectorize.deleteByIds` so retention drops keep both stores in sync.

ALTER TABLE articles ADD COLUMN embedding_status TEXT;
ALTER TABLE articles ADD COLUMN embedded_at INTEGER;

-- Index on embedding_status so the backfill query
--   SELECT id, title, body... WHERE embedding_status IS NULL OR
--                                   embedding_status = 'failed'
-- doesn't full-scan the articles table on every paginated batch.
CREATE INDEX idx_articles_embedding_status
  ON articles (embedding_status);
