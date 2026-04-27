// Implements REQ-STAR-001
// Implements REQ-AUTH-001
//
// POST /api/articles/:id/star  — star an article for the session user
// DELETE /api/articles/:id/star — unstar
//
// Both verbs are idempotent:
//   - POST uses INSERT OR IGNORE against the (user_id, article_id)
//     primary key on `article_stars`, so repeated POSTs never produce
//     duplicate rows and never error.
//   - DELETE uses a plain DELETE ... WHERE user_id = ?1 AND article_id
//     = ?2; if the row is absent the statement is a no-op.
//
// Every request is protected by:
//   1. Origin check (REQ-AUTH-003) — state-changing verbs MUST carry a
//      matching Origin header.
//   2. Session check — anonymous callers get 401.
//   3. Article-id validation — missing or empty ids return 400.
//
// User-scoping is enforced by the `user_id` bound parameter — a user
// can only toggle their OWN star state for any article id.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { log } from '~/lib/log';
import {
  enforceRateLimit,
  rateLimitResponse,
  RATE_LIMIT_RULES,
} from '~/lib/rate-limit';
import { loadSession } from '~/middleware/auth';
import { checkOrigin, originOf } from '~/middleware/origin-check';

/** Extract and validate the article id path parameter. Returns the id
 *  on success or `null` when the value is missing or empty. */
function readArticleId(context: APIContext): string | null {
  const raw = context.params['id'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return trimmed;
}

/** Shared prelude for both POST and DELETE: origin check, session
 *  load, article-id extraction. Returns either a rejection {@link Response}
 *  or a tuple of the fields handlers need to run the mutation. */
async function authorize(
  context: APIContext,
): Promise<
  | { kind: 'reject'; response: Response }
  | {
      kind: 'ok';
      userId: string;
      articleId: string;
      refreshCookie: string | null;
    }
> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return { kind: 'reject', response: errorResponse('app_not_configured') };
  }
  const appOrigin = originOf(env.APP_URL);

  const originResult = checkOrigin(context.request, appOrigin);
  if (!originResult.ok) {
    return { kind: 'reject', response: originResult.response };
  }

  const session = await loadSession(
    context.request,
    env.DB,
    env.OAUTH_JWT_SECRET,
  );
  if (session === null) {
    return { kind: 'reject', response: errorResponse('unauthorized') };
  }

  const articleId = readArticleId(context);
  if (articleId === null) {
    return { kind: 'reject', response: errorResponse('bad_request') };
  }

  // CF-028: per-user rate-limit on star toggles. The cap (60/min)
  // protects against runaway client retries; legitimate humans never
  // approach it.
  const rl = await enforceRateLimit(
    env,
    RATE_LIMIT_RULES.ARTICLE_STAR,
    `user:${session.user.id}`,
  );
  if (!rl.ok) {
    return { kind: 'reject', response: rateLimitResponse(rl.retryAfter) };
  }

  return {
    kind: 'ok',
    userId: session.user.id,
    articleId,
    refreshCookie: session.refreshCookie,
  };
}

/** Build a successful JSON response with `{ starred: <bool> }` and the
 *  session refresh cookie appended when present. */
function successResponse(starred: boolean, refreshCookie: string | null): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  if (refreshCookie !== null) {
    headers.append('Set-Cookie', refreshCookie);
  }
  return new Response(JSON.stringify({ starred }), { status: 200, headers });
}

export async function POST(context: APIContext): Promise<Response> {
  const auth = await authorize(context);
  if (auth.kind === 'reject') return auth.response;

  const env = context.locals.runtime.env;
  const nowSec = Math.floor(Date.now() / 1000);

  try {
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO article_stars (user_id, article_id, starred_at)
         VALUES (?1, ?2, ?3)`,
      )
      .bind(auth.userId, auth.articleId, nowSec)
      .run();
  } catch (err) {
    log('error', 'article.star.failed', {
      user_id: auth.userId,
      article_id: auth.articleId,
      verb: 'POST',
      detail: String(err).slice(0, 500),
    });
    return errorResponse('internal_error');
  }

  return successResponse(true, auth.refreshCookie);
}

export async function DELETE(context: APIContext): Promise<Response> {
  const auth = await authorize(context);
  if (auth.kind === 'reject') return auth.response;

  const env = context.locals.runtime.env;

  try {
    await env.DB
      .prepare(
        `DELETE FROM article_stars WHERE user_id = ?1 AND article_id = ?2`,
      )
      .bind(auth.userId, auth.articleId)
      .run();
  } catch (err) {
    log('error', 'article.star.failed', {
      user_id: auth.userId,
      article_id: auth.articleId,
      verb: 'DELETE',
      detail: String(err).slice(0, 500),
    });
    return errorResponse('internal_error');
  }

  return successResponse(false, auth.refreshCookie);
}
