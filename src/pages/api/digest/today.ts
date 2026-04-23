// Implements REQ-READ-001
//
// GET /api/digest/today — returns the 30 most recent articles from the
// GLOBAL article pool filtered by the authenticated user's active
// hashtags, plus metadata about the most recent completed scrape_run so
// the dashboard can render the "Last updated at HH:MM · Next update in
// Xm Ys" header.
//
// Response shape:
//   {
//     articles: [
//       {
//         id, title, details: string[],
//         primary_source_name, primary_source_url, published_at,
//         tags: string[], alt_source_count: number,
//         starred: boolean, read: boolean
//       },
//       ...
//     ],
//     last_scrape_run: {
//       id, started_at, finished_at, status
//     } | null,
//     next_scrape_at: number  // unix seconds of the next `0 */4 * * *` UTC tick
//   }

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { loadSession } from '~/middleware/auth';
import { slugify } from '~/lib/slug';

/** Raw row shape for the global-pool article query. */
interface ArticleRow {
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

interface ScrapeRunRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
}

/** Parse the stored `hashtags_json` column into a string array. Returns
 * `[]` when the column is null, empty, or malformed. */
function parseHashtags(hashtagsJson: string | null): string[] {
  if (hashtagsJson === null || hashtagsJson === '') return [];
  try {
    const parsed = JSON.parse(hashtagsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

/** Parse a JSON-encoded string array column (`tags_json`, `details_json`).
 * Returns `[]` on null / malformed input. */
function parseStringArray(json: string | null): string[] {
  if (json === null || json === '') return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
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
  /** Unix seconds of the next `0 */4 * * *` UTC cron tick. Always a
   *  real timestamp — the countdown renders even when lastRun is null
   *  because the schedule is independent of any completed run. */
  next_scrape_at: number;
}

/**
 * Load the dashboard payload for a user — the 30 newest articles from
 * the global pool whose tag set intersects the user's active tags, plus
 * the most recent `ready` scrape_run metadata.
 *
 * Exported so `src/pages/digest.astro` can call it in-process without
 * a subrequest hop; the HTTP GET handler below is a thin wrapper.
 */
export async function loadTodayPayload(
  db: D1Database,
  userId: string,
  userTags: string[],
): Promise<TodayResponse> {
  // Query the most recent `ready` scrape_run regardless of whether the
  // user has tags — the header still renders a countdown when tags are
  // empty so the user sees something useful.
  let lastRun: ScrapeRunRow | null;
  try {
    lastRun = await db
      .prepare(
        `SELECT id, started_at, finished_at, status FROM scrape_runs
          WHERE status = 'ready' ORDER BY started_at DESC LIMIT 1`,
      )
      .first<ScrapeRunRow>();
  } catch {
    lastRun = null;
  }

  // Cron fires every 4 hours at the top of the hour UTC — 00, 04, 08,
  // 12, 16, 20. The next tick from "now" is the next one of those
  // that's strictly in the future. Wrapping to 24 rolls to tomorrow
  // 00:00 UTC.
  const nextScrapeAt = computeNextScrapeAt();

  // No tags → nothing to show. Return the run metadata so the header
  // countdown still renders, but articles is empty.
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
     ORDER BY a.published_at DESC
     LIMIT 30
  `;

  let rows: ArticleRow[] = [];
  try {
    const result = await db
      .prepare(sql)
      .bind(userId, ...userTags)
      .all<ArticleRow>();
    rows = result.results ?? [];
  } catch {
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
  // Round hour UP to the next multiple of 4. If we're currently at a
  // quadrant-hour with :00 minutes exactly, advance past it too so the
  // countdown always shows a positive delta.
  const h = next.getUTCHours();
  let nextHour = Math.ceil((h + (next.getTime() === now.getTime() ? 1 : 0)) / 4) * 4;
  // Strictly-in-the-future guard: if now.getUTCMinutes()/sec are 0
  // and we landed on the same hour, bump by 4.
  if (nextHour <= h) nextHour += 4;
  if (nextHour >= 24) {
    next.setUTCDate(next.getUTCDate() + 1);
    nextHour = nextHour - 24;
  }
  next.setUTCHours(nextHour, 0, 0, 0);
  return Math.floor(next.getTime() / 1000);
}

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return errorResponse('app_not_configured');
  }

  const session = await loadSession(context.request, env.DB, env.OAUTH_JWT_SECRET);
  if (session === null) {
    return errorResponse('unauthorized');
  }

  const userId = session.user.id;
  const userTags = parseHashtags(session.user.hashtags_json);

  const payload = await loadTodayPayload(env.DB, userId, userTags);

  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  if (session.refreshCookie !== null) {
    headers.append('Set-Cookie', session.refreshCookie);
  }

  return new Response(JSON.stringify(payload), { status: 200, headers });
}
