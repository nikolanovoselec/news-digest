// Implements REQ-DISC-004
// Implements REQ-AUTH-001
//
// POST /api/admin/discovery/retry-bulk — re-queue every "stuck" tag in one
// shot. A tag is stuck when its `sources:{tag}` KV entry has an empty
// `feeds` array (REQ-DISC-001 exhaustion path or REQ-DISC-003 self-
// healing eviction). Brand-new tags (no entry yet) are NOT stuck and
// are not queued.
//
// Three-layer admin gate (CF-001) replaces the previous loadSession-only
// auth: Cloudflare Access header + session + ADMIN_EMAIL match.
//
// Always native form-submission shaped: this endpoint exists for the
// "Discover missing sources" button on /settings. Scripted callers
// that want to retry a single specific tag should use the per-tag
// /api/admin/discovery/retry endpoint.
//
// Steps:
//   1. Origin check (REQ-AUTH-003 — CSRF defense for state-changing POSTs).
//   2. Session check — anonymous users cannot queue discovery.
//   3. Enumerate the user's saved hashtags.
//   4. For each tag, read `sources:{tag}` from KV. Collect the tags
//      whose feeds list parses to an explicitly empty array.
//   5. For each stuck tag: INSERT OR IGNORE a `pending_discoveries`
//      row in a single D1 batch FIRST, then clear the KV entries.
//      Order matters — if D1 throws we return 500 without altering
//      KV, so a retry is a no-op repeat; if KV cleanup throws after
//      the D1 commit, the cron's own write replaces the stale entry
//      on its next pass. See the inline comment in the try block for
//      the partial-failure rationale.
//   6. Return 303 → /settings?rediscover=ok&count=N.
//
// Authorisation beyond the session check is gated externally:
// Cloudflare Access protects `/api/admin/*` at the zone level so
// only the admin email can reach this endpoint in production.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { log } from '~/lib/log';
import { loadSession } from '~/middleware/auth';
import { requireAdminSession } from '~/middleware/admin-auth';
import { checkOrigin, originOf } from '~/middleware/origin-check';
import { parseJsonStringArray } from '~/lib/json-string-array';

/** Parse the user's stored hashtags_json (a JSON array of strings,
 *  possibly prefixed with `#`) into a normalised lowercase array.
 *  Mirrors the normalisation used by /api/admin/discovery/retry so a legacy
 *  row carrying mixed-case entries still produces matching KV keys. */
function userHashtags(hashtagsJson: string | null): string[] {
  const out: string[] = [];
  for (const entry of parseJsonStringArray(hashtagsJson)) {
    const stripped = entry.startsWith('#') ? entry.slice(1) : entry;
    const normalized = stripped.toLowerCase();
    if (normalized !== '' && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/** True iff the parsed `sources:{tag}` value has an explicitly empty
 *  `feeds` array. A missing entry, corrupt JSON, or a `feeds` value
 *  that is anything other than `[]` returns false — those cases are
 *  handled by the regular discovery cron, not by this bulk path. */
function isEmptyFeedsEntry(raw: string | null): boolean {
  if (raw === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object') return false;
  const feeds = (parsed as { feeds?: unknown }).feeds;
  return Array.isArray(feeds) && feeds.length === 0;
}

/** Resolve the user's stuck tags and queue them for re-discovery.
 *  Returns the count of tags queued (0 when none are stuck) or an
 *  error code when D1/KV writes fail. Both POST (form submit) and GET
 *  (Cloudflare Access post-auth callback) reach this via different
 *  request shapes; the action body is identical. */
async function executeRetryBulk(
  env: APIContext['locals']['runtime']['env'],
  userId: string,
  hashtagsJson: string | null,
): Promise<{ ok: true; count: number } | { ok: false; error: 'internal_error' }> {
  const tags = userHashtags(hashtagsJson);

  const stuck: string[] = [];
  const reads = await Promise.all(
    tags.map(async (tag) => {
      try {
        const raw = await env.KV.get(`sources:${tag}`);
        return { tag, empty: isEmptyFeedsEntry(raw) };
      } catch {
        return { tag, empty: false };
      }
    }),
  );
  for (const { tag, empty } of reads) {
    if (empty) stuck.push(tag);
  }

  if (stuck.length === 0) {
    return { ok: true, count: 0 };
  }

  const nowSec = Math.floor(Date.now() / 1000);

  try {
    // Order: D1 batch FIRST, then KV deletes. Partial-failure recovery:
    // if D1 throws we return without having altered KV, so a click
    // remains a no-op and the user can simply retry. If we cleared KV
    // first, a D1 throw would leave the cache empty AND the cron with
    // no row to process — the next button click would observe missing
    // entries (not "stuck"), and the user would be locked out until
    // they re-saved their tags via the regular settings flow.
    const insertStmt = env.DB.prepare(
      'INSERT OR IGNORE INTO pending_discoveries (user_id, tag, added_at) VALUES (?1, ?2, ?3)',
    );
    const statements = stuck.map((tag) => insertStmt.bind(userId, tag, nowSec));
    await env.DB.batch(statements);

    await Promise.all(
      stuck.flatMap((tag) => [
        env.KV.delete(`sources:${tag}`),
        env.KV.delete(`discovery_failures:${tag}`),
      ]),
    );
  } catch (err) {
    log('error', 'discovery.completed', {
      user_id: userId,
      status: 'retry_bulk_failed',
      stuck_count: stuck.length,
      detail: String(err).slice(0, 500),
    });
    return { ok: false, error: 'internal_error' };
  }

  log('info', 'discovery.completed', {
    user_id: userId,
    status: 'retry_bulk_queued',
    count: stuck.length,
  });
  return { ok: true, count: stuck.length };
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return errorResponse('app_not_configured');
  }
  const appOrigin = originOf(env.APP_URL);

  // Three-layer admin gate (CF-001).
  const adminAuth = await requireAdminSession(context);
  if (!adminAuth.ok) return adminAuth.response;

  // Origin check still runs for defence-in-depth.
  const originResult = checkOrigin(context.request, appOrigin);
  if (!originResult.ok) {
    return originResult.response;
  }

  const session = await loadSession(context.request, env.DB, env.OAUTH_JWT_SECRET);
  if (session === null) {
    return errorResponse('unauthorized');
  }

  const result = await executeRetryBulk(env, session.user.id, session.user.hashtags_json);
  if (!result.ok) {
    return errorResponse(result.error);
  }

  const headers = new Headers({
    Location: `/settings?rediscover=ok&count=${result.count}`,
  });
  for (const c of session.cookiesToSet) headers.append('Set-Cookie', c);
  return new Response(null, { status: 303, headers });
}

export async function GET(context: APIContext): Promise<Response> {
  // GET path exists for two callers:
  //   1. Browsers landing here via the Cloudflare Access post-auth
  //      callback — Access intercepts the form's POST, bounces through
  //      SSO, and returns the user as a GET to the original URL. They
  //      should never see raw JSON or a 404; redirect them to /settings
  //      with the same outcome banner the POST path produces.
  //   2. Scripts/curl that explicitly want JSON — they opt in by
  //      sending `Accept: application/json`.
  // Cloudflare Access is the sole authn gate (no Origin check on GET).
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return errorResponse('app_not_configured');
  }
  const appOrigin = originOf(env.APP_URL);

  const wantsJson = (context.request.headers.get('Accept') ?? '').includes('application/json');

  // Three-layer admin gate (CF-001). Browsers landing here without
  // admin clearance get redirected to /settings rather than seeing raw
  // JSON — same UX guarantee the previous comment block relied on.
  const adminAuth = await requireAdminSession(context);
  if (!adminAuth.ok) {
    if (wantsJson) return adminAuth.response;
    return new Response(null, {
      status: 303,
      headers: { Location: `${appOrigin}/settings?rediscover=denied` },
    });
  }

  const session = await loadSession(context.request, env.DB, env.OAUTH_JWT_SECRET);
  if (session === null) {
    if (wantsJson) {
      return errorResponse('unauthorized');
    }
    return new Response(null, {
      status: 303,
      headers: { Location: `${appOrigin}/settings?rediscover=error` },
    });
  }

  const result = await executeRetryBulk(env, session.user.id, session.user.hashtags_json);
  if (!result.ok) {
    if (wantsJson) {
      return new Response(JSON.stringify({ ok: false, error: result.error }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    return new Response(null, {
      status: 303,
      headers: { Location: `${appOrigin}/settings?rediscover=error` },
    });
  }

  if (wantsJson) {
    return new Response(JSON.stringify({ ok: true, count: result.count }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const headers = new Headers({
    Location: `${appOrigin}/settings?rediscover=ok&count=${result.count}`,
  });
  for (const c of session.cookiesToSet) headers.append('Set-Cookie', c);
  return new Response(null, { status: 303, headers });
}
