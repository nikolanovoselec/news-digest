// Implements REQ-PIPE-005
//
// Daily retention cleanup. The `0 3 * * *` cron in `src/worker.ts` calls
// `runCleanup(env)` once per day. Articles older than 7 days are deleted
// unless at least one user has starred them — starred articles are
// preserved indefinitely (AC 2). Child rows in `article_sources`,
// `article_tags`, and `article_reads` are removed via FK ON DELETE
// CASCADE declared in `migrations/0003_global_feed.sql` (AC 3).
//
// The deletion count is emitted as a structured log line so operators
// can trace retention activity in Cloudflare Logs (AC 4).

import { log } from '~/lib/log';

/** Retention window. Articles whose `published_at` is older than this
 * many seconds before `now` are eligible for deletion when no user has
 * starred them. */
const RETENTION_SECONDS = 7 * 86400;

/**
 * Run one retention-cleanup pass. Idempotent — a second immediate call
 * is a no-op because the first call removed all stale rows.
 *
 * @returns `{ deleted }` — number of article rows removed. The value is
 *   also exposed via the `digest.generation` log line for operational
 *   visibility.
 */
export async function runCleanup(env: Env): Promise<{ deleted: number }> {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SECONDS;

  // DELETE stale articles not referenced by any row in `article_stars`.
  // `NOT IN (SELECT article_id FROM article_stars)` keeps every article
  // that any user has starred, regardless of age.
  //
  // FK ON DELETE CASCADE on article_sources / article_tags / article_reads
  // is declared in migrations/0003_global_feed.sql and fires automatically
  // when the parent article row is removed (PRAGMA foreign_keys must be
  // ON at the connection level; D1 enables this by default).
  const result = await env.DB.prepare(
    `DELETE FROM articles
      WHERE published_at < ?1
        AND id NOT IN (SELECT article_id FROM article_stars)`,
  )
    .bind(cutoff)
    .run();

  const deleted = result.meta?.changes ?? 0;

  log('info', 'digest.generation', {
    status: 'cleanup_completed',
    deleted,
    cutoff_unix: cutoff,
  });

  return { deleted };
}
