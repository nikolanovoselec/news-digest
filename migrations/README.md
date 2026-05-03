# Migrations

D1 schema is rebuilt from scratch by every migration in this folder, applied in lexical order. The cron-driven workflow reapplies them on every CI deploy via `wrangler d1 migrations apply`.

## Historical context (CF-010)

The current live schema effectively starts at **migration 0003**. Migrations 0001–0002 describe a **pre-launch schema** (per-user digest jobs, tag-keyed columns, separate hashtag table) that was redesigned before the product reached real users.

Migration 0003 (`0003_global_feed.sql`) is destructive: it `DROP`s every table touched by 0001–0002 and recreates them in the global-feed shape (one shared scrape pool, `articles.canonical_url` as the dedup key, JSON arrays for `details_json`/`tags_json`, `article_sources`/`article_tags`/`article_reads`/`article_stars` as the live child tables).

What this means for REQ annotations:

- REQ comments inside `0001_initial.sql` and `0002_article_tags.sql` are **historical** — those columns and tables were superseded by 0003 and never shipped. Don't edit those headers; the file's value is the migration history, not the contract.
- REQ comments in `0003_global_feed.sql` and onward describe the **live** schema. Spec changes that touch these tables expect the matching SQL to live here.

## Migration index (live)

| # | File | Purpose |
|---|---|---|
| 0003 | `0003_global_feed.sql` | Drops and recreates the live schema in the global-feed shape (REQ-PIPE-*, REQ-READ-*, REQ-HIST-*, REQ-STAR-*) |
| 0004 | `0004_system_user.sql` | System-owned `users` row used as the `user_id` foreign key on system-discovered tag rows |
| 0005 | `0005_auth_links.sql` | Email-claim history for accounts that link a second OAuth provider |
| 0006 | `0006_e2e_user.sql` | Test-only user row exposed to the Playwright bypass token (no production effect) |
| 0007 | `0007_scrape_chunk_completions.sql` | Per-chunk completion ledger backing REQ-PIPE-002 chunk-vs-finalize race guard (replaces the legacy KV chunks_remaining counter) |
| 0008 | `0008_scrape_runs_finalize_lock.sql` | `scrape_runs.finalize_enqueued` once-per-run gate (REQ-PIPE-008 AC 9a — exactly-one finalize across redelivery) |
| 0009 | `0009_refresh_tokens.sql` | Refresh-token rotation table for REQ-AUTH-008 |
| 0010 | `0010_scrape_runs_finalize_recorded.sql` | `scrape_runs.finalize_recorded` once-per-run cost gate (REQ-PIPE-008 AC 7 — record cost on the first LLM pass regardless of redelivery) |

## Adding a new migration

1. Number sequentially (`migrations/00NN_short_purpose.sql`).
2. Reference at least one REQ in a `-- Implements REQ-X-NNN` header line so spec-reviewer can detect the linkage.
3. Schema invariants live in source-of-truth REQs in `sdd/`. The migration is the *how*, not the *why*.
4. Avoid destructive migrations on live data — additive `ALTER TABLE ADD COLUMN` is preferred.
