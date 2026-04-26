// Implements REQ-MAIL-001
//
// Per-user data fetchers used by the email dispatcher to compose the
// rich daily digest. Pure D1 reads — never writes — so the email path
// stays isolated from the reading-surface state machine
// (REQ-MAIL-002 AC 4: dispatcher must not INSERT/UPDATE/DELETE
// articles, article_reads, etc.).
//
// Two helpers:
//   - selectUnreadHeadlinesForUser: top N articles in the user's tag
//     intersection that the user has NOT yet opened. Drives the
//     headline list and the dynamic subject line ("12 new articles ...").
//   - tagTallySinceMidnight: per-tag article counts over the recipient's
//     local-day window. Drives the "Since midnight: N articles · ..."
//     line. Intentionally does NOT filter by article_reads — the line
//     describes "what happened today across topics you care about",
//     regardless of read state.
//
// SQL pattern reuses the placeholder-binding trick from
// src/pages/api/digest/today.ts (?2..?N for tag bindings) so D1 can
// type the prepared statement without string interpolation.

/** A single headline row destined for the email body. */
export interface Headline {
  id: string;
  title: string;
  source_name: string | null;
  slug: string;
  primary_source_url: string | null;
}

/** One row in the "since midnight" tag tally. */
export interface TagTally {
  tag: string;
  count: number;
}

interface HeadlineRow {
  id: string;
  title: string;
  source_name: string | null;
  primary_source_url: string | null;
}

interface TallyRow {
  tag: string;
  count: number;
}

interface TotalRow {
  total: number;
}

import { slugify } from '~/lib/slug';

/**
 * Top {@link limit} unread articles in the user's active-tag set,
 * ordered newest-first. Excludes anything in `article_reads` for that
 * user. Returns `[]` on empty `userTags` or D1 error (defensive — the
 * dispatcher renders the static fallback on empty headlines).
 */
export async function selectUnreadHeadlinesForUser(
  db: D1Database,
  userId: string,
  userTags: string[],
  limit: number,
): Promise<Headline[]> {
  if (userTags.length === 0) return [];
  const tagPlaceholders = userTags.map((_, i) => `?${i + 2}`).join(', ');
  const limitPlaceholder = `?${userTags.length + 2}`;
  const sql = `
    SELECT a.id, a.title, a.primary_source_name AS source_name,
           a.primary_source_url
      FROM articles a
     WHERE a.id IN (
       SELECT DISTINCT article_id FROM article_tags WHERE tag IN (${tagPlaceholders})
     )
       AND NOT EXISTS (
         SELECT 1 FROM article_reads rd
          WHERE rd.article_id = a.id AND rd.user_id = ?1
       )
     ORDER BY a.ingested_at DESC, a.published_at DESC
     LIMIT ${limitPlaceholder}
  `;
  try {
    const result = await db
      .prepare(sql)
      .bind(userId, ...userTags, limit)
      .all<HeadlineRow>();
    const rows = result.results ?? [];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      source_name: row.source_name,
      slug: slugify(row.title),
      primary_source_url: row.primary_source_url,
    }));
  } catch {
    return [];
  }
}

/**
 * Per-tag article counts over articles ingested since {@link sinceUnix}
 * whose tag intersects the user's active tag set. Also returns the
 * total distinct article count over the same window.
 *
 * Sorted DESC by count then ASC by tag for stable output (the renderer
 * picks the top 3 for the dynamic subject line). Empty tally and zero
 * total for empty `userTags`.
 */
export async function tagTallySinceMidnight(
  db: D1Database,
  userTags: string[],
  sinceUnix: number,
): Promise<{ totalArticles: number; tally: TagTally[] }> {
  if (userTags.length === 0) return { totalArticles: 0, tally: [] };
  const tagPlaceholders = userTags.map((_, i) => `?${i + 2}`).join(', ');

  const tallySql = `
    SELECT at.tag AS tag, COUNT(DISTINCT at.article_id) AS count
      FROM article_tags at
      JOIN articles a ON a.id = at.article_id
     WHERE at.tag IN (${tagPlaceholders}) AND a.ingested_at >= ?1
     GROUP BY at.tag
     ORDER BY count DESC, tag ASC
  `;

  const totalSql = `
    SELECT COUNT(DISTINCT a.id) AS total
      FROM articles a
     WHERE a.ingested_at >= ?1
       AND a.id IN (
         SELECT DISTINCT article_id FROM article_tags WHERE tag IN (${tagPlaceholders})
       )
  `;

  try {
    const [tallyRes, totalRes] = await Promise.all([
      db
        .prepare(tallySql)
        .bind(sinceUnix, ...userTags)
        .all<TallyRow>(),
      db
        .prepare(totalSql)
        .bind(sinceUnix, ...userTags)
        .first<TotalRow>(),
    ]);
    const tally = (tallyRes.results ?? []).map((r) => ({ tag: r.tag, count: r.count }));
    const totalArticles = totalRes !== null ? totalRes.total : 0;
    return { totalArticles, tally };
  } catch {
    return { totalArticles: 0, tally: [] };
  }
}
