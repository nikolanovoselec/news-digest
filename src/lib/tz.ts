// Implements REQ-SET-003
// Implements REQ-MAIL-001 (`localMidnightUnixInTz` is the cutoff source
// for the email's "Since midnight" tag tally).
// Timezone helpers for the cron dispatcher's local-time matching and the
// daily per-user local_date bookkeeping. All conversions use the runtime's
// built-in IANA tz database via Intl.DateTimeFormat — no tz data is bundled
// with the Worker.

/**
 * Default timezone used when a user has not yet set one (e.g. before
 * first-run settings save). REQ-SET-003 requires a stored IANA tz per user;
 * this constant is the fallback for pre-config state only.
 */
export const DEFAULT_TZ = 'UTC';

/**
 * Locale tag to use with `Intl.DateTimeFormat` so the rendered time
 * follows the timezone's regional convention (24h vs 12h). Mirrors the
 * client-side `timeLangForTz` heuristic in settings.astro: America/* zones
 * use `en-US` (12h with AM/PM), everything else uses `en-GB` (24h).
 *
 * `Intl.DateTimeFormat` derives 24h-vs-12h from the locale, NOT the
 * `timeZone` option, so callers that want a 24h display in a Zurich tz
 * must pass this locale explicitly. The Workers runtime's default locale
 * is `en-US`, which would otherwise force 12h on every server-rendered
 * time string regardless of the user's tz.
 */
export function localeForTz(tz: string): string {
  return tz.startsWith('America/') ? 'en-US' : 'en-GB';
}

/**
 * Return the local date in {@link tz} as `YYYY-MM-DD` for the given
 * Unix timestamp (seconds). Uses Intl.DateTimeFormat so DST transitions
 * are handled correctly — no manual offset math.
 */
export function localDateInTz(unixSeconds: number, tz: string): string {
  const ms = unixSeconds * 1000;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA renders as YYYY-MM-DD natively, avoiding locale drift.
  // formatToParts is used rather than format() to be defensive against
  // stray characters some ICU builds insert.
  const parts = fmt.formatToParts(new Date(ms));
  let year = '';
  let month = '';
  let day = '';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year}-${month}-${day}`;
}

/**
 * Return the local hour/minute in {@link tz} for the given Unix timestamp.
 * Hour is 0-23 (not 24), minute is 0-59.
 */
export function localHourMinuteInTz(
  unixSeconds: number,
  tz: string,
): { hour: number; minute: number } {
  const ms = unixSeconds * 1000;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'hour') {
      // en-US + hour12:false can return "24" at midnight on some ICU builds;
      // normalise to the conventional 0-23 range.
      hour = Number(part.value) % 24;
    } else if (part.type === 'minute') {
      minute = Number(part.value);
    }
  }
  return { hour, minute };
}

/**
 * Return the unix-seconds timestamp of "00:00 local time" in {@link tz}
 * on the same local date as {@link unixSeconds}. Used by the email
 * dispatcher to compute the "Since midnight: N articles" cutoff.
 *
 * Implementation: start from midnight UTC on the target local date,
 * then walk by the *signed* delta between the candidate's local
 * wall-clock and the target (target localDate at 00:00). The signed
 * walk handles both eastward (UTC+) and westward (UTC-) timezones —
 * for UTC-NY the initial candidate is 20:00 the day BEFORE the target
 * locally, so we ADD 4h; for UTC+Tokyo it's 09:00 the SAME local day
 * already, so we SUBTRACT 9h. The loop runs ≤3 passes; in practice
 * pass 2 always converges, even across DST transitions.
 */
export function localMidnightUnixInTz(unixSeconds: number, tz: string): number {
  const localDate = localDateInTz(unixSeconds, tz);
  const [yearStr, monthStr, dayStr] = localDate.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  let candidate = Math.floor(Date.UTC(year, month - 1, day, 0, 0, 0) / 1000);
  let bestOnTargetDate: number | null = null;
  for (let pass = 0; pass < 4; pass++) {
    const candidateLocalDate = localDateInTz(candidate, tz);
    const hm = localHourMinuteInTz(candidate, tz);
    if (candidateLocalDate === localDate) {
      // Track the smallest candidate whose local date matches the
      // target — we fall back to it when the loop exhausts (the
      // pathological case is a tz where 00:00 wall-clock doesn't
      // exist on `localDate` because a DST transition skipped it,
      // e.g. historical Africa/Cairo midnight starts).
      if (bestOnTargetDate === null || candidate < bestOnTargetDate) {
        bestOnTargetDate = candidate;
      }
    }
    let dayDelta = 0;
    if (candidateLocalDate < localDate) dayDelta = 1;       // candidate is one day behind target
    else if (candidateLocalDate > localDate) dayDelta = -1; // candidate is one day ahead of target
    const deltaSeconds = dayDelta * 86400 - hm.hour * 3600 - hm.minute * 60;
    if (deltaSeconds === 0) return candidate;
    candidate += deltaSeconds;
  }
  // Loop didn't converge to {hour:0, minute:0} on the target date —
  // happens only when 00:00 local was skipped by DST. Return the
  // smallest seen on-target candidate (semantically: "first instant
  // of the target local day that exists"). If we never even saw the
  // target date in 4 passes, fall back to the last candidate.
  return bestOnTargetDate ?? candidate;
}

/**
 * True iff {@link tz} is a valid IANA timezone identifier.
 *
 * Uses Intl.supportedValuesOf('timeZone') when the runtime supports it
 * (fast membership test). Falls back to instantiating a DateTimeFormat
 * with the candidate tz — the constructor throws RangeError on invalid
 * zones, which we catch.
 *
 * REQ-SET-003 uses this to reject user-supplied timezones before
 * persisting them to `users.tz`.
 */
export function isValidTz(tz: string): boolean {
  if (tz === '') {
    return false;
  }

  // Fast positive path: ask the runtime for its IANA tz inventory.
  // Note: `supportedValuesOf('timeZone')` returns canonical names only;
  // aliases like "UTC" (canonically "Etc/UTC") are NOT in the list even
  // though the DateTimeFormat constructor accepts them. So a miss here
  // is not conclusive — we still have to try the constructor probe.
  const supported = (Intl as unknown as {
    supportedValuesOf?: (key: string) => string[];
  }).supportedValuesOf;
  if (typeof supported === 'function') {
    try {
      const zones = supported('timeZone');
      if (Array.isArray(zones) && zones.includes(tz)) {
        return true;
      }
    } catch {
      // Fall through to the constructor probe.
    }
  }

  // Fallback / alias path: Intl.DateTimeFormat throws RangeError for
  // unknown zones and accepts canonical aliases (UTC, GMT, etc.).
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
