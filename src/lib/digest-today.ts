// Implements REQ-READ-001
//
// Dashboard payload loader, factored out of the GET /api/digest/today
// route so the server-rendered /digest page can call it in-process
// WITHOUT importing from a sibling API route module. The route handler
// remains a thin HTTP wrapper around this lib; the page renders by
// calling `loadTodayPayload` directly.
//
// Lane discipline: page → lib + api route → lib. The prior shape
// (page → api route module) inverted the layered architecture and
// fragmented test ownership.

import { slugify } from '~/lib/slug';
import { parseJsonStringArray as parseStringArray } from '~/lib/json-string-array';
import { log } from '~/lib/log';

/** Raw row shape for the global-pool article query. */
export interface ArticleRow {
  id: string;
  canonical_url: string;
  primary_source_name: string | null;
  primary_source_url: string | null;
  title: string;
  details_json: string | null;
  published_at: number | null;
  ingested_at: number | null;
  tags_json: string | null;
  alt_source_count: number | null;
  starred: number | null;
  read: number | null;
}

export interface ScrapeRunRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
}

/** Wire shape — what the dashboard consumes per article. */
export interface WireArticle {
  id: string;
  slug: string;
  title: string;
  details: string[];
  primary_source_name: string | null;
  primary_source_url: string | null;
  published_at: number | null;
  tags: string[];
  alt_source_count: number;
  starred: boolean;
  read: boolean;
}

export interface TodayResponse {
  articles: WireArticle[];
  last_scrape_run: ScrapeRunRow | null;
  /** Unix seconds of the next 4-hour UTC cron tick (00/04/08/12/16/20).
   *  Always a real timestamp — the countdown renders even when
   *  lastRun is null because the schedule is independent of any
   *  completed run. */
  next_scrape_at: number;
}

/**
 * Load the dashboard payload for a user — the 29 most-recently-ingested
 * articles from the global pool whose tag set intersects the user's
 * active tags, plus the most recent `ready` scrape_run metadata. The
 * grid renders those 29 cards and slot 30 is a "see today in Search &
 * History" tile.
 *
 * Ordering is `ingested_at DESC, published_at DESC` (not plain
 * `published_at DESC`) so a new scrape always bubbles its articles to
 * the top of the dashboard. Sorting by feed pubDate alone would let a
 * backlog item published two weeks ago dominate the top whenever it
 * happened to be ingested AFTER a very-recent article whose pubDate
 * was even newer. `ingested_at DESC` makes "newest ingest wins" the
 * primary sort so the feed always feels alive.
 *
 * Per-tag filtering that reaches beyond the newest-29 window lives on
 * Search & History, not here — the dashboard is deliberately a narrow
 * "just the top 29 you haven't seen" view.
 */
export async function loadTodayPayload(
  db: D1Database,
  userId: string,
  userTags: string[],
): Promise<TodayResponse> {
  let lastRun: ScrapeRunRow | null;
  try {
    lastRun = await db
      .prepare(
        `SELECT id, started_at, finished_at, status FROM scrape_runs
          WHERE status = 'ready' ORDER BY started_at DESC LIMIT 1`,
      )
      .first<ScrapeRunRow>();
  } catch (err) {
    // CF-035 — a silent fallback to null hides D1 anomalies that
    // operationally matter (the dashboard countdown stops working).
    log('error', 'digest.today.query_failed', {
      user_id: userId,
      query: 'last_scrape_run',
      detail: String(err).slice(0, 200),
    });
    lastRun = null;
  }

  const nextScrapeAt = computeNextScrapeAt();

  if (userTags.length === 0) {
    return {
      articles: [],
      last_scrape_run: lastRun,
      next_scrape_at: nextScrapeAt,
    };
  }

  // Build the IN clause programmatically so the number of placeholders
  // matches the tag-array length. Parameters are bound 1:1 via
  // positional placeholders (?1 = user_id, ?2..?N = tags) — never
  // string-interpolated — so tag slugs cannot smuggle SQL.
  const tagPlaceholders = userTags.map((_, i) => `?${i + 2}`).join(', ');
  const sql = `
    SELECT a.id, a.canonical_url, a.primary_source_name, a.primary_source_url,
           a.title, a.details_json, a.published_at, a.ingested_at,
           (SELECT json_group_array(DISTINCT at.tag)
              FROM article_tags at WHERE at.article_id = a.id) AS tags_json,
           (SELECT COUNT(*) FROM article_sources s WHERE s.article_id = a.id) AS alt_source_count,
           EXISTS(SELECT 1 FROM article_stars st WHERE st.article_id = a.id AND st.user_id = ?1) AS starred,
           EXISTS(SELECT 1 FROM article_reads rd WHERE rd.article_id = a.id AND rd.user_id = ?1) AS read
      FROM articles a
     WHERE a.id IN (
       SELECT DISTINCT article_id FROM article_tags WHERE tag IN (${tagPlaceholders})
     )
     ORDER BY a.ingested_at DESC, a.published_at DESC
     LIMIT 29
  `;

  let rows: ArticleRow[] = [];
  try {
    const result = await db
      .prepare(sql)
      .bind(userId, ...userTags)
      .all<ArticleRow>();
    rows = result.results ?? [];
  } catch (err) {
    log('error', 'digest.today.query_failed', {
      user_id: userId,
      query: 'articles',
      tag_count: userTags.length,
      detail: String(err).slice(0, 200),
    });
    rows = [];
  }

  const articles: WireArticle[] = rows.map((row) => ({
    id: row.id,
    slug: slugify(row.title),
    title: row.title,
    details: parseStringArray(row.details_json),
    primary_source_name: row.primary_source_name,
    primary_source_url: row.primary_source_url,
    published_at: row.published_at,
    tags: parseStringArray(row.tags_json),
    alt_source_count: typeof row.alt_source_count === 'number' ? row.alt_source_count : 0,
    starred: row.starred === 1,
    read: row.read === 1,
  }));

  return {
    articles,
    last_scrape_run: lastRun,
    next_scrape_at: nextScrapeAt,
  };
}

/**
 * Compute the unix-seconds timestamp of the next scrape cron tick.
 * The schedule is `0 *\/4 * * *` UTC — 00/04/08/12/16/20. Returns the
 * next such time STRICTLY in the future; rolls to tomorrow 00:00 UTC
 * when we're past 20:00.
 *
 * Exported for unit testing so boundary cases (exact quadrant-hour
 * hits, day rollover) can be pinned against a frozen clock.
 */
export function computeNextScrapeAt(): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      0,
      0,
      0,
    ),
  );
  const h = next.getUTCHours();
  let nextHour = Math.ceil((h + (next.getTime() === now.getTime() ? 1 : 0)) / 4) * 4;
  if (nextHour <= h) nextHour += 4;
  if (nextHour >= 24) {
    next.setUTCDate(next.getUTCDate() + 1);
    nextHour = nextHour - 24;
  }
  next.setUTCHours(nextHour, 0, 0, 0);
  return Math.floor(next.getTime() / 1000);
}
