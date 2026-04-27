// Implements REQ-SET-002
// Implements REQ-AUTH-001
// Implements REQ-AUTH-003
//
// POST /api/tags — replace the authenticated user's hashtag list.
//
// Introduced when the tag editor moved out of /settings and into the
// top of /digest. The /settings form now controls schedule + delivery
// only; this endpoint is the sole write path for hashtags.
//
// Request body: `{ "tags": ["cloudflare", "llm", ...] }`
// Validation is identical to PUT /api/settings (reused from that file):
//   - 2..32 chars per tag, [a-z0-9-] only
//   - 1..MAX_HASHTAGS entries, deduplicated, normalised
// New tags (not yet in KV sources) are queued for discovery the same
// way PUT /api/settings does.

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
import {
  validateHashtags,
  findTagsNeedingDiscovery,
} from '~/pages/api/settings';

interface TagsBody {
  tags?: unknown;
}

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

  const auth = await requireSession(context.request, env);
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

  let body: TagsBody;
  try {
    body = (await context.request.json()) as TagsBody;
  } catch {
    return errorResponse('bad_request');
  }

  const check = validateHashtags(body.tags);
  if (!check.ok) {
    return errorResponse('invalid_hashtags');
  }
  const tags = check.tags;

  try {
    await env.DB
      .prepare('UPDATE users SET hashtags_json = ?1 WHERE id = ?2')
      .bind(JSON.stringify(tags), auth.user.id)
      .run();
  } catch (err) {
    log('error', 'settings.update.failed', {
      user_id: auth.user.id,
      op: 'tags-write',
      error_code: 'internal_error',
      detail: String(err).slice(0, 500),
    });
    return errorResponse('internal_error');
  }

  // Queue discovery for any new tags not yet in KV sources. Best-effort
  // — a failure here doesn't fail the write. Mirror of PUT /api/settings.
  const nowSec = Math.floor(Date.now() / 1000);
  let discovering: string[] = [];
  try {
    discovering = await findTagsNeedingDiscovery(env.KV, tags);
    if (discovering.length > 0) {
      const stmts = discovering.map((tag) =>
        env.DB.prepare(
          'INSERT OR IGNORE INTO pending_discoveries (user_id, tag, added_at) VALUES (?1, ?2, ?3)',
        ).bind(auth.user.id, tag, nowSec),
      );
      await env.DB.batch(stmts);
      log('info', 'discovery.queued', {
        user_id: auth.user.id,
        tags: discovering,
      });
    }
  } catch (err) {
    log('error', 'discovery.queued', {
      user_id: auth.user.id,
      error_code: 'discovery_enqueue_failed',
      detail: String(err).slice(0, 500),
    });
  }

  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  for (const c of auth.cookiesToSet) headers.append('Set-Cookie', c);
  return new Response(
    JSON.stringify({ ok: true, tags, discovering }),
    { status: 200, headers },
  );
}
