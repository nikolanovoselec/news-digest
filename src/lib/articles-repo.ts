// Implements REQ-PIPE-001
//
// Repository layer for the global `articles` table and its child tables
// (article_sources, article_tags, article_stars, article_reads,
// scrape_chunk_completions). Centralises the SQL that was previously
// scattered across the queue consumers and pages so a future schema
// change has exactly one place to update.
//
// Current scope: existing-URL lookups (CF-004 consolidation). Future
// extractions per CF-027 (insertArticles, appendAlternativeSources,
// recordChunkCompletion) will land alongside the chunk-consumer phase
// extraction (CF-006) so the queue consumers can be slimmed in one
// coherent refactor.

import { log } from '~/lib/log';

/** Per-query IN-clause batch size for existing-canonical lookups. D1's
 * SQL string length cap (about 100KB compiled) comfortably handles 100
 * parameters per query; 100 keeps the query under the cap with margin. */
const EXISTING_URL_BATCH = 100;

/** Look up which of the supplied canonical URLs already exist in
 * `articles.canonical_url`, returning a Map keyed by canonical URL with
 * the matched article id as the value. Batched in chunks of
 * {@link EXISTING_URL_BATCH} to keep individual queries under D1's
 * string-length cap. Errors per batch are logged and silently skipped
 * (the next batch may still succeed); this is intentional because the
 * caller's coordinator is best-effort wrt. partial DB outages. */
export async function loadExistingCanonicalToIdMap(
  db: D1Database,
  urls: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < urls.length; i += EXISTING_URL_BATCH) {
    const slice = urls.slice(i, i + EXISTING_URL_BATCH);
    if (slice.length === 0) continue;
    const placeholders = slice.map((_, idx) => `?${idx + 1}`).join(', ');
    try {
      const result = await db
        .prepare(
          `SELECT id, canonical_url FROM articles WHERE canonical_url IN (${placeholders})`,
        )
        .bind(...slice)
        .all<{ id: string; canonical_url: string }>();
      for (const row of result.results ?? []) {
        if (
          typeof row.canonical_url === 'string' &&
          typeof row.id === 'string'
        ) {
          map.set(row.canonical_url, row.id);
        }
      }
    } catch (err) {
      log('warn', 'digest.generation', {
        status: 'coordinator_existing_id_lookup_failed',
        detail: String(err).slice(0, 500),
      });
    }
  }
  return map;
}

/** Set-flavoured wrapper around {@link loadExistingCanonicalToIdMap}.
 * Callers that only need to know which URLs already exist (without
 * the article ids) get a Set without paying for a separate batched
 * scan; the underlying SQL is the same. CF-004 consolidates this
 * with the Map version that previously duplicated the IN-clause
 * batching, error logging, and placeholder building. */
export async function loadExistingCanonicalUrls(
  db: D1Database,
  urls: string[],
): Promise<Set<string>> {
  const map = await loadExistingCanonicalToIdMap(db, urls);
  return new Set(map.keys());
}

/**
 * Update the `chunk_count` column on a scrape_runs row. Called by the
 * coordinator (Step 8) after the real chunk count is known. Best-effort —
 * a failure is logged by the caller, not this helper.
 *
 * CF-021 — extracted from scrape-coordinator.ts so all writes to
 * `scrape_runs.chunk_count` (the CAS sentinel in Step 0, the real count
 * here, and the cascade test fixtures) live alongside the other article-
 * domain SQL.
 */
export async function updateChunkCount(
  db: D1Database,
  scrapeRunId: string,
  chunkCount: number,
): Promise<void> {
  await db
    .prepare('UPDATE scrape_runs SET chunk_count = ?1 WHERE id = ?2')
    .bind(chunkCount, scrapeRunId)
    .run();
}

/**
 * Count how many chunk-completion rows exist for a given scrape run.
 * Used by the chunk consumer to determine whether the last chunk has
 * arrived (completedCount >= total_chunks).
 *
 * CF-021 — extracted from scrape-chunk-consumer.ts so the
 * `scrape_chunk_completions` read-path lives in the same layer as the
 * write-path (`recordChunkCompletion`).
 */
export async function countChunkCompletions(
  db: D1Database,
  scrapeRunId: string,
): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS done FROM scrape_chunk_completions WHERE scrape_run_id = ?1',
    )
    .bind(scrapeRunId)
    .first<{ done: number }>();
  return row?.done ?? 0;
}

/** Record one chunk's completion in `scrape_chunk_completions`. Returns
 * true when this call won the INSERT race (the row didn't already
 * exist), false when the chunk had already been recorded by a prior
 * queue redelivery (CF-003 — extracted from scrape-chunk-consumer.ts
 * so the SQL touching the completions table lives alongside the rest
 * of the article-domain SQL).
 *
 * The `INSERT OR IGNORE` is the single idempotency gate for chunk-
 * level redelivery — the chunk consumer must NOT increment scrape_run
 * counters when this returns false, or D1 redeliveries would
 * double-count tokens, cost, and ingest counters. */
export async function recordChunkCompletion(
  db: D1Database,
  scrapeRunId: string,
  chunkIndex: number,
  completedAt: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const result = await db
    .prepare(
      'INSERT OR IGNORE INTO scrape_chunk_completions (scrape_run_id, chunk_index, completed_at) VALUES (?1, ?2, ?3)',
    )
    .bind(scrapeRunId, chunkIndex, completedAt)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}
