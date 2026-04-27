// Implements REQ-SET-002
// Implements REQ-AUTH-001
// Implements REQ-AUTH-003
//
// POST /api/tags/delete-initial — clear the authenticated user's
// entire hashtag list, regardless of whether a tag came from the
// default seed or was added custom. 303-redirects to /digest. The
// typical flow is "I want a completely custom interest set, not the
// 20 defaults I was seeded with" — previously this required clicking
// × on every default chip, which was hostile UX.
//
// Filename kept as `delete-initial.ts` (and URL as `/api/tags/delete-initial`)
// for git-blame continuity; the semantic shifted from "strip defaults,
// keep customs" to "clear everything" when REQ-SET-002 AC 8 was
// rewritten. Pair with /api/tags/restore to get back to the default
// seed after clearing.
//
// Transport contract: native form submit + 303, same as
// /api/tags/restore so both buttons work with JS disabled or a stale
// SW bundle. No request body is read.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { log } from '~/lib/log';
import {
  enforceRateLimit,
  rateLimitResponse,
  RATE_LIMIT_RULES,
} from '~/lib/rate-limit';
import { requireSession } from '~/middleware/auth';
import { checkOrigin, originOf } from '~/middleware/origin-check';

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return errorResponse('app_not_configured');
  }
  const appOrigin = originOf(env.APP_URL);

  const originResult = checkOrigin(context.request, appOrigin);
  if (!originResult.ok) {
    return originResult.response;
  }

  const auth = await requireSession(context.request, env, () =>
    new Response(null, { status: 303, headers: { Location: '/' } }),
  );
  if (!auth.ok) return auth.response;

  // CF-028: per-user rate-limit on tag-list mutations.
  const rl = await enforceRateLimit(
    env,
    RATE_LIMIT_RULES.TAGS_MUTATION,
    `user:${auth.user.id}`,
  );
  if (!rl.ok) {
    return rateLimitResponse(rl.retryAfter);
  }

  try {
    await env.DB
      .prepare('UPDATE users SET hashtags_json = ?1 WHERE id = ?2')
      .bind('[]', auth.user.id)
      .run();
  } catch (err) {
    log('error', 'settings.update.failed', {
      user_id: auth.user.id,
      op: 'tags-delete-all',
      error_code: 'internal_error',
      detail: String(err).slice(0, 500),
    });
    return errorResponse('internal_error');
  }

  const headers = new Headers({ Location: '/digest' });
  for (const c of auth.cookiesToSet) headers.append('Set-Cookie', c);
  return new Response(null, { status: 303, headers });
}
