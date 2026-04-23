// Implements REQ-GEN-002
//
// POST /api/digest/refresh — manual digest regeneration.
//
// Flow:
//   1. Origin check (REQ-AUTH-003) — state-changing POST MUST carry a
//      matching Origin header.
//   2. Session check — anonymous callers get 401.
//   3. Atomic rate-limit UPDATE on `users`. A single SQL statement
//      enforces BOTH the 5-minute cooldown AND the 10-per-24h cap with
//      RETURNING so we observe the post-update state without a second
//      read. Zero rows returned → rate limited.
//   4. Conditional INSERT on `digests`. The INSERT includes a NOT EXISTS
//      subquery so two simultaneous clicks cannot both create an
//      `in_progress` row for the same (user, local_date). Zero rows
//      inserted → 409 already_in_progress.
//   5. Enqueue `{ trigger: 'manual', user_id, local_date, digest_id }`
//      to `digest-jobs` and return 202 with the new digest id.
//
// The rate-limit math lives in the SQL so concurrent callers cannot race
// to both pass the window check. The 429 body includes
// `retry_after_seconds` computed post-fact from the current row state so
// the client can display a live countdown (REQ-READ-006 AC 3).

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { log } from '~/lib/log';
import { localDateInTz } from '~/lib/tz';
import { DEFAULT_MODEL_ID } from '~/lib/models';
import { generateUlid } from '~/lib/ulid';
import { loadSession } from '~/middleware/auth';
import { checkOrigin, originOf } from '~/middleware/origin-check';

/** 30-second cooldown between refreshes — enough to stop accidental
 * double-clicks and repeated tap spam, without blocking real iteration. */
const COOLDOWN_SECONDS = 30;
/** 100 refreshes per 24h. Still 10× the prior cap so it rarely bites
 * during manual iteration, but low enough to cap worst-case inference
 * spend at ~$10/user/day even if max_tokens fills the 50K ceiling
 * (100 × 50_000 × $2.253/M ≈ $11.27). */
const DAILY_CAP = 100;
/** 24h window in seconds. */
const WINDOW_SECONDS = 86_400;

/** Return shape from the atomic rate-limit UPDATE. */
interface RateLimitRow {
  refresh_count_24h: number;
}

/** Shape of the users row we read to compute 429 metadata on a rate-
 * limit rejection (the separate read runs only on the 429 path). */
interface RateStateRow {
  last_refresh_at: number | null;
  refresh_window_start: number;
  refresh_count_24h: number;
}

/**
 * Compute `retry_after_seconds` for a rate-limited user. We look at
 * both constraints (cooldown and daily cap) and return the larger
 * remaining window so the client's countdown is accurate. `reason` is
 * the binding constraint.
 */
function computeRetryAfter(
  row: RateStateRow,
  nowSec: number,
): { retryAfterSeconds: number; reason: 'cooldown' | 'daily_cap' } {
  // Cooldown: time since last refresh.
  const sinceLast =
    row.last_refresh_at === null ? COOLDOWN_SECONDS : nowSec - row.last_refresh_at;
  const cooldownRemaining = Math.max(0, COOLDOWN_SECONDS - sinceLast);

  // Daily cap: time until the 24h window rolls forward.
  const windowElapsed = nowSec - row.refresh_window_start;
  const dailyRemaining =
    row.refresh_count_24h >= DAILY_CAP ? Math.max(0, WINDOW_SECONDS - windowElapsed) : 0;

  if (dailyRemaining > cooldownRemaining) {
    return { retryAfterSeconds: dailyRemaining, reason: 'daily_cap' };
  }
  return { retryAfterSeconds: Math.max(1, cooldownRemaining), reason: 'cooldown' };
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return errorResponse('app_not_configured');
  }
  const appOrigin = originOf(env.APP_URL);

  const originResult = checkOrigin(context.request, appOrigin);
  if (!originResult.ok) {
    return originResult.response!;
  }

  // Detect a plain HTML <form> submission vs a JSON fetch(). A form
  // submission always carries application/x-www-form-urlencoded (or
  // multipart/form-data) so we branch all response paths on this bit:
  // forms get a 303 redirect the browser can follow natively, fetches
  // get the JSON contract used by the digest-poll client. This lets
  // the failed.astro Try-again button work with JS disabled, broken,
  // or shadowed by a stale bundle — the native <form> POSTs and the
  // browser follows the 303 to /digest unconditionally.
  const contentType =
    context.request.headers.get('content-type')?.toLowerCase() ?? '';
  const isFormSubmit =
    contentType.startsWith('application/x-www-form-urlencoded') ||
    contentType.startsWith('multipart/form-data');

  const session = await loadSession(context.request, env.DB, env.OAUTH_JWT_SECRET);
  if (session === null) {
    if (isFormSubmit) {
      return new Response(null, {
        status: 303,
        headers: { Location: '/api/auth/github/login' },
      });
    }
    return errorResponse('unauthorized');
  }

  const userId = session.user.id;
  const nowSec = Math.floor(Date.now() / 1000);
  const localDate = localDateInTz(nowSec, session.user.tz);
  const modelId = session.user.model_id ?? DEFAULT_MODEL_ID;

  // Step 1 — atomic rate-limit UPDATE. The CASE expressions reset the
  // window counter when the 24h window has rolled; otherwise they
  // increment. The WHERE clause fails the UPDATE (0 rows) when either
  // constraint is violated, and RETURNING surfaces the post-update row.
  let rateResult: { results?: RateLimitRow[] } | null = null;
  try {
    rateResult = await env.DB
      .prepare(
        `UPDATE users SET
           last_refresh_at = ?1,
           refresh_window_start = CASE WHEN ?1 > refresh_window_start + ?2
                                       THEN ?1 ELSE refresh_window_start END,
           refresh_count_24h = CASE WHEN ?1 > refresh_window_start + ?2
                                    THEN 1 ELSE refresh_count_24h + 1 END
         WHERE id = ?3
           AND (last_refresh_at IS NULL OR ?1 - last_refresh_at >= ?4)
           AND (refresh_count_24h < ?5 OR ?1 > refresh_window_start + ?2)
         RETURNING refresh_count_24h`,
      )
      .bind(nowSec, WINDOW_SECONDS, userId, COOLDOWN_SECONDS, DAILY_CAP)
      .all<RateLimitRow>();
  } catch (err) {
    log('error', 'refresh.rejected', {
      user_id: userId,
      status: 'rate_limit_update_failed',
      detail: String(err).slice(0, 500),
    });
    return errorResponse('internal_error');
  }

  const rows = rateResult?.results ?? [];
  if (rows.length === 0) {
    // Rate limited. Re-read the row to compute an accurate retry_after.
    let state: RateStateRow | null;
    try {
      state = await env.DB
        .prepare(
          'SELECT last_refresh_at, refresh_window_start, refresh_count_24h FROM users WHERE id = ?1',
        )
        .bind(userId)
        .first<RateStateRow>();
    } catch {
      state = null;
    }
    const { retryAfterSeconds, reason } = computeRetryAfter(
      state ?? { last_refresh_at: nowSec, refresh_window_start: nowSec, refresh_count_24h: DAILY_CAP },
      nowSec,
    );
    log('info', 'refresh.rejected', {
      user_id: userId,
      reason,
      retry_after_seconds: retryAfterSeconds,
    });
    if (isFormSubmit) {
      // Surface the rate-limit reason in the URL so /digest/failed can
      // render a friendly countdown without any client-side JS.
      const params = new URLSearchParams({
        code: 'rate_limited',
        reason,
        retry_after: String(retryAfterSeconds),
      });
      return new Response(null, {
        status: 303,
        headers: { Location: `/digest/failed?${params.toString()}` },
      });
    }
    return errorResponse('rate_limited', {
      retry_after_seconds: retryAfterSeconds,
      reason,
    });
  }

  // Step 2 — conditional INSERT. The NOT EXISTS guard prevents
  // two simultaneous accepted refreshes from both creating an
  // `in_progress` row for the same local_date.
  const digestId = generateUlid();
  let insertResult: D1Result | null = null;
  try {
    insertResult = await env.DB
      .prepare(
        `INSERT INTO digests (id, user_id, local_date, generated_at, model_id, status, trigger)
         SELECT ?1, ?2, ?3, ?4, ?5, 'in_progress', 'manual'
         WHERE NOT EXISTS (
           SELECT 1 FROM digests
           WHERE user_id = ?2 AND local_date = ?3 AND status = 'in_progress'
         )`,
      )
      .bind(digestId, userId, localDate, nowSec, modelId)
      .run();
  } catch (err) {
    log('error', 'refresh.rejected', {
      user_id: userId,
      status: 'digest_insert_failed',
      detail: String(err).slice(0, 500),
    });
    return errorResponse('internal_error');
  }

  const changes =
    (insertResult?.meta as { changes?: number } | undefined)?.changes ?? 0;
  if (changes === 0) {
    log('info', 'refresh.rejected', {
      user_id: userId,
      reason: 'already_in_progress',
    });
    if (isFormSubmit) {
      // Already-in-progress isn't a failure — an older click won
      // the race and the user should land on /digest to watch it.
      return new Response(null, {
        status: 303,
        headers: { Location: '/digest' },
      });
    }
    return errorResponse('already_in_progress');
  }

  // Step 3 — enqueue the job. A send failure leaves the `in_progress`
  // row hanging; the stuck-digest sweeper (REQ-GEN-007) will mark it
  // failed after 10 minutes.
  try {
    await env.DIGEST_JOBS.send({
      trigger: 'manual',
      user_id: userId,
      local_date: localDate,
      digest_id: digestId,
    });
  } catch (err) {
    log('error', 'digest.generation', {
      user_id: userId,
      digest_id: digestId,
      status: 'enqueue_failed',
      detail: String(err).slice(0, 500),
    });
    return errorResponse('internal_error');
  }

  const headers = new Headers();
  if (session.refreshCookie !== null) {
    headers.append('Set-Cookie', session.refreshCookie);
  }
  if (isFormSubmit) {
    headers.set('Location', '/digest');
    return new Response(null, { status: 303, headers });
  }
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(
    JSON.stringify({ digest_id: digestId, status: 'in_progress' }),
    { status: 202, headers },
  );
}
