// Implements REQ-PIPE-005 (coordinator stub — Wave 2 cleanup-cron agent
// fills in the deletion query + logging).
//
// Gate B of the global-feed rework wires `src/worker.ts` to call this
// export from the daily `0 3 * * *` cron. The real body lands in the
// Wave 2 cleanup-cron agent's commit; this stub exists so Gate B ships
// with a green type check.

export async function runCleanup(_env: Env): Promise<void> {
  // Placeholder; Wave 2 implements the starred-exempt 7-day retention
  // DELETE and the deletion-count log line (REQ-PIPE-005 AC 1–4).
}
