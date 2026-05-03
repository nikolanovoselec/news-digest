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
export const EXISTING_URL_BATCH = 100;

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
