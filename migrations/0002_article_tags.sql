-- 0002_article_tags.sql
-- (superseded by 0003_global_feed.sql — see migrations/README.md)
-- Implements REQ-GEN-005, REQ-GEN-006 (historical — superseded by 0003)
-- Adds a `tags_json` column to the articles table so each article can
-- record which of the user's hashtags it belongs to. Used by the
-- reading-surface filter (click a tag in the strip to show only
-- articles tagged with it) and the per-article tag popover.
--
-- NULL is treated as "no tag information" (e.g., rows from before this
-- migration). Callers coerce NULL to [] when rendering.

ALTER TABLE articles ADD COLUMN tags_json TEXT;
