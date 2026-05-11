// Tests for src/lib/queue-handler.ts — the shared retry envelope all
// three queue consumers (coordinator, chunk, finalize) ride. Covers:
//   - ack on successful processing
//   - retry on transient throws + log shape
//   - onTerminalFailure fires at the attempt-cap boundary
//   - onTerminalFailure errors are logged, not suppressed silently
//   - NonRetryableError → ack immediately, onTerminalFailure still fires
//   - env-driven attempt-cap parsing (QUEUE_MAX_RETRIES + maxAttempts override)
//
// Implements REQ-PIPE-008.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLog } = vi.hoisted(() => ({
  mockLog: vi.fn(),
}));

vi.mock('~/lib/log', () => ({ log: mockLog }));

import { handleBatch, NonRetryableError } from '~/lib/queue-handler';

interface FakeBody {
  id: string;
}

function makeMessage(body: FakeBody, attempts = 1) {
  return {
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function makeBatch(messages: ReturnType<typeof makeMessage>[]): MessageBatch<FakeBody> {
  return {
    queue: 'test-queue',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<FakeBody>;
}

const fakeEnv = {} as Env;

describe('handleBatch — happy path', () => {
  beforeEach(() => mockLog.mockClear());

  it('acks the message and does not retry when process resolves', async () => {
    const message = makeMessage({ id: 'a' });
    const process = vi.fn().mockResolvedValue(undefined);

    await handleBatch(makeBatch([message]), fakeEnv, {
      process,
      throwLogStatus: 'test_failed',
    });

    expect(process).toHaveBeenCalledWith(fakeEnv, { id: 'a' });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('handles every message in a multi-message batch independently', async () => {
    const messages = [makeMessage({ id: 'a' }), makeMessage({ id: 'b' }), makeMessage({ id: 'c' })];
    const process = vi.fn().mockResolvedValue(undefined);

    await handleBatch(makeBatch(messages), fakeEnv, {
      process,
      throwLogStatus: 'test_failed',
    });

    for (const m of messages) {
      expect(m.ack).toHaveBeenCalledTimes(1);
      expect(m.retry).not.toHaveBeenCalled();
    }
    expect(process).toHaveBeenCalledTimes(3);
  });
});

describe('handleBatch — transient errors retry until cap', () => {
  beforeEach(() => mockLog.mockClear());

  it('retries the message and logs throwLogStatus with attempt count', async () => {
    const message = makeMessage({ id: 'a' }, 1);
    const process = vi.fn().mockRejectedValue(new Error('transient'));

    await handleBatch(makeBatch([message]), fakeEnv, {
      process,
      throwLogStatus: 'chunk_failed',
      extraLogFields: (b) => ({ scrape_run_id: b.id }),
    });

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(mockLog).toHaveBeenCalledWith(
      'error',
      'digest.generation',
      expect.objectContaining({
        scrape_run_id: 'a',
        status: 'chunk_failed',
        attempts: 1,
        permanent: false,
        detail: expect.stringContaining('transient'),
      }),
    );
  });

  it('does not call onTerminalFailure until attempts reaches the cap', async () => {
    const message = makeMessage({ id: 'a' }, 2); // 2 of 3
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);

    await handleBatch(makeBatch([message]), fakeEnv, {
      process: vi.fn().mockRejectedValue(new Error('boom')),
      throwLogStatus: 'test_failed',
      onTerminalFailure,
      terminalFailureLogStatus: 'terminal_failed',
      maxAttempts: 3,
    });

    expect(onTerminalFailure).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledTimes(1);
  });

  it('calls onTerminalFailure once when attempts == maxAttempts and still retries', async () => {
    const message = makeMessage({ id: 'a' }, 3);
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);

    await handleBatch(makeBatch([message]), fakeEnv, {
      process: vi.fn().mockRejectedValue(new Error('boom')),
      throwLogStatus: 'test_failed',
      onTerminalFailure,
      terminalFailureLogStatus: 'terminal_failed',
      maxAttempts: 3,
    });

    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure).toHaveBeenCalledWith(fakeEnv, { id: 'a' });
    // Even at the cap the message still goes back on the queue so the
    // platform observes the failure and applies its own dead-letter
    // behaviour — the consumer's job is to record the failure, not to
    // suppress the platform's signal.
    expect(message.retry).toHaveBeenCalledTimes(1);
  });
});

describe('handleBatch — terminal-failure double-fault', () => {
  beforeEach(() => mockLog.mockClear());

  it('logs terminalFailureLogStatus when onTerminalFailure itself throws and still retries', async () => {
    const message = makeMessage({ id: 'a' }, 3);
    const onTerminalFailure = vi.fn().mockRejectedValue(new Error('rollback_failed'));

    await handleBatch(makeBatch([message]), fakeEnv, {
      process: vi.fn().mockRejectedValue(new Error('boom')),
      throwLogStatus: 'test_failed',
      onTerminalFailure,
      terminalFailureLogStatus: 'terminal_failed',
      maxAttempts: 3,
    });

    // Two log calls: the original processor throw + the terminal-failure throw.
    const statuses = mockLog.mock.calls.map((c) => (c[2] as Record<string, unknown>).status);
    expect(statuses).toContain('test_failed');
    expect(statuses).toContain('terminal_failed');
    expect(message.retry).toHaveBeenCalledTimes(1);
  });

  it('swallows onTerminalFailure errors silently when no terminalFailureLogStatus is configured', async () => {
    const message = makeMessage({ id: 'a' }, 3);
    const onTerminalFailure = vi.fn().mockRejectedValue(new Error('rollback_failed'));

    await handleBatch(makeBatch([message]), fakeEnv, {
      process: vi.fn().mockRejectedValue(new Error('boom')),
      throwLogStatus: 'test_failed',
      onTerminalFailure,
      maxAttempts: 3,
    });

    // Only the original processor throw is logged; terminal failure is
    // observed via the absence of a separate log line. The caller
    // explicitly opted out of the second log by omitting the status.
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(message.retry).toHaveBeenCalledTimes(1);
  });
});

describe('handleBatch — NonRetryableError', () => {
  beforeEach(() => mockLog.mockClear());

  it('acks immediately and does not retry when process throws NonRetryableError', async () => {
    const message = makeMessage({ id: 'a' }, 1);
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);

    await handleBatch(makeBatch([message]), fakeEnv, {
      process: vi.fn().mockRejectedValue(new NonRetryableError('schema_mismatch')),
      throwLogStatus: 'chunk_invalid_json',
      onTerminalFailure,
      terminalFailureLogStatus: 'terminal_failed',
      maxAttempts: 3,
    });

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    expect(mockLog).toHaveBeenCalledWith(
      'error',
      'digest.generation',
      expect.objectContaining({
        status: 'chunk_invalid_json',
        permanent: true,
        attempts: 1,
      }),
    );
  });

  it('skips onTerminalFailure when caller did not configure one (finalize-style)', async () => {
    const message = makeMessage({ id: 'a' }, 1);

    await handleBatch(makeBatch([message]), fakeEnv, {
      process: vi.fn().mockRejectedValue(new NonRetryableError('bad_payload')),
      throwLogStatus: 'finalize_failed',
      maxAttempts: 3,
    });

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });
});

describe('handleBatch — maxAttempts resolution', () => {
  beforeEach(() => mockLog.mockClear());

  it('reads QUEUE_MAX_RETRIES from env when maxAttempts is not provided', async () => {
    const message = makeMessage({ id: 'a' }, 5);
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);

    await handleBatch(
      makeBatch([message]),
      { QUEUE_MAX_RETRIES: '5' } as unknown as Env,
      {
        process: vi.fn().mockRejectedValue(new Error('boom')),
        throwLogStatus: 'test_failed',
        onTerminalFailure,
        terminalFailureLogStatus: 'terminal_failed',
      },
    );

    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
  });

  it('accepts a numeric QUEUE_MAX_RETRIES env value', async () => {
    const message = makeMessage({ id: 'a' }, 2);
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);

    await handleBatch(
      makeBatch([message]),
      { QUEUE_MAX_RETRIES: 2 } as unknown as Env,
      {
        process: vi.fn().mockRejectedValue(new Error('boom')),
        throwLogStatus: 'test_failed',
        onTerminalFailure,
        terminalFailureLogStatus: 'terminal_failed',
      },
    );

    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
  });

  it('falls back to default 3 when QUEUE_MAX_RETRIES is unset or invalid', async () => {
    const message = makeMessage({ id: 'a' }, 3);
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);

    await handleBatch(
      makeBatch([message]),
      { QUEUE_MAX_RETRIES: 'not-a-number' } as unknown as Env,
      {
        process: vi.fn().mockRejectedValue(new Error('boom')),
        throwLogStatus: 'test_failed',
        onTerminalFailure,
        terminalFailureLogStatus: 'terminal_failed',
      },
    );

    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
  });

  it('options.maxAttempts overrides env-driven cap', async () => {
    const message = makeMessage({ id: 'a' }, 7);
    const onTerminalFailure = vi.fn().mockResolvedValue(undefined);

    await handleBatch(
      makeBatch([message]),
      { QUEUE_MAX_RETRIES: '99' } as unknown as Env,
      {
        process: vi.fn().mockRejectedValue(new Error('boom')),
        throwLogStatus: 'test_failed',
        onTerminalFailure,
        terminalFailureLogStatus: 'terminal_failed',
        maxAttempts: 7,
      },
    );

    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
  });
});
