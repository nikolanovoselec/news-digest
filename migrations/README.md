# Migrations

D1 schema is rebuilt from scratch by every migration in this folder, applied in lexical order. The cron-driven workflow reapplies them on every CI deploy via `wrangler d1 migrations apply`.

## Historical context (CF-020 reverted)

The current live schema is the result of `0003_global_feed.sql` redesigning
the original 0001/0002 shape into the global-feed shape. CF-020 originally
proposed deleting 0001 + 0002 as redundant, but the test fixtures'
`applyD1Migrations` walks the entire folder in order and 0003's recreated
tables (article_stars, article_reads) carry `REFERENCES users(id)` foreign
keys. The `users` table is created by 0001; without it 0003's table
creation errors at the FK declaration. Migration 0002 likewise carries an
`ALTER TABLE articles` that fails if 0001's `articles` table is absent.
The 0001/0002 files are kept verbatim as the FK-base of every fresh test
pool / CI run.

REQ comments in `0003_global_feed.sql` and onward describe the **live**
schema. Spec changes that touch these tables expect the matching SQL to
live here.

## Migration index

| # | File | Purpose |
|---|---|---|
| 0001 | `0001_initial.sql` | Pre-launch initial schema; live at the start of every replay because 0003 expects these tables to exist before its DROP statements run |
| 0002 | `0002_article_tags.sql` | Pre-launch tag columns; same replay invariant as 0001 |
| 0003 | `0003_global_feed.sql` | Drops and recreates the live schema in the global-feed shape (REQ-PIPE-*, REQ-READ-*, REQ-HIST-*, REQ-STAR-*) |
| 0004 | `0004_system_user.sql` | System-owned `users` row used as the `user_id` foreign key on system-discovered tag rows |
| 0005 | `0005_auth_links.sql` | Email-claim history for accounts that link a second OAuth provider |
| 0006 | `0006_e2e_user.sql` | Test-only user row exposed to the Playwright bypass token (no production effect) |
| 0007 | `0007_scrape_chunk_completions.sql` | Per-chunk completion ledger backing REQ-PIPE-002 chunk-vs-finalize race guard (replaces the legacy KV chunks_remaining counter) |
| 0008 | `0008_scrape_runs_finalize_lock.sql` | `scrape_runs.finalize_enqueued` once-per-run gate (REQ-PIPE-003 AC 9a — exactly-one finalize across redelivery) |
| 0009 | `0009_refresh_tokens.sql` | Refresh-token rotation table for REQ-AUTH-008 |
| 0010 | `0010_scrape_runs_finalize_recorded.sql` | `scrape_runs.finalize_recorded` once-per-run cost gate (REQ-PIPE-003 AC 7 — record cost on the first LLM pass regardless of redelivery) |

## Adding a new migration

1. Number sequentially (`migrations/00NN_short_purpose.sql`).
2. Reference at least one REQ in a `-- Implements REQ-X-NNN` header line so spec-reviewer can detect the linkage.
3. Schema invariants live in source-of-truth REQs in `sdd/`. The migration is the *how*, not the *why*.
4. Avoid destructive migrations on live data — additive `ALTER TABLE ADD COLUMN` is preferred.
