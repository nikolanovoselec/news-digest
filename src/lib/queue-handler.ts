// Implements REQ-PIPE-008
//
// Shared queue-batch handler. The retry envelope here is the load-bearing
// piece of REQ-PIPE-008 AC 8 (finalize-consumer intentional asymmetry on
// terminal failure) — owning it in one module is what keeps that AC honest
// across all three consumers (coordinator, chunk, finalize), each of which
// previously hand-rolled the same retry loop with the magic number 3
// (which must match wrangler.toml's `max_retries`).
//
// CF-007 — sourcing the retry cap from a single shared constant
// removes the silent drift risk: a future bump from 3 to 5 in
// wrangler.toml that doesn't update every consumer would leave them
// silently using the old threshold.
//
// Finalize's intentional asymmetry — REQ-PIPE-008 AC 8 says the
// finalize consumer must NOT call `finishRun('failed')` on terminal
// retry, because the merge work is best-effort and the run was
// already marked `ready` by the chunk consumer — is expressed as
// "no `onTerminalFailure` passed".

import { log } from '~/lib/log';

/** Thrown by a per-message processor when the failure is permanent
 *  (malformed payload, schema mismatch, deleted-parent state) and
 *  retrying will only repeat the same error. The handler logs the
 *  failure, fires `onTerminalFailure` once (if configured), and
 *  acks the message — bypassing the attempt counter that governs
 *  transient errors. */
export class NonRetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NonRetryableError';
  }
}

/** CF-004 — cross-consumer queue retry cap, sourced from
 *  `env.QUEUE_MAX_RETRIES` (wrangler.toml `[vars]`). The earlier
 *  shape kept the literal `3` mirrored in this file AND in three
 *  `[[queues.consumers]]` declarations of wrangler.toml, with a grep
 *  parser script enforcing parity — fragile (a Prettier reformat
 *  would silently break the script) and now superseded by reading
 *  the literal once at the platform level.
 *
 *  Tests that run outside a Cloudflare runtime (no `env.QUEUE_MAX_RETRIES`
 *  bound) fall back to 3 to preserve the historical default. */
function readMaxQueueAttempts(env: Env): number {
  const raw = (env as { QUEUE_MAX_RETRIES?: string | number }).QUEUE_MAX_RETRIES;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return 3;
}

interface BatchHandlerOptions<TBody> {
  /** Per-message processor. Throws to trigger queue retry. */
  process: (env: Env, body: TBody) => Promise<void>;
  /** Stable log status emitted on processor throw. */
  throwLogStatus: string;
  /** Optional bridge for the per-consumer extra log fields. The default
   *  emits only `attempts` + `detail`; consumers extend this with
   *  scrape_run_id / chunk_index. */
  extraLogFields?: (body: TBody) => Record<string, unknown>;
  /** Optional terminal-retry hook. Coordinator + chunk-consumer use it
   *  to mark the parent scrape_run as `failed` so the UI doesn't see
   *  an orphan stuck at `running`. Finalize deliberately omits it
   *  (REQ-PIPE-008 AC 8). */
  onTerminalFailure?: (env: Env, body: TBody) => Promise<void>;
  /** Stable log status emitted when `onTerminalFailure` itself throws.
   *  Required iff `onTerminalFailure` is provided. */
  terminalFailureLogStatus?: string;
  /** Override for the env-driven cap — tests can pin a smaller value
   *  without rebuilding wrangler.toml. */
  maxAttempts?: number;
}

// CF-055 — use Cloudflare's platform types instead of a hand-rolled
// duplicate. `MessageBatch<TBody>` from `@cloudflare/workers-types`
// is structurally identical to our old `QueueBatch<TBody>` but
// removes one drift vector: if the platform adds fields (e.g. a
// `retryAll()` method) future callers can use them immediately
// without patching the local interface first.

/** Wrap a per-message processor in the standard queue retry envelope:
 *  ack on success; on throw, log + (optional terminal-failure hook on
 *  attempts == max) + retry. */
export async function handleBatch<TBody>(
  batch: MessageBatch<TBody>,
  env: Env,
  opts: BatchHandlerOptions<TBody>,
): Promise<void> {
  const max = opts.maxAttempts ?? readMaxQueueAttempts(env);
  for (const message of batch.messages) {
    try {
      await opts.process(env, message.body);
      message.ack();
    } catch (err) {
      const fields = opts.extraLogFields?.(message.body) ?? {};
      const isPermanent = err instanceof NonRetryableError;
      log('error', 'digest.generation', {
        ...fields,
        status: opts.throwLogStatus,
        attempts: message.attempts,
        permanent: isPermanent,
        detail: String(err).slice(0, 500),
      });
      const terminal = isPermanent || message.attempts >= max;
      if (opts.onTerminalFailure !== undefined && terminal) {
        try {
          await opts.onTerminalFailure(env, message.body);
        } catch (terminalErr) {
          if (opts.terminalFailureLogStatus !== undefined) {
            log('error', 'digest.generation', {
              ...fields,
              status: opts.terminalFailureLogStatus,
              detail: String(terminalErr).slice(0, 500),
            });
          }
        }
      }
      if (isPermanent) {
        message.ack();
      } else {
        message.retry();
      }
    }
  }
}
