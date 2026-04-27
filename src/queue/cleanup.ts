// Implements REQ-PIPE-005
// Implements REQ-PIPE-007
// Implements REQ-DISC-006
//
// Daily retention cleanup. The `0 3 * * *` cron in `src/worker.ts` calls
// `runCleanup(env)` once per day. Three independent passes:
//
//   1. Article retention (REQ-PIPE-005): articles older than 14 days are
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
//   3. Stuck-tag prune (REQ-DISC-006): tags whose `sources:{tag}` cache
//      has been in the empty-feeds state for more than 7 days are
//      removed from every user's `hashtags_json`. The orphan sweep
//      then mops up the now-unowned `sources:` entry on the same run.
//      Without this pass, a tag that produced one bad LLM lookup sits
//      in the user's interests list indefinitely with a permanent
//      "Stuck tag" warning on /settings.
//
// Each pass runs inside its own try/catch so a failure in one half
// never blocks the others (REQ-PIPE-007 AC 5). Deletion counts for
// all passes are emitted as structured log lines for observability.

import { log } from '~/lib/log';

/** Retention window. Articles whose `published_at` is older than this
 * many seconds before `now` are eligible for deletion when no user has
 * starred them. Extended from 7 → 14 days per issue #97 so the history
 * view has a longer lookback before retention kicks in. */
const RETENTION_SECONDS = 14 * 86400;

/** Stuck-tag prune window. A tag whose `sources:{tag}` cache has been
 * in the empty-feeds state (feeds: []) for more than this many seconds
 * is removed from every user's `hashtags_json` so the settings page
 * stops surfacing a permanent "Stuck tag" warning for it. */
const STUCK_TAG_TTL_SECONDS = 7 * 86400;

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
  stuckTagsPruned: number;
}> {
  const articlesDeleted = await runArticleRetention(env);
  // Stuck-tag prune runs BEFORE the orphan sweep so the same run
  // mops up the `sources:{tag}` cache entries the prune leaves
  // unowned — keeps the daily cron self-cleaning.
  const stuckTagsPruned = await runStuckTagPrune(env);
  const orphanTagsDeleted = await runOrphanTagSweep(env);
  return { articlesDeleted, orphanTagsDeleted, stuckTagsPruned };
}

/** REQ-PIPE-005 — delete articles older than 14 days unless starred. */
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
        sample_tags: [],
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

interface UserHashtagsRowWithId {
  id: string;
  hashtags_json: string | null;
}

/** Parsed `sources:{tag}` cache shape — duplicates the type in
 *  `src/lib/discovery.ts` rather than importing it because cleanup
 *  consumes only two fields and importing across queue/lib boundaries
 *  drags in unnecessary surface. */
interface SourcesCacheValueShape {
  feeds: unknown;
  discovered_at: number;
}

/** REQ-DISC-006 — find tags whose `sources:{tag}` KV entry has been
 *  empty-feeds for longer than {@link STUCK_TAG_TTL_SECONDS} and remove
 *  them from every user's `hashtags_json`. The unowned `sources:` entry
 *  is left for the subsequent orphan-tag sweep to clear in the same
 *  cron run. Returns the number of (user, tag) prunes applied. */
async function runStuckTagPrune(env: Env): Promise<number> {
  const cutoffMs = Date.now() - STUCK_TAG_TTL_SECONDS * 1000;
  try {
    const stuckTooLong = new Set<string>();

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
        const raw = await env.KV.get(key.name);
        if (raw === null) continue;
        let parsed: SourcesCacheValueShape | null;
        try {
          parsed = JSON.parse(raw) as SourcesCacheValueShape;
        } catch {
          continue;
        }
        if (parsed === null || typeof parsed !== 'object') continue;
        if (!Array.isArray(parsed.feeds) || parsed.feeds.length !== 0) continue;
        if (typeof parsed.discovered_at !== 'number') continue;
        if (parsed.discovered_at > cutoffMs) continue;
        stuckTooLong.add(tag);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor !== undefined);

    if (stuckTooLong.size === 0) {
      log('info', 'discovery.completed', {
        status: 'stuck_tag_prune_completed',
        pruned: 0,
        cutoff_ms: cutoffMs,
      });
      return 0;
    }

    // Find every user whose hashtags_json contains at least one of
    // these tags. The `__system__` sentinel row is filtered out by
    // hashtags_json being NULL.
    const userRows = await env.DB
      .prepare(
        "SELECT id, hashtags_json FROM users WHERE hashtags_json IS NOT NULL AND hashtags_json != ''",
      )
      .all<UserHashtagsRowWithId>();

    const updateStmt = env.DB.prepare(
      'UPDATE users SET hashtags_json = ?1 WHERE id = ?2',
    );
    const updates: D1PreparedStatement[] = [];
    let prunedTotal = 0;
    for (const row of userRows.results ?? []) {
      const raw = row.hashtags_json;
      if (raw === null || raw === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      const kept: string[] = [];
      let removed = 0;
      for (const entry of parsed) {
        if (typeof entry !== 'string') continue;
        const stripped = entry.startsWith('#') ? entry.slice(1) : entry;
        const normalized = stripped.toLowerCase();
        if (normalized !== '' && stuckTooLong.has(normalized)) {
          removed += 1;
          continue;
        }
        kept.push(entry);
      }
      if (removed === 0) continue;
      updates.push(updateStmt.bind(JSON.stringify(kept), row.id));
      prunedTotal += removed;
    }

    if (updates.length > 0) {
      await env.DB.batch(updates);
    }

    log('info', 'discovery.completed', {
      status: 'stuck_tag_prune_completed',
      pruned: prunedTotal,
      tags_evicted: stuckTooLong.size,
      users_touched: updates.length,
      cutoff_ms: cutoffMs,
    });

    return prunedTotal;
  } catch (err) {
    log('error', 'discovery.completed', {
      status: 'stuck_tag_prune_failed',
      detail: String(err).slice(0, 500),
    });
    return 0;
  }
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
