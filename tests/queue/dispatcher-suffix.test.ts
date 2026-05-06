// Tests for the queue dispatcher in src/worker.ts — env-suffix
// stripping (`-(integration|staging)$`) so the same handler routes
// production AND integration queue messages. The 48h integration
// outage on 2026-05-04/05 was caused by the original switch matching
// only bare names; this test pins the new contract.
//
// Implements REQ-PIPE-001.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spy on the consumer modules BEFORE importing worker.ts so the
// dispatcher routes to the mocks. Each handler is a vi.fn that records
// invocation; the test asserts on which mock was called per queue name.
//
// vi.hoisted is required because vi.mock factories are hoisted to the
// top of the file at compile time. Plain top-level `const` declarations
// would not yet be initialised at the moment the hoisted factory runs,
// triggering "Cannot access 'mockX' before initialization".
const { mockHandleCoordinator, mockHandleChunks, mockHandleFinalize, mockLog } =
  vi.hoisted(() => ({
    mockHandleCoordinator: vi.fn().mockResolvedValue(undefined),
    mockHandleChunks: vi.fn().mockResolvedValue(undefined),
    mockHandleFinalize: vi.fn().mockResolvedValue(undefined),
    mockLog: vi.fn(),
  }));

vi.mock('~/queue/scrape-coordinator', () => ({
  handleCoordinatorBatch: mockHandleCoordinator,
}));
vi.mock('~/queue/scrape-chunk-consumer', () => ({
  handleChunkBatch: mockHandleChunks,
}));
vi.mock('~/queue/scrape-finalize-consumer', () => ({
  handleFinalizeBatch: mockHandleFinalize,
}));
vi.mock('~/lib/log', () => ({ log: mockLog }));

import { queue } from '~/worker';

function makeBatch(queueName: string): MessageBatch<unknown> {
  return {
    queue: queueName,
    messages: [],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

const fakeEnv = {} as unknown as Parameters<typeof queue>[1];
const fakeCtx = {} as unknown as ExecutionContext;

describe('queue dispatcher — env-suffix stripping (REQ-PIPE-001)', () => {
  beforeEach(() => {
    mockHandleCoordinator.mockClear();
    mockHandleChunks.mockClear();
    mockHandleFinalize.mockClear();
    mockLog.mockClear();
  });

  it('REQ-PIPE-001: bare scrape-coordinator routes to handleCoordinatorBatch with the original batch + env', async () => {
    const batch = makeBatch('scrape-coordinator');
    await queue(batch, fakeEnv, fakeCtx);
    expect(mockHandleCoordinator).toHaveBeenCalledTimes(1);
    expect(mockHandleCoordinator).toHaveBeenCalledWith(batch, fakeEnv);
    expect(mockHandleChunks).not.toHaveBeenCalled();
    expect(mockHandleFinalize).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-001: scrape-coordinator-integration routes to handleCoordinatorBatch (integration env)', async () => {
    const batch = makeBatch('scrape-coordinator-integration');
    await queue(batch, fakeEnv, fakeCtx);
    expect(mockHandleCoordinator).toHaveBeenCalledTimes(1);
    expect(mockHandleCoordinator).toHaveBeenCalledWith(batch, fakeEnv);
  });

  it('REQ-PIPE-001: scrape-coordinator-staging routes to handleCoordinatorBatch (staging env)', async () => {
    const batch = makeBatch('scrape-coordinator-staging');
    await queue(batch, fakeEnv, fakeCtx);
    expect(mockHandleCoordinator).toHaveBeenCalledTimes(1);
    expect(mockHandleCoordinator).toHaveBeenCalledWith(batch, fakeEnv);
  });

  it('REQ-PIPE-001: scrape-chunks-integration routes to handleChunkBatch', async () => {
    const batch = makeBatch('scrape-chunks-integration');
    await queue(batch, fakeEnv, fakeCtx);
    expect(mockHandleChunks).toHaveBeenCalledTimes(1);
    expect(mockHandleChunks).toHaveBeenCalledWith(batch, fakeEnv);
    expect(mockHandleCoordinator).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-001: scrape-finalize-integration routes to handleFinalizeBatch', async () => {
    const batch = makeBatch('scrape-finalize-integration');
    await queue(batch, fakeEnv, fakeCtx);
    expect(mockHandleFinalize).toHaveBeenCalledTimes(1);
    expect(mockHandleFinalize).toHaveBeenCalledWith(batch, fakeEnv);
  });

  it('REQ-PIPE-001: unknown bare queue name hits the default branch and logs unknown_queue', async () => {
    await queue(makeBatch('unknown-queue'), fakeEnv, fakeCtx);
    expect(mockHandleCoordinator).not.toHaveBeenCalled();
    expect(mockHandleChunks).not.toHaveBeenCalled();
    expect(mockHandleFinalize).not.toHaveBeenCalled();
    const unknownCall = mockLog.mock.calls.find(
      (args) => args[1] === 'digest.generation' && args[2]?.status === 'unknown_queue',
    );
    expect(unknownCall).toBeDefined();
    expect(unknownCall?.[2].queue).toBe('unknown-queue');
  });

  it('REQ-PIPE-001: scrape-coordinator-foo (unrecognised suffix) hits the default branch — regex is anchored to integration|staging only', async () => {
    await queue(makeBatch('scrape-coordinator-foo'), fakeEnv, fakeCtx);
    expect(mockHandleCoordinator).not.toHaveBeenCalled();
    const unknownCall = mockLog.mock.calls.find(
      (args) => args[1] === 'digest.generation' && args[2]?.status === 'unknown_queue',
    );
    expect(unknownCall).toBeDefined();
  });

  it('REQ-PIPE-001: compound suffix scrape-coordinator-integration-shadow fails closed (default branch)', async () => {
    // The strip regex is `-(integration|staging)$` — anchored to the
    // end. A future shadow-queue pattern like
    // `scrape-coordinator-integration-shadow` does NOT match the strip
    // because `-shadow` follows the env suffix. The dispatcher
    // intentionally fails closed: route only to handlers we know about,
    // log unknown_queue otherwise. Pinning this so a future regex
    // widening to `-(integration|staging)(-\\w+)?$` is a deliberate
    // change instead of an emergent property.
    await queue(makeBatch('scrape-coordinator-integration-shadow'), fakeEnv, fakeCtx);
    expect(mockHandleCoordinator).not.toHaveBeenCalled();
    expect(mockHandleChunks).not.toHaveBeenCalled();
    expect(mockHandleFinalize).not.toHaveBeenCalled();
    const unknownCall = mockLog.mock.calls.find(
      (args) => args[1] === 'digest.generation' && args[2]?.status === 'unknown_queue',
    );
    expect(unknownCall).toBeDefined();
    expect(unknownCall?.[2].queue).toBe('scrape-coordinator-integration-shadow');
  });
});
