// Implements REQ-SET-001
// Implements REQ-SET-002
// Implements REQ-SET-003
// Implements REQ-SET-004
// Implements REQ-SET-005
// Implements REQ-SET-006
// Implements REQ-AUTH-001
//
// GET /api/settings — return the authenticated user's settings snapshot
// plus a `first_run` boolean derived from the onboarding-complete rule.
// PUT /api/settings — validate every field server-side and persist.
//
// Validation invariants (REQ-SET-002/003/004/005):
//   - hashtags: array of strings, each matching /^[a-z0-9-]{2,32}$/,
//     non-empty, max 25, deduplicated.
//   - digest_hour: integer 0..23.
//   - digest_minute: integer 0..59.
//   - tz: valid IANA timezone per `isValidTz`.
//   - model_id: present in the hardcoded `MODELS` catalog.
//   - email_enabled: boolean.
//
// On a successful PUT, any hashtag in the new set that does not yet have
// a `sources:<tag>` KV entry is queued for background discovery by
// INSERTing a `pending_discoveries` row (user scoped, idempotent via
// INSERT OR IGNORE). The response's `discovering` field lists those tags
// so the UI can surface a "sources being discovered" note.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { log } from '~/lib/log';
import { MODELS } from '~/lib/models';
import {
  enforceRateLimit,
  rateLimitResponse,
  RATE_LIMIT_RULES,
} from '~/lib/rate-limit';
import { parseHashtags as parseHashtagsJson } from '~/lib/hashtags';
import { hasCuratedSource } from '~/lib/curated-sources';
import { isValidTz } from '~/lib/tz';
import { requireSession } from '~/middleware/auth';
import { checkOrigin, originOf } from '~/middleware/origin-check';

/**
 * Regex enforcing the hashtag character set and length. Matches the
 * spec AC literally — 2..32 chars, lowercase letters, digits, or hyphen.
 * Anchored so a partial match does not satisfy the check.
 */
export const HASHTAG_REGEX = /^[a-z0-9-]{2,32}$/;

/** Maximum hashtags per user (REQ-SET-002 AC 6).
 *  Sized to give new accounts headroom above the default seed; the
 *  spec AC tracks the actual gap. */
export const MAX_HASHTAGS = 25;

/** Shape accepted from the PUT body. All fields are `unknown` because the
 *  body arrives untyped — validation narrows types field-by-field. */
interface PutSettingsBody {
  hashtags?: unknown;
  digest_hour?: unknown;
  digest_minute?: unknown;
  tz?: unknown;
  model_id?: unknown;
  email_enabled?: unknown;
}

/** Shape of the users row subset we read on GET. */
interface UserSettingsRow {
  hashtags_json: string | null;
  digest_hour: number | null;
  digest_minute: number;
  tz: string;
  model_id: string | null;
  email_enabled: number;
}


/**
 * Normalize a single user-typed hashtag:
 *   1. strip a leading `#`
 *   2. lowercase
 *   3. drop every character not in [a-z0-9-]
 * The result is not checked against the 2..32 length bounds here —
 * callers validate that with {@link HASHTAG_REGEX} after collecting the
 * full list, so error messages can reference the original input.
 */
export function normalizeHashtag(raw: string): string {
  const lowered = raw.toLowerCase();
  const unHashed = lowered.startsWith('#') ? lowered.slice(1) : lowered;
  // Replace anything outside the allowed set with empty string. Using a
  // regex avoids a per-char loop on the hot path.
  return unHashed.replace(/[^a-z0-9-]/g, '');
}

/**
 * Validate and normalize the hashtags payload. Returns either a cleaned
 * deduplicated array or an error code on the first failure.
 */
export function validateHashtags(value: unknown): { ok: true; tags: string[] } | { ok: false } {
  if (!Array.isArray(value)) return { ok: false };
  if (value.length === 0) return { ok: false };

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return { ok: false };
    const normalized = normalizeHashtag(raw);
    if (!HASHTAG_REGEX.test(normalized)) return { ok: false };
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  if (out.length === 0) return { ok: false };
  if (out.length > MAX_HASHTAGS) return { ok: false };
  return { ok: true, tags: out };
}

/**
 * Type guard for strict integer-in-range (the `Number.isInteger` alone
 * accepts NaN-like edge cases via coerce). Takes `unknown` because body
 * input has never been narrowed.
 */
function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/**
 * Identify tags in {@link incoming} that do not yet have a
 * `sources:<tag>` KV entry AND are not already covered by the curated
 * source registry. Tags covered by a curated source short-circuit
 * discovery — see {@link hasCuratedSource} for the rationale (REQ-DISC-001
 * AC 1). Runs the lookups in parallel since KV `get` is a network call
 * per tag.
 */
export async function findTagsNeedingDiscovery(
  kv: KVNamespace,
  incoming: string[],
): Promise<string[]> {
  const results = await Promise.all(
    incoming.map(async (tag) => {
      if (hasCuratedSource(tag)) return null;
      const hit = await kv.get(`sources:${tag}`);
      return hit === null ? tag : null;
    }),
  );
  return results.filter((t): t is string => t !== null);
}

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return errorResponse('app_not_configured');
  }

  const auth = await requireSession(context.request, env);
  if (!auth.ok) return auth.response;

  let row: UserSettingsRow | null;
  try {
    row = await env.DB.prepare(
      'SELECT hashtags_json, digest_hour, digest_minute, tz, model_id, email_enabled FROM users WHERE id = ?1',
    )
      .bind(auth.user.id)
      .first<UserSettingsRow>();
  } catch (err) {
    log('error', 'settings.update.failed', {
      user_id: auth.user.id,
      op: 'read',
      error_code: 'internal_error',
      detail: String(err).slice(0, 500),
    });
    return errorResponse('internal_error');
  }

  if (row === null) {
    return errorResponse('unauthorized');
  }

  const hashtags = parseHashtagsJson(row.hashtags_json);
  const firstRun = row.hashtags_json === null || row.digest_hour === null;

  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  for (const c of auth.cookiesToSet) headers.append('Set-Cookie', c);

  return new Response(
    JSON.stringify({
      hashtags,
      digest_hour: row.digest_hour,
      digest_minute: row.digest_minute,
      tz: row.tz,
      model_id: row.model_id,
      email_enabled: row.email_enabled === 1,
      first_run: firstRun,
    }),
    { status: 200, headers },
  );
}

export async function PUT(context: APIContext): Promise<Response> {
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

  // CF-028: PUT /api/settings is a parallel write path for hashtags
  // alongside POST /api/tags{,/restore,/delete-initial}. Rate-limit
  // here too so the per-user TAGS_MUTATION cap can't be bypassed by
  // routing the same write through this endpoint.
  const rl = await enforceRateLimit(
    env,
    RATE_LIMIT_RULES.TAGS_MUTATION,
    `user:${auth.user.id}`,
  );
  if (!rl.ok) {
    return rateLimitResponse(rl.retryAfter);
  }

  let body: PutSettingsBody;
  try {
    body = (await context.request.json()) as PutSettingsBody;
  } catch {
    return errorResponse('bad_request');
  }

  // REQ-SET-002 — hashtags. Hashtags are now managed on the /digest page
  // (tag strip at top) via POST /api/tags. PUT /api/settings only handles
  // them when the caller explicitly includes a `hashtags` field — this
  // keeps the endpoint usable from older clients and from tests without
  // requiring every caller to re-send them.
  let hashtags: string[] | null = null;
  if (body.hashtags !== undefined) {
    const tagsCheck = validateHashtags(body.hashtags);
    if (!tagsCheck.ok) {
      return errorResponse('invalid_hashtags');
    }
    hashtags = tagsCheck.tags;
  }

  // REQ-SET-003 — schedule (hour + minute + tz)
  if (!isIntegerInRange(body.digest_hour, 0, 23)) {
    return errorResponse('invalid_time');
  }
  if (!isIntegerInRange(body.digest_minute, 0, 59)) {
    return errorResponse('invalid_time');
  }
  const digestHour = body.digest_hour;
  const digestMinute = body.digest_minute;

  if (
    typeof body.tz !== 'string' ||
    body.tz === '' ||
    !isValidTz(body.tz)
  ) {
    return errorResponse('invalid_tz');
  }
  const tz = body.tz;

  // REQ-SET-004 — model_id must be a catalog entry
  if (
    typeof body.model_id !== 'string' ||
    !MODELS.some((m) => m.id === body.model_id)
  ) {
    return errorResponse('invalid_model_id');
  }
  const modelId = body.model_id;

  // REQ-SET-005 — email_enabled must be a strict boolean
  if (typeof body.email_enabled !== 'boolean') {
    return errorResponse('invalid_email_enabled');
  }
  const emailEnabledInt = body.email_enabled ? 1 : 0;

  const nowSec = Math.floor(Date.now() / 1000);

  try {
    if (hashtags !== null) {
      const hashtagsJson = JSON.stringify(hashtags);
      await env.DB.prepare(
        'UPDATE users SET hashtags_json = ?1, digest_hour = ?2, digest_minute = ?3, tz = ?4, model_id = ?5, email_enabled = ?6 WHERE id = ?7',
      )
        .bind(hashtagsJson, digestHour, digestMinute, tz, modelId, emailEnabledInt, auth.user.id)
        .run();
    } else {
      await env.DB.prepare(
        'UPDATE users SET digest_hour = ?1, digest_minute = ?2, tz = ?3, model_id = ?4, email_enabled = ?5 WHERE id = ?6',
      )
        .bind(digestHour, digestMinute, tz, modelId, emailEnabledInt, auth.user.id)
        .run();
    }
  } catch (err) {
    log('error', 'settings.update.failed', {
      user_id: auth.user.id,
      op: 'write',
      error_code: 'internal_error',
      detail: String(err).slice(0, 500),
    });
    return errorResponse('internal_error');
  }

  // Queue discovery for any hashtags that do not yet have KV source
  // entries. Failures here are logged but do not fail the save — the
  // discovery cron will pick them up later, and worst case the user
  // re-saves after the next deploy.
  let discovering: string[] = [];
  try {
    discovering = hashtags !== null ? await findTagsNeedingDiscovery(env.KV, hashtags) : [];
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
    // Keep `discovering` as whatever we resolved; the save itself
    // succeeded, so we fall through to the 200 below.
  }

  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  for (const c of auth.cookiesToSet) headers.append('Set-Cookie', c);
  return new Response(
    JSON.stringify({ ok: true, discovering }),
    { status: 200, headers },
  );
}

/**
 * Native form-POST fallback for /api/settings.
 *
 * The settings page primarily POSTs JSON via fetch from a JS submit
 * handler, but if that handler ever fails to bind (CSP block, mobile
 * webview quirks, ClientRouter race), the browser would default to a
 * GET on the form's current URL with values as query params — silently
 * losing every save. The form now declares `method="post"
 * action="/api/settings"`, so the unhandled native submit hits this
 * POST path with a `application/x-www-form-urlencoded` body.
 *
 * This handler reads the form fields, coerces them to the same shape
 * PUT validates, runs the same persistence logic, and returns a 303
 * redirect back to /settings so the page reloads with the new values.
 */
export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  // Native form submissions can't render JSON error bodies — the browser
  // would navigate to the JSON and show raw text. Every error path here
  // 303-redirects back to /settings?error=<code> so the page can render
  // the error inline and the user keeps editing without re-typing.
  const fail = (code: string): Response =>
    new Response(null, {
      status: 303,
      headers: { Location: `/settings?error=${encodeURIComponent(code)}` },
    });

  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return fail('app_not_configured');
  }
  const appOrigin = originOf(env.APP_URL);

  const originResult = checkOrigin(context.request, appOrigin);
  if (!originResult.ok) {
    return fail('forbidden_origin');
  }

  // Unauthenticated users can't see /settings, so the redirect target
  // would itself bounce to /. That's the right answer: send them
  // somewhere they can re-authenticate, not to a JSON blob.
  const auth = await requireSession(context.request, env, () =>
    new Response(null, { status: 303, headers: { Location: '/' } }),
  );
  if (!auth.ok) return auth.response;

  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return fail('bad_request');
  }

  // The form sends `hour` and `minute` as separate fields (two
  // <select>s on the page — see settings.astro for why we don't use
  // <input type="time">). We also accept the legacy single `time`
  // HH:MM string for back-compat with any stale page in flight when
  // this deploys.
  //
  // Precedence: when both shapes are present, `hour`+`minute` wins —
  // the fresh UI submits both because the form posts every field, and
  // a stale `<input name="time">` cannot exist in the same payload as
  // the new selects unless the page is mid-roll. Treat empty strings
  // as "field absent" so a stale page that submits `hour=""&time="07:45"`
  // still falls through to the legacy parse and saves the right value.
  const hourRaw = form.get('hour');
  const minuteRaw = form.get('minute');
  const timeRaw = form.get('time');
  const tzRaw = form.get('tz');
  const modelIdRaw = form.get('model_id');
  // Native HTML form checkboxes only appear in the FormData when checked.
  const emailEnabled = form.get('email_enabled') !== null;
  const hasFreshFields =
    typeof hourRaw === 'string' && hourRaw !== '' &&
    typeof minuteRaw === 'string' && minuteRaw !== '';
  let hourStr = '';
  let minuteStr = '';
  if (hasFreshFields) {
    hourStr = hourRaw as string;
    minuteStr = minuteRaw as string;
  } else if (typeof timeRaw === 'string') {
    [hourStr = '', minuteStr = ''] = timeRaw.split(':');
  }
  const digestHour = Number.parseInt(hourStr, 10);
  const digestMinute = Number.parseInt(minuteStr, 10);

  if (!isIntegerInRange(digestHour, 0, 23) || !isIntegerInRange(digestMinute, 0, 59)) {
    return fail('invalid_time');
  }
  if (typeof tzRaw !== 'string' || tzRaw === '' || !isValidTz(tzRaw)) {
    return fail('invalid_tz');
  }
  if (typeof modelIdRaw !== 'string' || !MODELS.some((m) => m.id === modelIdRaw)) {
    return fail('invalid_model_id');
  }

  const tz = tzRaw;
  const modelId = modelIdRaw;
  const emailEnabledInt = emailEnabled ? 1 : 0;

  try {
    await env.DB.prepare(
      'UPDATE users SET digest_hour = ?1, digest_minute = ?2, tz = ?3, model_id = ?4, email_enabled = ?5 WHERE id = ?6',
    )
      .bind(digestHour, digestMinute, tz, modelId, emailEnabledInt, auth.user.id)
      .run();
  } catch (err) {
    log('error', 'settings.update.failed', {
      user_id: auth.user.id,
      op: 'write',
      error_code: 'internal_error',
      detail: String(err).slice(0, 500),
    });
    return fail('internal_error');
  }

  const headers = new Headers({ Location: '/settings?saved=ok' });
  for (const c of auth.cookiesToSet) headers.append('Set-Cookie', c);
  return new Response(null, { status: 303, headers });
}
