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
import { parseHashtags as parseHashtagsJson } from '~/lib/hashtags';
import { TagsPostBodySchema } from '~/lib/schemas/tags';

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

  // CF-013: parse + shape-validate via Zod. The `invalid_hashtags`
  // error code emitted by `validateHashtags` below is preserved by
  // keeping `tags` as `unknown` in the schema; Zod's job here is to
  // reject non-object bodies and unknown extra fields.
  let rawBody: unknown;
  try {
    rawBody = await context.request.json();
  } catch {
    return errorResponse('bad_request');
  }
  const parsed = TagsPostBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse('bad_request');
  }

  const check = validateHashtags(parsed.data.tags);
  if (!check.ok) {
    return errorResponse('invalid_hashtags');
  }
  const tags = check.tags;

  // CF-028: detect first-tag sync before the UPDATE rewrites
  // hashtags_json so brand-new users' enqueues can jump the discovery
  // queue with priority=10. A read failure falls back to priority=0.
  let priorHashtagsJson: string | null = null;
  let priorReadFailed = false;
  try {
    const priorRow = await env.DB
      .prepare('SELECT hashtags_json FROM users WHERE id = ?1')
      .bind(auth.user.id)
      .first<{ hashtags_json: string | null }>();
    priorHashtagsJson = priorRow !== null ? priorRow.hashtags_json : null;
  } catch (err) {
    priorReadFailed = true;
    log('warn', 'settings.update.failed', {
      user_id: auth.user.id,
      op: 'prior_hashtags_read',
      error_code: 'internal_error',
      detail: String(err).slice(0, 500),
    });
  }
  const priorTags = priorReadFailed ? [] : parseHashtagsJson(priorHashtagsJson);
  const isFirstTagSync =
    !priorReadFailed &&
    (priorHashtagsJson === null || priorHashtagsJson === '' || priorTags.length === 0);

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
      // CF-028: first-tag-sync rows get priority=10 so the dedicated
      // discovery cron drains them on the next tick.
      const priority = isFirstTagSync ? 10 : 0;
      const stmts = discovering.map((tag) =>
        env.DB.prepare(
          'INSERT OR IGNORE INTO pending_discoveries (user_id, tag, added_at, priority) VALUES (?1, ?2, ?3, ?4)',
        ).bind(auth.user.id, tag, nowSec, priority),
      );
      await env.DB.batch(stmts);
      log('info', 'discovery.queued', {
        user_id: auth.user.id,
        tags: discovering,
        first_tag_sync: isFirstTagSync,
        priority,
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
