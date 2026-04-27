// Implements REQ-READ-005
//
// GET /api/digest/:id — return a specific digest by id, scoped to the
// authenticated user. The same response shape as /api/digest/today
// (digest + articles + live + next_scheduled_at) so the client polling
// code can reuse the loader.
//
// IDOR defense: every SELECT carries `WHERE user_id = ?1 AND id = ?2`,
// so a user cannot fetch another user's digest even by guessing its id.
// A missing row is 404, never a richer "not_yours" — we do not disclose
// whether the id exists for a different user.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { requireSession } from '~/middleware/auth';

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
}

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return errorResponse('app_not_configured');
  }

  const auth = await requireSession(context.request, env);
  if (!auth.ok) return auth.response;

  const rawId = context.params['id'];
  const digestId = typeof rawId === 'string' ? rawId.trim() : '';
  if (digestId === '') {
    return errorResponse('bad_request');
  }

  const userId = auth.user.id;

  // User-scoped SELECT — the `user_id = ?1` filter is mandatory to
  // prevent IDOR. A mismatch returns 404, not 403, to avoid leaking
  // existence of other users' digests.
  let digest: DigestRow | null;
  try {
    digest = await env.DB
      .prepare(
        `SELECT id, user_id, local_date, generated_at, execution_ms, tokens_in,
                tokens_out, estimated_cost_usd, model_id, status, error_code, trigger
         FROM digests WHERE user_id = ?1 AND id = ?2 LIMIT 1`,
      )
      .bind(userId, digestId)
      .first<DigestRow>();
  } catch {
    return errorResponse('internal_error');
  }

  if (digest === null) {
    return errorResponse('not_found');
  }

  let articles: ArticleRow[] = [];
  try {
    const rows = await env.DB
      .prepare(
        `SELECT id, digest_id, slug, source_url, title, one_liner, details_json,
                source_name, published_at, rank, read_at
         FROM articles WHERE digest_id = ?1 ORDER BY rank ASC`,
      )
      .bind(digest.id)
      .all<ArticleRow>();
    articles = rows.results ?? [];
  } catch {
    return errorResponse('internal_error');
  }

  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  for (const c of auth.cookiesToSet) headers.append('Set-Cookie', c);

  return new Response(
    JSON.stringify({
      digest,
      articles,
      live: digest.status === 'in_progress',
      next_scheduled_at: null,
    }),
    { status: 200, headers },
  );
}
