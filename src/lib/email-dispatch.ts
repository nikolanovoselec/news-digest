// Implements REQ-MAIL-001
// Implements REQ-MAIL-002 (non-blocking failure: per-user try/catch,
// no bubble to cron handler, failed sends do NOT advance
// last_emailed_local_date so the next tick retries naturally).
//
// Daily digest-ready email dispatcher. Runs on the `*/5 * * * *` cron.
//
// Contract:
//   - For every user with `email_enabled = 1`, `digest_hour:digest_minute`
//     falling inside the current 5-minute local wall-clock window, and
//     `last_emailed_local_date` not equal to today's local date in the
//     user's tz: render the simplified "digest is ready" email, send it
//     via Resend, and stamp `last_emailed_local_date` so the next cron
//     tick in the same local day is a no-op for that user.
//   - Email delivery is best-effort. A Resend outage never blocks a
//     sibling user's send and never escalates out of this function —
//     the top-level cron handler already wraps us in try/catch.
//   - When a send fails (Resend non-2xx or fetch error), we deliberately
//     do NOT stamp `last_emailed_local_date`: the next cron tick will
//     retry, so a transient Resend blip recovers automatically within
//     the same local day.
//   - When the user has zero unread headlines (either genuinely empty —
//     no tags / no matches / everything already read — or the headlines
//     read failed and we couldn't determine), we skip the send AND skip
//     the date stamp. The user's digest_minute window only matches once
//     per local day, so they are naturally retried tomorrow at their
//     digest time. Silent inbox is the right behaviour: an empty email
//     is noise, and we'd rather wait until there's something worth
//     reading.
//
// Scheduling model:
//   The cron fires every 5 minutes. We match users whose `digest_minute`
//   is in the 5-minute window containing the current local minute,
//   expressed as `[floor(localMinute/5)*5, floor(localMinute/5)*5 + 5)`.
//   This keeps the match idempotent across multiple runs within the
//   same bucket (the `last_emailed_local_date` gate absorbs any
//   double-fire from cron jitter).

import { isValidTz, localDateInTz, localHourMinuteInTz, localMidnightUnixInTz } from '~/lib/tz';
import { log } from '~/lib/log';
import { renderDigestReadyEmail, sendEmail } from '~/lib/email';
import {
  selectUnreadHeadlinesForUser,
  tagTallySinceMidnight,
  type Headline,
  type TagTally,
} from '~/lib/email-data';
import { parseHashtags } from '~/lib/hashtags';

/** User row subset needed for dispatch. All columns are non-null in
 *  practice for email-enabled users, but `last_emailed_local_date`
 *  is nullable before the first successful send. */
interface DispatchUserRow {
  id: string;
  email: string;
  gh_login: string;
  tz: string;
  digest_hour: number;
  digest_minute: number;
  hashtags_json: string | null;
  last_emailed_local_date: string | null;
}

/** Row returned by the distinct-tz probe. */
interface TzRow {
  tz: string;
}

/**
 * Iterate email-enabled users whose local clock matches the current
 * 5-minute window, send each their digest-ready email, and stamp
 * `last_emailed_local_date` on success.
 *
 * Returns normally on any per-user failure; logs and continues so one
 * bad recipient never blocks the remaining queue.
 */
export async function dispatchDailyEmails(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Distinct tz probe: we loop once per tz so each user's local clock
  // is computed from the same Intl.DateTimeFormat call, and the
  // per-tz query binds integer hour/minute bounds SQLite can index
  // against. Users without email_enabled=1 are filtered here so the
  // downstream per-tz query is the only one that needs the predicate.
  // CF-057 — guard: dispatchDailyEmails depends on env.APP_URL to
  // render the dashboard link in the email body. Missing APP_URL would
  // produce broken links AND a renderer crash; log once and exit
  // cleanly rather than emitting a malformed digest.
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    log('error', 'email.send.failed', {
      user_id: null,
      status: null,
      error: 'app_url_not_configured',
    });
    return;
  }

  let tzRows: TzRow[];
  try {
    // Empty/null tz rows are filtered here: localHourMinuteInTz feeds
    // tz to Intl.DateTimeFormat, which throws RangeError on '' or
    // unrecognised zones. Settings save enforces a non-empty IANA tz,
    // but legacy/manually-edited rows can still slip through.
    const res = await env.DB.prepare(
      `SELECT DISTINCT tz FROM users
        WHERE email_enabled = 1
          AND tz IS NOT NULL
          AND tz != ''`,
    ).all<TzRow>();
    tzRows = res.results ?? [];
  } catch (err) {
    log('error', 'email.send.failed', {
      user_id: null,
      status: null,
      error: `tz_probe_failed: ${String(err).slice(0, 200)}`,
    });
    return;
  }

  for (const { tz } of tzRows) {
    // Defence-in-depth: even after the SQL filter, an unrecognised
    // IANA name (e.g. a deprecated zone the runtime no longer knows)
    // would throw inside localHourMinuteInTz and abort the whole tick.
    // Skip and log so the operator can find affected users.
    if (!isValidTz(tz)) {
      log('warn', 'email.dispatch.skipped_invalid_tz', { tz });
      continue;
    }
    const { hour, minute } = localHourMinuteInTz(now, tz);
    const bucketStart = minute - (minute % 5);
    const bucketEnd = bucketStart + 5;
    const localDate = localDateInTz(now, tz);

    let users: DispatchUserRow[];
    try {
      const res = await env.DB.prepare(
        `SELECT id, email, gh_login, tz, digest_hour, digest_minute,
                hashtags_json, last_emailed_local_date
           FROM users
          WHERE email_enabled = 1
            AND tz = ?1
            AND digest_hour = ?2
            AND digest_minute >= ?3
            AND digest_minute < ?4
            AND (last_emailed_local_date IS NULL OR last_emailed_local_date != ?5)`,
      )
        .bind(tz, hour, bucketStart, bucketEnd, localDate)
        .all<DispatchUserRow>();
      users = res.results ?? [];
    } catch (err) {
      log('error', 'email.send.failed', {
        user_id: null,
        status: null,
        error: `user_scan_failed: ${String(err).slice(0, 200)}`,
      });
      continue;
    }

    // Pre-compute the local-midnight cutoff once per tz — every user in
    // this loop iteration shares it (their tz column matches the loop's
    // `tz`).
    const sinceMidnightUnix = localMidnightUnixInTz(now, tz);

    for (const user of users) {
      try {
        const userTags = parseHashtags(user.hashtags_json);

        // Fetch headlines + tally independently (Promise.allSettled,
        // not Promise.all) so a failure in one doesn't collapse the
        // other. A user might still get a useful headline list even
        // when the tally query trips on a missing index, or vice
        // versa. Distinct event name from `email.send.failed` so an
        // operator grepping `wrangler tail` for delivery failures
        // doesn't conflate "Resend rejected our POST" with "D1 read
        // errored before we even composed the body". A headlines-fetch
        // failure cascades to the AC-11 skip path below — we cannot
        // prove there were headlines to send, so we default to silence.
        let headlines: Headline[] = [];
        let tally: TagTally[] = [];
        // `null` distinguishes "we don't know" (tally fetch failed)
        // from "we know there are zero" — important for any operator
        // grepping the structured logs to tell genuine empty days from
        // partially-degraded reads.
        let totalSinceMidnight: number | null = 0;
        const [hSettled, tSettled] = await Promise.allSettled([
          selectUnreadHeadlinesForUser(env.DB, user.id, userTags, 5),
          tagTallySinceMidnight(env.DB, userTags, sinceMidnightUnix),
        ]);
        if (hSettled.status === 'fulfilled') {
          headlines = hSettled.value;
        } else {
          log('error', 'email.dispatch.degraded', {
            user_id: user.id,
            error: `headlines_fetch_failed: ${String(hSettled.reason).slice(0, 200)}`,
          });
        }
        if (tSettled.status === 'fulfilled') {
          tally = tSettled.value.tally;
          totalSinceMidnight = tSettled.value.totalArticles;
        } else {
          totalSinceMidnight = null;
          log('error', 'email.dispatch.degraded', {
            user_id: user.id,
            error: `tally_fetch_failed: ${String(tSettled.reason).slice(0, 200)}`,
          });
        }

        // Skip the send when there is nothing new to surface. Covers
        // three observable shapes that all collapse to "no signal":
        //   1. user has no tags → selectUnreadHeadlinesForUser short-
        //      circuits to []
        //   2. user has tags but no matching articles arrived today, or
        //      they have already opened every match
        //   3. the headlines read failed (degraded log already emitted
        //      above) — we don't know if there were headlines, default
        //      to silence rather than spamming an empty notification
        // last_emailed_local_date is left untouched so the SQL gate
        // accurately reflects "the last day we actually emailed this
        // user". The 5-minute digest_minute bucket only matches once
        // per local day, so the user is naturally retried tomorrow.
        if (headlines.length === 0) {
          log('info', 'email.dispatch.skipped_empty', {
            user_id: user.id,
            total_since_midnight: totalSinceMidnight,
          });
          continue;
        }

        const { subject, text, html } = renderDigestReadyEmail({
          appUrl: env.APP_URL,
          userDisplayName: user.gh_login !== '' ? user.gh_login : user.email,
          headlines,
          tagTally: tally,
          // Coerce the "we don't know" sentinel back to 0 at the
          // render boundary so a degraded tally just collapses to the
          // tally-omitted branch in the renderer (line 168 of
          // email.ts) rather than emitting `Since midnight: null`.
          totalSinceMidnight: totalSinceMidnight ?? 0,
          sentLocal: { hour: user.digest_hour, minute: user.digest_minute, tz: user.tz },
          nextDigestLocal: { hour: user.digest_hour, minute: user.digest_minute },
        });

        const result = await sendEmail(env, {
          to: user.email,
          subject,
          text,
          html,
          logRecipientId: user.id,
        });

        if (!result.sent) {
          // Already logged inside sendEmail. Skip the date stamp so
          // the next cron tick retries within the same local day.
          continue;
        }

        await env.DB.prepare(
          `UPDATE users SET last_emailed_local_date = ?1 WHERE id = ?2`,
        )
          .bind(localDate, user.id)
          .run();
      } catch (err) {
        // Defensive: sendEmail is documented as non-throwing, and the
        // UPDATE is wrapped here so a D1 hiccup on one row doesn't
        // abort the loop for subsequent users.
        log('error', 'email.send.failed', {
          user_id: user.id,
          status: null,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        });
      }
    }
  }
}
