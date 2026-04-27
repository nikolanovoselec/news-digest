// Implements REQ-SET-002
// Implements REQ-AUTH-001
// Implements REQ-AUTH-003
//
// POST /api/tags/restore — replace the authenticated user's hashtag list
// with the bundled DEFAULT_HASHTAGS and 303-redirect to /digest.
//
// This endpoint exists as a companion to /api/tags so the "Restore
// initial tags" button on /settings can be a plain <form> that works
// with JavaScript disabled, broken, or shadowed by a stale SW bundle.
// No request body is read — the defaults always win, and the 303
// response makes the browser navigate on its own.

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
import { DEFAULT_HASHTAGS } from '~/lib/default-hashtags';
import { findTagsNeedingDiscovery } from '~/pages/api/settings';

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

  const session = await loadSession(context.request, env.DB, env.OAUTH_JWT_SECRET);
  if (session === null) {
    return new Response(null, {
      status: 303,
      headers: { Location: '/' },
    });
  }

  // CF-028: per-user rate-limit on tag-list mutations.
  const rl = await enforceRateLimit(
    env,
    RATE_LIMIT_RULES.TAGS_MUTATION,
    `user:${session.user.id}`,
  );
  if (!rl.ok) {
    return rateLimitResponse(rl.retryAfter);
  }

  const tags = Array.from(DEFAULT_HASHTAGS);

  try {
    await env.DB
      .prepare('UPDATE users SET hashtags_json = ?1 WHERE id = ?2')
      .bind(JSON.stringify(tags), session.user.id)
      .run();
  } catch (err) {
    log('error', 'settings.update.failed', {
      user_id: session.user.id,
      op: 'tags-restore',
      error_code: 'internal_error',
      detail: String(err).slice(0, 500),
    });
    return errorResponse('internal_error');
  }

  // Queue discovery for any defaults not yet in KV sources. Best-effort.
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    const discovering = await findTagsNeedingDiscovery(env.KV, tags);
    if (discovering.length > 0) {
      const stmts = discovering.map((tag) =>
        env.DB.prepare(
          'INSERT OR IGNORE INTO pending_discoveries (user_id, tag, added_at) VALUES (?1, ?2, ?3)',
        ).bind(session.user.id, tag, nowSec),
      );
      await env.DB.batch(stmts);
      log('info', 'discovery.queued', {
        user_id: session.user.id,
        tags: discovering,
      });
    }
  } catch (err) {
    log('error', 'discovery.queued', {
      user_id: session.user.id,
      error_code: 'discovery_enqueue_failed',
      detail: String(err).slice(0, 500),
    });
  }

  const headers = new Headers({ Location: '/digest' });
  for (const c of session.cookiesToSet) headers.append('Set-Cookie', c);
  return new Response(null, { status: 303, headers });
}
