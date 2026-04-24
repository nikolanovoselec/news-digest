// Implements REQ-DISC-004
//
// POST /api/discovery/retry — force a fresh LLM-assisted discovery for
// a tag whose existing `sources:{tag}` entry is empty (or to retry a
// stubborn tag).
//
// The endpoint accepts two body formats:
//   - application/json — body `{"tag":"<tag>"}`; response `{ok: true}`
//     JSON. Used by scripted callers that prefer an API contract.
//   - application/x-www-form-urlencoded — body `tag=<tag>` (native HTML
//     form POST). Response is a 303 See Other redirect to
//     `/settings?rediscover=ok&tag=<tag>` so a plain <form> submission
//     returns the user to the page they came from with a visible
//     confirmation. Chosen over a JS handler because native form POSTs
//     work reliably across Samsung Browser and in-app webviews where
//     JS event handlers are flaky.
//
// Steps (both paths):
//   1. Origin check (REQ-AUTH-003 — CSRF defense for state-changing POSTs).
//   2. Session check — anonymous users cannot queue discovery.
//   3. Validate the tag is in the user's `hashtags_json`; otherwise
//      return HTTP 400 with code `unknown_tag` (prevents blast-radius
//      abuse — you can only retry tags you've already saved).
//   4. DELETE the `sources:{tag}` and `discovery_failures:{tag}` KV
//      entries so the next cron starts fresh.
//   5. INSERT OR IGNORE a `pending_discoveries` row for this
//      `(user_id, tag)` so the next 5-minute cron picks it up.
//
// The endpoint does not perform the discovery itself — the cron is the
// only path that calls Workers AI. Authorisation beyond the session
// check is gated externally: Cloudflare Access protects the route at
// the zone level so only the admin email can reach it in production.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { log } from '~/lib/log';
import { loadSession } from '~/middleware/auth';
import { checkOrigin, originOf } from '~/middleware/origin-check';

interface RetryBody {
  tag?: unknown;
}

/** True when the request looks like a native <form> POST rather than a
 *  JSON API call. Matches `application/x-www-form-urlencoded` and
 *  `multipart/form-data` (either/or — Astro's body parser handles both
 *  via `request.formData()`). The JSON path is the default; only
 *  form-encoded content types switch to the redirect response. */
function isFormEncoded(request: Request): boolean {
  const ct = (request.headers.get('Content-Type') ?? '').toLowerCase();
  return (
    ct.includes('application/x-www-form-urlencoded') ||
    ct.includes('multipart/form-data')
  );
}

/**
 * Parse the user's stored hashtags_json (a JSON array of strings,
 * possibly prefixed with `#`). Returns an empty set for null/invalid
 * JSON so callers always get a stable lookup.
 *
 * Tags are stripped of a leading `#` and lowercased before insertion,
 * matching the normalisation applied on the write path
 * (`HASHTAG_REGEX = /[a-z0-9-]/`). The lookup side lowercases too, so
 * a legacy row carrying mixed-case entries (e.g. `["#AI"]`) still
 * matches a button click posting `tag=ai`.
 */
function userHashtagSet(hashtagsJson: string | null): Set<string> {
  const out = new Set<string>();
  if (hashtagsJson === null || hashtagsJson === '') return out;
  try {
    const parsed = JSON.parse(hashtagsJson);
    if (!Array.isArray(parsed)) return out;
    for (const entry of parsed) {
      if (typeof entry !== 'string') continue;
      const stripped = entry.startsWith('#') ? entry.slice(1) : entry;
      const normalized = stripped.toLowerCase();
      if (normalized !== '') out.add(normalized);
    }
  } catch {
    return out;
  }
  return out;
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return errorResponse('app_not_configured');
  }
  const appOrigin = originOf(env.APP_URL);
  const wantsFormRedirect = isFormEncoded(context.request);

  // Origin check first — the session cookie cannot be presented by a
  // cross-site attacker because SameSite=Lax, but the Origin header is
  // a hardened defense-in-depth layer (REQ-AUTH-003).
  const originResult = checkOrigin(context.request, appOrigin);
  if (!originResult.ok) {
    return originResult.response!;
  }

  const session = await loadSession(context.request, env.DB, env.OAUTH_JWT_SECRET);
  if (session === null) {
    return errorResponse('unauthorized');
  }

  // Body parsing — branch on Content-Type. Both branches produce the
  // same `tag` string for the downstream flow; the only difference is
  // the response shape at the bottom.
  let rawTag = '';
  if (wantsFormRedirect) {
    try {
      const form = await context.request.formData();
      const tagField = form.get('tag');
      rawTag = typeof tagField === 'string' ? tagField.trim() : '';
    } catch {
      return errorResponse('bad_request');
    }
  } else {
    let body: RetryBody;
    try {
      body = (await context.request.json()) as RetryBody;
    } catch {
      return errorResponse('bad_request');
    }
    rawTag = typeof body.tag === 'string' ? body.tag.trim() : '';
  }

  if (rawTag === '') {
    return errorResponse('bad_request');
  }
  // Normalise the submitted tag the same way as the stored set so the
  // membership check is insensitive to leading `#` and case.
  const tag = (rawTag.startsWith('#') ? rawTag.slice(1) : rawTag).toLowerCase();

  // Only retry tags the user has actually saved — otherwise anyone
  // with a session could queue arbitrary LLM calls for arbitrary
  // strings (cost blast radius).
  const userTags = userHashtagSet(session.user.hashtags_json);
  if (!userTags.has(tag)) {
    return errorResponse('unknown_tag');
  }

  const userId = session.user.id;
  const nowSec = Math.floor(Date.now() / 1000);

  try {
    await env.KV.delete(`sources:${tag}`);
    await env.KV.delete(`discovery_failures:${tag}`);
    await env.DB.prepare(
      'INSERT OR IGNORE INTO pending_discoveries (user_id, tag, added_at) VALUES (?1, ?2, ?3)',
    )
      .bind(userId, tag, nowSec)
      .run();
  } catch (err) {
    log('error', 'discovery.completed', {
      tag,
      user_id: userId,
      status: 'retry_queue_failed',
      detail: String(err).slice(0, 500),
    });
    return errorResponse('internal_error');
  }

  log('info', 'discovery.completed', {
    tag,
    user_id: userId,
    status: 'retry_queued',
  });

  // Form POST → 303 redirect back to settings with a confirmation
  // query param the page can render as a toast / inline banner.
  // JSON POST → 200 with {ok: true}.
  if (wantsFormRedirect) {
    const headers = new Headers({
      Location: `/settings?rediscover=ok&tag=${encodeURIComponent(tag)}`,
    });
    if (session.refreshCookie !== null) {
      headers.append('Set-Cookie', session.refreshCookie);
    }
    return new Response(null, { status: 303, headers });
  }

  // If the middleware silent-refresh issued a near-expiry re-issue of
  // the session cookie, pass it through so the client stays logged in.
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  if (session.refreshCookie !== null) {
    headers.append('Set-Cookie', session.refreshCookie);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers,
  });
}
