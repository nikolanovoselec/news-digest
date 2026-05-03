// Infrastructure / shared utility — no REQ.
//
// Generic queue-batch handler that consolidates the per-message
// try/ack/retry/log pattern duplicated across all three queue
// consumers (coordinator, chunk, finalize). Each consumer previously
// hand-rolled the same retry loop with the magic number 3 (which must
// match wrangler.toml's `max_retries`).
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

/** Cross-consumer queue retry cap. Mirror of `max_retries` in
 *  wrangler.toml — keep in sync. */
export const MAX_QUEUE_ATTEMPTS = 3;

export interface BatchHandlerOptions<TBody> {
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
  /** Override for {@link MAX_QUEUE_ATTEMPTS} — tests can pin a smaller
   *  value without rebuilding wrangler.toml. */
  maxAttempts?: number;
}

interface QueueMessage<TBody> {
  body: TBody;
  attempts: number;
  ack: () => void;
  retry: () => void;
}

interface QueueBatch<TBody> {
  messages: QueueMessage<TBody>[];
}

/** Wrap a per-message processor in the standard queue retry envelope:
 *  ack on success; on throw, log + (optional terminal-failure hook on
 *  attempts == max) + retry. */
export async function handleBatch<TBody>(
  batch: QueueBatch<TBody>,
  env: Env,
  opts: BatchHandlerOptions<TBody>,
): Promise<void> {
  const max = opts.maxAttempts ?? MAX_QUEUE_ATTEMPTS;
  for (const message of batch.messages) {
    try {
      await opts.process(env, message.body);
      message.ack();
    } catch (err) {
      const fields = opts.extraLogFields?.(message.body) ?? {};
      log('error', 'digest.generation', {
        ...fields,
        status: opts.throwLogStatus,
        attempts: message.attempts,
        detail: String(err).slice(0, 500),
      });
      if (opts.onTerminalFailure !== undefined && message.attempts >= max) {
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
      message.retry();
    }
  }
}
