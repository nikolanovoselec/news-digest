// Implements REQ-PIPE-005
// Implements REQ-PIPE-007
//
// Daily retention cleanup. The `0 3 * * *` cron in `src/worker.ts` calls
// `runCleanup(env)` once per day. Two independent passes:
//
//   1. Article retention (REQ-PIPE-005): articles older than 7 days are
//      deleted unless at least one user has starred them. Child rows in
//      `article_sources`, `article_tags`, and `article_reads` are
//      removed via FK ON DELETE CASCADE declared in
//      `migrations/0003_global_feed.sql`.
//
//   2. Orphan-tag cache cleanup (REQ-PIPE-007): discovered-feed cache
//      entries (`sources:{tag}` in KV) whose tag is no longer present
//      in any user's `hashtags_json` are deleted, plus their
//      `discovery_failures:{tag}` siblings. Without this pass, a tag a
//      user removed (or an account deleted) keeps incurring scrape
//      fetches and LLM-summarisation cost on every tick forever.
//
// Each pass runs inside its own try/catch so a failure in one half
// never blocks the other (REQ-PIPE-007 AC 5). Deletion counts for
// both passes are emitted as structured log lines for observability.

import { log } from '~/lib/log';

/** Retention window. Articles whose `published_at` is older than this
 * many seconds before `now` are eligible for deletion when no user has
 * starred them. */
const RETENTION_SECONDS = 7 * 86400;

/**
 * Run one retention-cleanup pass. Idempotent — a second immediate call
 * is a no-op because the first call removed all stale rows.
 *
 * @returns Counts for both halves of the daily sweep:
 *   `articlesDeleted` — articles removed by the retention pass.
 *   `orphanTagsDeleted` — discovered-feed caches removed for tags no
 *   user owns anymore.
 */
export async function runCleanup(env: Env): Promise<{
  articlesDeleted: number;
  orphanTagsDeleted: number;
}> {
  const articlesDeleted = await runArticleRetention(env);
  const orphanTagsDeleted = await runOrphanTagSweep(env);
  return { articlesDeleted, orphanTagsDeleted };
}

/** REQ-PIPE-005 — delete articles older than 7 days unless starred. */
async function runArticleRetention(env: Env): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_SECONDS;
  try {
    // DELETE stale articles not referenced by any row in `article_stars`.
    // `NOT IN (SELECT article_id FROM article_stars)` keeps every article
    // that any user has starred, regardless of age.
    //
    // FK ON DELETE CASCADE on article_sources / article_tags / article_reads
    // is declared in migrations/0003_global_feed.sql and fires automatically
    // when the parent article row is removed.
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
    return deleted;
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'cleanup_failed',
      detail: String(err).slice(0, 500),
    });
    return 0;
  }
}

/** REQ-PIPE-007 — delete `sources:{tag}` + `discovery_failures:{tag}`
 *  entries whose tag no user has selected. Tags any user owns are
 *  preserved; the self-healing eviction loop (REQ-DISC-003) is the
 *  only path that should mutate an actively-owned tag's cache. */
async function runOrphanTagSweep(env: Env): Promise<number> {
  try {
    // Collect every tag any user has selected. We hold this set in
    // memory; with 1000 users × 25 tags max that's 25k strings worst
    // case — comfortably small. The `__system__` sentinel row's
    // hashtags_json is null so it does not contribute.
    const owned = await loadOwnedTags(env.DB);

    // Enumerate every `sources:{tag}` KV key. KV list pages cursor
    // through any number of keys; the loop terminates on
    // `list_complete: true`.
    const orphanTags: string[] = [];
    let cursor: string | undefined;
    do {
      const page: KVNamespaceListResult<unknown> = await env.KV.list({
        prefix: 'sources:',
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const key of page.keys) {
        const tag = key.name.startsWith('sources:')
          ? key.name.slice('sources:'.length)
          : '';
        if (tag === '') continue;
        if (!owned.has(tag)) orphanTags.push(tag);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor !== undefined);

    if (orphanTags.length === 0) {
      log('info', 'digest.generation', {
        status: 'orphan_tag_sweep_completed',
        deleted: 0,
        scanned_owned_tags: owned.size,
      });
      return 0;
    }

    // Delete in parallel — independent keys, no ordering constraint.
    // Also clear the per-tag failure counter so a future re-add of
    // the same tag starts from a clean slate.
    await Promise.all(
      orphanTags.flatMap((tag) => [
        env.KV.delete(`sources:${tag}`),
        env.KV.delete(`discovery_failures:${tag}`),
      ]),
    );

    log('info', 'digest.generation', {
      status: 'orphan_tag_sweep_completed',
      deleted: orphanTags.length,
      scanned_owned_tags: owned.size,
      sample_tags: orphanTags.slice(0, 10),
    });

    return orphanTags.length;
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'orphan_tag_sweep_failed',
      detail: String(err).slice(0, 500),
    });
    return 0;
  }
}

interface UserHashtagsRow {
  hashtags_json: string | null;
}

/** Load the union of every tag in every user's hashtags_json. The
 *  format is the same as everywhere else (`["tag1","#tag2"]`); we
 *  strip leading `#` and lowercase to match the canonical form
 *  written by `/api/tags`. Empty / corrupt rows contribute nothing.
 *
 *  The `__system__` sentinel row's hashtags_json is null so it does
 *  not contribute orphaning protection — any tag stamped on a
 *  system-queued discovery row but not owned by a real user will
 *  still be swept. Pending discovery rows themselves are evicted
 *  when their tag's `sources:` cache is deleted (the next
 *  discovery cron with no key to write against will simply
 *  proceed; the row is then drained via the normal flow). */
async function loadOwnedTags(db: D1Database): Promise<Set<string>> {
  const owned = new Set<string>();
  const result = await db
    .prepare(
      "SELECT hashtags_json FROM users WHERE hashtags_json IS NOT NULL AND hashtags_json != ''",
    )
    .all<UserHashtagsRow>();
  for (const row of result.results ?? []) {
    const raw = row.hashtags_json;
    if (raw === null || raw === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      if (typeof entry !== 'string') continue;
      const stripped = entry.startsWith('#') ? entry.slice(1) : entry;
      const normalized = stripped.toLowerCase();
      if (normalized !== '') owned.add(normalized);
    }
  }
  return owned;
}
