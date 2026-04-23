// Implements REQ-MAIL-001 (dispatcher stub — Wave 2 email-settings agent
// fills in the dispatch logic).
//
// Gate B of the global-feed rework moves the `*/5 * * * *` cron over to
// the email dispatcher + discovery drain pair. The real body lands in
// the Wave 2 email-settings agent's commit; this stub keeps Gate B's
// cron handler type-safe.

export async function dispatchDailyEmails(_env: Env): Promise<void> {
  // Placeholder; Wave 2 implements the once-per-user-per-local-date
  // send loop gated on users.last_emailed_local_date (REQ-MAIL-001).
}
