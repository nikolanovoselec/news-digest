// Implements REQ-READ-001
//
// GET /api/digest/today — thin HTTP wrapper around `loadTodayPayload`
// in `~/lib/digest-today`. The payload contract (article wire shape,
// scrape-run metadata, next_scrape_at countdown) lives in the lib so
// the server-rendered /digest page can consume it directly without
// importing from a sibling API route module.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { requireSession } from '~/middleware/auth';
import { parseHashtags } from '~/lib/hashtags';
import { loadTodayPayload } from '~/lib/digest-today';

// Re-export the wire types so callers that previously imported from
// this file (tests, anything outside src/lib/) keep working without
// a separate code change. The lib is the canonical home.
export {
  loadTodayPayload,
  computeNextScrapeAt,
  type WireArticle,
  type TodayResponse,
  type ScrapeRunRow,
  type ArticleRow,
} from '~/lib/digest-today';

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return errorResponse('app_not_configured');
  }

  const auth = await requireSession(context.request, env);
  if (!auth.ok) return auth.response;

  const userId = auth.user.id;
  const userTags = parseHashtags(auth.user.hashtags_json);

  const payload = await loadTodayPayload(env.DB, userId, userTags);

  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  for (const c of auth.cookiesToSet) headers.append('Set-Cookie', c);

  return new Response(JSON.stringify(payload), { status: 200, headers });
}
