// Implements REQ-SET-003
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
