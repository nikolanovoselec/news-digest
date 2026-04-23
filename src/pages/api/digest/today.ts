// Implements REQ-READ-005
//
// GET /api/digest/today — returns the authenticated user's most recent
// digest along with the articles for that digest and a banner hint for
// the UI.
//
// Response shape:
//   {
//     digest: { ... } | null,
//     articles: [ ... ],
//     live: boolean,                 // digest is in_progress → poll
//     next_scheduled_at: number|null // unix seconds, only set when the
//                                    // most recent digest is not today
//   }
//
// The `next_scheduled_at` field is computed from the user's stored
// digest_hour + digest_minute in their stored tz. If the computed time
// has already passed today, we advance to the same local time tomorrow.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { localDateInTz, localHourMinuteInTz } from '~/lib/tz';
import { loadSession } from '~/middleware/auth';

/** Shape of the digest row we surface to the client. Columns mirror the
 * D1 schema except for the `next_scheduled_at` synthesized field. */
interface DigestRow {
  id: string;
  user_id: string;
  local_date: string;
  generated_at: number;
  execution_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  estimated_cost_usd: number | null;
  model_id: string;
  status: string;
  error_code: string | null;
  trigger: string;
}

interface ArticleRow {
  id: string;
  digest_id: string;
  slug: string;
  source_url: string;
  title: string;
  one_liner: string;
  details_json: string;
  source_name: string | null;
  published_at: number | null;
  rank: number;
  read_at: number | null;
  // Rows written before migration 0002 don't carry this column; D1
  // returns it as null once the column exists, and `undefined` when
  // the test harness omits it entirely.
  tags_json?: string | null;
}

/** Parse a stored `tags_json` column into a string array. Columns
 * written before migration 0002 are NULL (or missing under a test
 * harness) and coerced to []. */
function parseTags(tagsJson: string | null | undefined): string[] {
  if (tagsJson === null || tagsJson === undefined || tagsJson === '') return [];
  try {
    const parsed = JSON.parse(tagsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

/**
 * Compute the next scheduled_at unix second for a user, given their
 * stored schedule. Returns `null` when the user has not picked a
 * digest_hour yet (first-run state). When the target time has already
 * passed for today's local date, we advance by one day.
 */
function computeNextScheduledAt(
  user: { tz: string; digest_hour: number | null; digest_minute: number },
  nowSec: number,
): number | null {
  if (user.digest_hour === null) return null;
  const targetHour = user.digest_hour;
  const targetMinute = user.digest_minute;
  const nowLocal = localHourMinuteInTz(nowSec, user.tz);

  // Minutes since local midnight for both points. If target > now we
  // can schedule today; otherwise we add a day's worth of seconds and
  // let the local-time math stay stable across DST (approximation — a
  // 23h or 25h DST day is ±1 hour off, which is acceptable for a
  // banner countdown).
  const nowMinutes = nowLocal.hour * 60 + nowLocal.minute;
  const targetMinutes = targetHour * 60 + targetMinute;

  const deltaMinutes =
    targetMinutes > nowMinutes
      ? targetMinutes - nowMinutes
      : targetMinutes - nowMinutes + 24 * 60;

  return nowSec + deltaMinutes * 60;
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
  const nowSec = Math.floor(Date.now() / 1000);
  const todayLocal = localDateInTz(nowSec, session.user.tz);

  // Most recent digest for this user (by generated_at). Scoped by
  // user_id so no one can read another user's digest via this route.
  let digest: DigestRow | null;
  try {
    digest = await env.DB
      .prepare(
        `SELECT id, user_id, local_date, generated_at, execution_ms, tokens_in,
                tokens_out, estimated_cost_usd, model_id, status, error_code, trigger
         FROM digests WHERE user_id = ?1
         ORDER BY generated_at DESC LIMIT 1`,
      )
      .bind(userId)
      .first<DigestRow>();
  } catch {
    return errorResponse('internal_error');
  }

  let articles: ArticleRow[] = [];
  if (digest !== null) {
    const rows = await env.DB
      .prepare(
        `SELECT id, digest_id, slug, source_url, title, one_liner, details_json,
                source_name, published_at, rank, read_at, tags_json
         FROM articles WHERE digest_id = ?1 ORDER BY rank ASC`,
      )
      .bind(digest.id)
      .all<ArticleRow>();
    articles = rows.results ?? [];
  }

  // Convert stored `tags_json` into a plain string array per article so
  // clients don't have to re-parse. Keep the original column out of the
  // wire payload — the array form is the only shape the UI consumes.
  const wireArticles = articles.map(({ tags_json, ...rest }) => ({
    ...rest,
    tags: parseTags(tags_json),
  }));

  const isLive = digest !== null && digest.status === 'in_progress';
  const isToday = digest !== null && digest.local_date === todayLocal;

  // When there's a live digest we don't surface a next-scheduled hint
  // — the user is in the middle of watching today's run. Otherwise, if
  // the newest digest is not today's, compute the next scheduled time.
  let nextScheduledAt: number | null = null;
  if (!isLive && !isToday) {
    nextScheduledAt = computeNextScheduledAt(session.user, nowSec);
  }

  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  if (session.refreshCookie !== null) {
    headers.append('Set-Cookie', session.refreshCookie);
  }

  return new Response(
    JSON.stringify({
      digest,
      articles: wireArticles,
      live: isLive,
      next_scheduled_at: nextScheduledAt,
    }),
    { status: 200, headers },
  );
}
