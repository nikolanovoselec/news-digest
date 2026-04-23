// Implements REQ-HIST-002
//
// GET /api/stats — five aggregated tiles for the settings widget:
//   { digests_generated, articles_read, articles_total,
//     tokens_consumed, cost_usd }
//
// Semantics after the global-feed rework:
//   - digests_generated = COUNT(*) FROM scrape_runs WHERE status='ready'
//     (GLOBAL — one tick = one generation event, shown to every user)
//   - tokens_consumed   = SUM(tokens_in + tokens_out) FROM scrape_runs
//     (GLOBAL — the hourly pipeline runs once for everyone)
//   - cost_usd          = SUM(estimated_cost_usd) FROM scrape_runs
//     (GLOBAL — same rationale)
//   - articles_total    = distinct articles in the global pool matching
//     any user tag (per-user via article_tags JOIN)
//   - articles_read     = COUNT(*) FROM article_reads WHERE user_id
//     (per-user)
//
// Every query runs in parallel through `Promise.all`. Article queries
// bind the session user_id so a caller can never read another user's
// read-state.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { loadSession } from '~/middleware/auth';

interface CountRow {
  n: number | null;
}

interface SumRow {
  n: number | null;
}

/** Parse the stored `hashtags_json` user column into a bare string list. */
function parseHashtags(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
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

  try {
    // Build the articles_total query dynamically so an empty tag set
    // returns 0 without having to bind an empty IN clause (which SQLite
    // rejects).
    const tagPlaceholders = userTags.map((_, i) => `?${i + 1}`).join(', ');
    const articlesTotalPromise =
      userTags.length === 0
        ? Promise.resolve<CountRow | null>({ n: 0 })
        : env.DB
            .prepare(
              `SELECT COUNT(DISTINCT a.id) AS n FROM articles a
                WHERE a.id IN (
                  SELECT DISTINCT article_id FROM article_tags WHERE tag IN (${tagPlaceholders})
                )`,
            )
            .bind(...userTags)
            .first<CountRow>();

    const [digestsRow, articlesReadRow, articlesTotalRow, tokensRow, costRow] =
      await Promise.all([
        env.DB
          .prepare(`SELECT COUNT(*) AS n FROM scrape_runs WHERE status = 'ready'`)
          .first<CountRow>(),
        env.DB
          .prepare(`SELECT COUNT(*) AS n FROM article_reads WHERE user_id = ?1`)
          .bind(userId)
          .first<CountRow>(),
        articlesTotalPromise,
        env.DB
          .prepare(
            `SELECT COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)), 0) AS n
             FROM scrape_runs`,
          )
          .first<SumRow>(),
        env.DB
          .prepare(
            `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS n FROM scrape_runs`,
          )
          .first<SumRow>(),
      ]);

    const body = {
      digests_generated: digestsRow?.n ?? 0,
      articles_read: articlesReadRow?.n ?? 0,
      articles_total: articlesTotalRow?.n ?? 0,
      tokens_consumed: tokensRow?.n ?? 0,
      cost_usd: costRow?.n ?? 0,
    };

    const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
    if (session.refreshCookie !== null) {
      headers.append('Set-Cookie', session.refreshCookie);
    }
    return new Response(JSON.stringify(body), { status: 200, headers });
  } catch {
    return errorResponse('internal_error');
  }
}
