// Implements REQ-HIST-001
//
// GET /api/history — day-grouped view of the last 7 days of articles
// that match the authenticated user's active tags, plus per-day
// aggregates from `scrape_runs` (token/cost/ingested sums and the list
// of individual ticks for expansion).
//
// The handler produces at most 7 day-groups, keyed by the user's
// timezone (users.tz) so rows flip over at local midnight rather than
// UTC midnight. Articles are filtered to the user's active tags via the
// `article_tags` join; scrape_runs are global (one tick affects every
// user) so they are returned as-is.
//
// Response shape:
//   { days: [
//       { local_date, article_count, articles[], ticks[],
//         day_tokens_in, day_tokens_out, day_cost_usd,
//         day_articles_ingested }
//     ] }
//
// Days are sorted local_date DESC. Empty days (no articles, no ticks)
// are omitted entirely; only days where something happened land in the
// response.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { log } from '~/lib/log';
import { loadSession } from '~/middleware/auth';
import { localDateInTz, DEFAULT_TZ } from '~/lib/tz';
import { parseJsonStringArray as parseStringArray } from '~/lib/json-string-array';
import { parseHashtags } from '~/lib/hashtags';

/** 7 days of history per REQ-HIST-001 AC 1. */
const WINDOW_SECONDS = 7 * 86_400;

/** Row shape for the articles+tags query. */
interface ArticleRow {
  id: string;
  title: string;
  primary_source_name: string | null;
  primary_source_url: string | null;
  published_at: number;
  ingested_at: number;
  details_json: string | null;
  tags_json: string | null;
}

/** Row shape for the scrape_runs query. */
interface ScrapeRunRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  articles_ingested: number;
  articles_deduped: number;
  tokens_in: number;
  tokens_out: number;
  estimated_cost_usd: number;
  status: string;
}


/** Wire shape for an article inside a day group. */
interface WireArticle {
  id: string;
  title: string;
  primary_source_name: string | null;
  primary_source_url: string | null;
  published_at: number;
  details: string[];
  tags: string[];
}

/** Wire shape for a scrape_runs tick inside a day group. */
interface WireTick {
  id: string;
  started_at: number;
  finished_at: number | null;
  articles_ingested: number;
  tokens_in: number;
  tokens_out: number;
  estimated_cost_usd: number;
  status: string;
}

interface DayGroup {
  local_date: string;
  article_count: number;
  articles: WireArticle[];
  ticks: WireTick[];
  day_tokens_in: number;
  day_tokens_out: number;
  day_cost_usd: number;
  day_articles_ingested: number;
}

interface HistoryResponse {
  days: DayGroup[];
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

  const user = session.user;
  const tz = user.tz === '' ? DEFAULT_TZ : user.tz;
  const userTags = parseHashtags(user.hashtags_json);

  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - WINDOW_SECONDS;

  // --- Articles ---------------------------------------------------------
  // Restrict to articles in the window whose tag set intersects the
  // user's active tags. Placeholders are positional (?1 = window,
  // ?2..?N = tags) so tag slugs are bound, never string-interpolated.
  let articleRows: ArticleRow[] = [];
  if (userTags.length > 0) {
    const tagPlaceholders = userTags.map((_, i) => `?${i + 2}`).join(', ');
    // History groups by `ingested_at` — the day the scrape pipeline
    // processed the article — NOT `published_at` (the feed's original
    // publication timestamp). Rationale: a per-day row on /history
    // ALSO shows tokens / cost / articles-ingested from
    // scrape_runs whose `started_at` falls on that day; those are
    // ingest-side numbers. If we grouped articles by published_at
    // instead, a fresh wipe + rescrape would show articles
    // distributed across ~10 days (feeds return ~10-day backlog)
    // while tokens/cost concentrate on the one or two days the runs
    // actually happened — a misleading schism.
    //
    // Keep selecting `published_at` so the wire payload still emits
    // the feed's real publication time on each card (users read
    // articles by when the news happened); the GROUPING key is
    // ingested_at, the DISPLAY key is published_at.
    const articlesSql =
      `SELECT a.id, a.title, a.primary_source_name, a.primary_source_url, ` +
      `a.published_at, a.ingested_at, a.details_json, ` +
      `(SELECT json_group_array(DISTINCT at.tag) FROM article_tags at ` +
      `WHERE at.article_id = a.id) AS tags_json ` +
      `FROM articles a ` +
      `WHERE a.ingested_at >= ?1 ` +
      `AND a.id IN (SELECT DISTINCT article_id FROM article_tags WHERE tag IN (${tagPlaceholders})) ` +
      `ORDER BY a.ingested_at DESC`;
    try {
      const result = await env.DB
        .prepare(articlesSql)
        .bind(sevenDaysAgo, ...userTags)
        .all<ArticleRow>();
      articleRows = result.results ?? [];
    } catch (err) {
      log('error', 'digest.generation', {
        user_id: user.id,
        op: 'history_articles_read',
        error_code: 'internal_error',
        detail: String(err).slice(0, 500),
      });
      return errorResponse('internal_error');
    }
  }

  // --- Scrape runs ------------------------------------------------------
  // Global — not user-scoped. Every user sees the same tick history.
  let runRows: ScrapeRunRow[] = [];
  try {
    const result = await env.DB
      .prepare(
        `SELECT id, started_at, finished_at, articles_ingested, articles_deduped, ` +
          `tokens_in, tokens_out, estimated_cost_usd, status ` +
          `FROM scrape_runs WHERE started_at >= ?1 ORDER BY started_at DESC`,
      )
      .bind(sevenDaysAgo)
      .all<ScrapeRunRow>();
    runRows = result.results ?? [];
  } catch (err) {
    log('error', 'digest.generation', {
      user_id: user.id,
      op: 'history_runs_read',
      error_code: 'internal_error',
      detail: String(err).slice(0, 500),
    });
    return errorResponse('internal_error');
  }

  // --- Group by local_date ---------------------------------------------
  const dayMap = new Map<string, DayGroup>();

  for (const row of articleRows) {
    // Grouping key = ingested_at (when the pipeline processed the
    // article). published_at stays on the wire payload so cards
    // display the feed's real publication date.
    const localDate = localDateInTz(row.ingested_at, tz);
    const group = upsertDay(dayMap, localDate);
    group.articles.push({
      id: row.id,
      title: row.title,
      primary_source_name: row.primary_source_name,
      primary_source_url: row.primary_source_url,
      published_at: row.published_at,
      details: parseStringArray(row.details_json),
      tags: parseStringArray(row.tags_json),
    });
    group.article_count += 1;
  }

  for (const run of runRows) {
    const localDate = localDateInTz(run.started_at, tz);
    const group = upsertDay(dayMap, localDate);
    group.ticks.push({
      id: run.id,
      started_at: run.started_at,
      finished_at: run.finished_at,
      articles_ingested: run.articles_ingested,
      tokens_in: run.tokens_in,
      tokens_out: run.tokens_out,
      estimated_cost_usd: run.estimated_cost_usd,
      status: run.status,
    });
    group.day_tokens_in += run.tokens_in;
    group.day_tokens_out += run.tokens_out;
    group.day_cost_usd += run.estimated_cost_usd;
    group.day_articles_ingested += run.articles_ingested;
  }

  // Sort the map entries by local_date DESC and take up to 7 day groups.
  const days: DayGroup[] = Array.from(dayMap.values())
    .sort((a, b) => (a.local_date < b.local_date ? 1 : a.local_date > b.local_date ? -1 : 0))
    .slice(0, 7);

  const body: HistoryResponse = { days };

  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  if (session.refreshCookie !== null) {
    headers.append('Set-Cookie', session.refreshCookie);
  }
  return new Response(JSON.stringify(body), { status: 200, headers });
}

/** Lazily create a DayGroup in the map, returning the (possibly
 *  existing) value so callers can append in place. */
function upsertDay(map: Map<string, DayGroup>, localDate: string): DayGroup {
  const existing = map.get(localDate);
  if (existing !== undefined) return existing;
  const fresh: DayGroup = {
    local_date: localDate,
    article_count: 0,
    articles: [],
    ticks: [],
    day_tokens_in: 0,
    day_tokens_out: 0,
    day_cost_usd: 0,
    day_articles_ingested: 0,
  };
  map.set(localDate, fresh);
  return fresh;
}
