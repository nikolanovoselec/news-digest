// Implements REQ-STAR-002
//
// GET /api/starred — list the session user's starred articles, newest
// star first. Limit 60 (two dashboard pages' worth).
//
// Same auth + response shape as /api/digest/today.ts, minus the
// scrape_run metadata: /starred is not a live feed so there's no
// countdown to drive.
//
// Response:
//   { articles: WireArticle[] }
//
// WireArticle mirrors the shape from today.ts; every row is `starred:
// true` by definition of this endpoint.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { loadSession } from '~/middleware/auth';
import { slugify } from '~/lib/slug';
import { log } from '~/lib/log';
import { parseJsonStringArray as parseStringArray } from '~/lib/json-string-array';

/** Raw row shape returned by the starred-article JOIN. */
interface StarredRow {
  id: string;
  title: string;
  details_json: string | null;
  primary_source_name: string | null;
  primary_source_url: string | null;
  published_at: number | null;
  tags_json: string | null;
  alt_source_count: number | null;
  starred_at: number;
  read: number | null;
}

/** Wire shape — what the /starred view consumes per article. */
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
  starred_at: number;
  read: boolean;
}

export interface StarredResponse {
  articles: WireArticle[];
}

/**
 * Load the user's starred-article list from D1.
 *
 * Exported so `src/pages/starred.astro` can call it in-process without
 * a subrequest hop (same pattern as `loadTodayPayload`).
 */
export async function loadStarredPayload(
  db: D1Database,
  userId: string,
): Promise<StarredResponse> {
  const sql = `
    SELECT a.id, a.title, a.details_json,
           a.primary_source_name, a.primary_source_url, a.published_at,
           (SELECT json_group_array(DISTINCT at.tag)
              FROM article_tags at WHERE at.article_id = a.id) AS tags_json,
           (SELECT COUNT(*) FROM article_sources s WHERE s.article_id = a.id) AS alt_source_count,
           st.starred_at,
           EXISTS(SELECT 1 FROM article_reads rd WHERE rd.article_id = a.id AND rd.user_id = ?1) AS read
      FROM article_stars st
      JOIN articles a ON a.id = st.article_id
     WHERE st.user_id = ?1
     ORDER BY st.starred_at DESC
     LIMIT 60
  `;

  let rows: StarredRow[] = [];
  try {
    const result = await db.prepare(sql).bind(userId).all<StarredRow>();
    rows = result.results ?? [];
  } catch (err) {
    // CF-035 — log before falling through to empty rows so a "no
    // starred articles" UX bug is distinguishable from a real D1
    // failure in the logs.
    log('error', 'starred.query_failed', {
      user_id: userId,
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
    alt_source_count:
      typeof row.alt_source_count === 'number' ? row.alt_source_count : 0,
    starred: true,
    starred_at: row.starred_at,
    read: row.read === 1,
  }));

  return { articles };
}

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return errorResponse('app_not_configured');
  }

  const session = await loadSession(
    context.request,
    env.DB,
    env.OAUTH_JWT_SECRET,
  );
  if (session === null) {
    return errorResponse('unauthorized');
  }

  const payload = await loadStarredPayload(env.DB, session.user.id);

  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  if (session.refreshCookie !== null) {
    headers.append('Set-Cookie', session.refreshCookie);
  }

  return new Response(JSON.stringify(payload), { status: 200, headers });
}
