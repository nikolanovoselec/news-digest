// Implements REQ-OPS-001
//
// Structured JSON logger — the single operational surface for news-digest.
// Every line is emitted via `console.log(JSON.stringify(...))` so Cloudflare
// Logs parses it as a structured record, making it queryable without a
// dedicated observability service.
//
// Design rules (REQ-OPS-001 + CON-SEC-001):
//  - `event` is a closed enum. New events are added here, never inferred from
//    caller input — this keeps log schemas greppable and prevents log
//    injection attacks where untrusted strings become the event name.
//  - Raw exception messages and external API response bodies may appear in
//    the `fields` payload at `level: 'error'`, but NEVER as the `event` value
//    and NEVER in D1 or responses to clients (REQ-OPS-002).
//  - `ts` is unix milliseconds (Date.now()) — compact and sortable.

/** Severity levels surfaced to Cloudflare Logs. `info` is the default; `warn`
 * is used for recoverable anomalies; `error` is for operational failures that
 * need investigation. */
export type LogLevel = 'info' | 'warn' | 'error';

/** Closed enum of operational events. Extend by adding a new literal here;
 * never build an event name from user input at runtime. */
export type LogEvent =
  | 'auth.login'
  | 'auth.callback.failed'
  | 'auth.callback.invalid_state'
  | 'auth.logout'
  | 'auth.account.delete'
  | 'auth.account.delete.failed'
  | 'auth.set_tz.failed'
  | 'digest.generation'
  | 'source.fetch.failed'
  | 'refresh.rejected'
  | 'email.send.failed'
  | 'email.dispatch.degraded'
  | 'discovery.completed'
  | 'discovery.queued'
  | 'settings.update.failed'
  | 'article.star.failed'
  | 'admin.auth.denied'
  | 'rate.limit.exceeded'
  | 'jwt.secret.weak'
  | 'digest.today.query_failed'
  | 'starred.query_failed';

/** Shape of every emitted log line. */
export interface LogRecord {
  ts: number;
  level: LogLevel;
  event: LogEvent;
  [field: string]: unknown;
}

/**
 * Emit a structured log line.
 *
 * The record is serialized with `JSON.stringify` and written to `console.log`
 * regardless of {@link level} — Cloudflare's log pipeline reads stdout and
 * routes by the `level` field, not by stream. Keeping the transport uniform
 * means log ordering is preserved and tests can capture every emission via a
 * single `vi.spyOn(console, 'log')`.
 *
 * @param level  Severity.
 * @param event  Closed-enum event name; do not pass user input.
 * @param fields Arbitrary structured payload merged into the record. Field
 *               keys `ts`, `level`, and `event` from this argument are
 *               ignored — the envelope always wins.
 */
export function log(
  level: LogLevel,
  event: LogEvent,
  fields?: Record<string, unknown>,
): void {
  // Build the record with envelope keys last so callers cannot override them
  // by accident. Spread first, then stamp ts/level/event on top.
  const record: LogRecord = {
    ...fields,
    ts: Date.now(),
    level,
    event,
  };
  console.log(JSON.stringify(record));
}
