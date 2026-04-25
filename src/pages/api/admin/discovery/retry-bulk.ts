// Implements REQ-DISC-004
//
// POST /api/admin/discovery/retry-bulk — re-queue every "stuck" tag in one
// shot. A tag is stuck when its `sources:{tag}` KV entry has an empty
// `feeds` array (REQ-DISC-001 exhaustion path or REQ-DISC-003 self-
// healing eviction). Brand-new tags (no entry yet) are NOT stuck and
// are not queued.
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
//   5. For each stuck tag: clear the KV entries and INSERT OR IGNORE a
//      `pending_discoveries` row. Single batched D1 statement so all
//      inserts commit or fail together.
//   6. Return 303 → /settings?rediscover=ok&count=N.
//
// Authorisation beyond the session check is gated externally:
// Cloudflare Access protects `/api/admin/*` at the zone level so
// only the admin email can reach this endpoint in production.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { log } from '~/lib/log';
import { loadSession } from '~/middleware/auth';
import { checkOrigin, originOf } from '~/middleware/origin-check';

/** Parse the user's stored hashtags_json (a JSON array of strings,
 *  possibly prefixed with `#`) into a normalised lowercase array.
 *  Mirrors the normalisation used by /api/admin/discovery/retry so a legacy
 *  row carrying mixed-case entries still produces matching KV keys. */
function userHashtags(hashtagsJson: string | null): string[] {
  if (hashtagsJson === null || hashtagsJson === '') return [];
  try {
    const parsed = JSON.parse(hashtagsJson);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string') continue;
      const stripped = entry.startsWith('#') ? entry.slice(1) : entry;
      const normalized = stripped.toLowerCase();
      if (normalized !== '' && !out.includes(normalized)) out.push(normalized);
    }
    return out;
  } catch {
    return [];
  }
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

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return errorResponse('app_not_configured');
  }
  const appOrigin = originOf(env.APP_URL);

  // Origin check first — same defense-in-depth as the per-tag endpoint.
  const originResult = checkOrigin(context.request, appOrigin);
  if (!originResult.ok) {
    return originResult.response!;
  }

  const session = await loadSession(context.request, env.DB, env.OAUTH_JWT_SECRET);
  if (session === null) {
    return errorResponse('unauthorized');
  }

  const userId = session.user.id;
  const tags = userHashtags(session.user.hashtags_json);

  // Read every sources:{tag} entry in parallel and select the empty ones.
  // KV reads are independent so Promise.all is safe here.
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
    // No-op success path — redirect with count=0 so the UI can reassure
    // the operator the click was received and there was simply nothing
    // to do (e.g. they double-clicked or arrived via a stale URL).
    const headers = new Headers({ Location: '/settings?rediscover=ok&count=0' });
    if (session.refreshCookie !== null) {
      headers.append('Set-Cookie', session.refreshCookie);
    }
    return new Response(null, { status: 303, headers });
  }

  const nowSec = Math.floor(Date.now() / 1000);

  try {
    // Clear KV entries (parallel — independent keys).
    await Promise.all(
      stuck.flatMap((tag) => [
        env.KV.delete(`sources:${tag}`),
        env.KV.delete(`discovery_failures:${tag}`),
      ]),
    );

    // Single D1 batch — all INSERT OR IGNORE rows commit or roll back
    // together, so the cron either sees every queued tag or none.
    const insertStmt = env.DB.prepare(
      'INSERT OR IGNORE INTO pending_discoveries (user_id, tag, added_at) VALUES (?1, ?2, ?3)',
    );
    const statements = stuck.map((tag) => insertStmt.bind(userId, tag, nowSec));
    await env.DB.batch(statements);
  } catch (err) {
    log('error', 'discovery.completed', {
      user_id: userId,
      status: 'retry_bulk_failed',
      stuck_count: stuck.length,
      detail: String(err).slice(0, 500),
    });
    return errorResponse('internal_error');
  }

  log('info', 'discovery.completed', {
    user_id: userId,
    status: 'retry_bulk_queued',
    count: stuck.length,
  });

  const headers = new Headers({
    Location: `/settings?rediscover=ok&count=${stuck.length}`,
  });
  if (session.refreshCookie !== null) {
    headers.append('Set-Cookie', session.refreshCookie);
  }
  return new Response(null, { status: 303, headers });
}
