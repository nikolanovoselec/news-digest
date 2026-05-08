// Tests for src/queue/pipeline-consumer.ts — REQ-OPS-008.
//
// The pipeline-consumer drives the seven phases of a "Full pipeline
// run" via self-chained `pipeline-jobs` queue messages. Coverage:
//   1. Missing audit row short-circuits without throwing.
//   2. Already-terminal audit row short-circuits.
//   3. reembed_flip flips embeddings to 'failed' and advances to
//      reembed_drain.
//   4. scrape_kick kicks the coordinator and advances to scrape_wait
//      with scrape_run_id stamped.
//   5. scrape_wait re-enqueues with delaySeconds while the scrape is
//      still running (or finalize hasn't recorded yet).
//   6. scrape_wait advances to embed_drain when scrape is ready and
//      finalize_recorded=1.
//   7. embed_drain advances to dedup_kick when no more articles
//      remain to embed.
//   8. embed_drain self-chains while remaining > 0.
//   9. dedup_kick inserts dedup_runs and enqueues DEDUP_SWEEP.
//  10. dedup_wait advances to status='done' when dedup_runs.status='done'.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks: we don't want the helpers (kickCoordinator,
// runOneBackfillBatch) to actually execute their internal logic in
// these unit tests — we just want to verify that the consumer
// dispatches them correctly and reacts to their return values.
vi.mock('~/lib/kick-coordinator', () => ({
  kickCoordinator: vi.fn(),
}));
vi.mock('~/pages/api/admin/embed-backfill', () => ({
  runOneBackfillBatch: vi.fn(),
}));

import { processOnePipelineMessage } from '~/queue/pipeline-consumer';
import { kickCoordinator } from '~/lib/kick-coordinator';
import { runOneBackfillBatch } from '~/pages/api/admin/embed-backfill';

interface DbCalls {
  updates: Array<{ sql: string; params: unknown[] }>;
  inserts: Array<{ sql: string; params: unknown[] }>;
}

/** Build a D1Database stub seeded with one pipeline_runs row plus
 *  optional scrape_runs / dedup_runs probes for the wait phases. */
function makeDb(opts: {
  pipelineRow?: {
    id: string;
    status: string;
    mode: 'full' | 'wipe';
    current_phase: string;
    scrape_run_id: string | null;
    dedup_run_id: string | null;
    embed_processed: number;
    embed_remaining: number;
  } | null;
  scrapeRow?: { status: string; finalize_recorded: number } | null;
  dedupRow?: { status: string } | null;
}): { db: D1Database; calls: DbCalls } {
  const calls: DbCalls = { updates: [], inserts: [] };
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const bound: unknown[] = [];
    const ops = {
      first: vi.fn().mockImplementation(async () => {
        if (sql.includes('FROM pipeline_runs')) {
          return opts.pipelineRow ?? null;
        }
        if (sql.includes('FROM scrape_runs')) {
          return opts.scrapeRow ?? null;
        }
        if (sql.includes('FROM dedup_runs')) {
          return opts.dedupRow ?? null;
        }
        return null;
      }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockImplementation(async () => {
        if (sql.startsWith('UPDATE')) {
          calls.updates.push({ sql, params: [...bound] });
        } else if (sql.startsWith('INSERT')) {
          calls.inserts.push({ sql, params: [...bound] });
        }
        return { success: true, meta: { changes: 1 } };
      }),
    };
    return {
      ...ops,
      bind: (...params: unknown[]) => {
        bound.push(...params);
        return ops;
      },
    } as unknown as D1PreparedStatement;
  });
  return {
    db: { prepare, batch: vi.fn() } as unknown as D1Database,
    calls,
  };
}

function makeQueue(): { queue: Queue; sends: Array<{ msg: unknown; opts: unknown }> } {
  const sends: Array<{ msg: unknown; opts: unknown }> = [];
  const queue = {
    send: vi.fn().mockImplementation(async (msg: unknown, opts?: unknown) => {
      sends.push({ msg, opts });
    }),
    sendBatch: vi.fn(),
  } as unknown as Queue;
  return { queue, sends };
}

const RUN_ID = '01PIPELINERUN00000000000AA';

beforeEach(() => {
  vi.mocked(kickCoordinator).mockReset();
  vi.mocked(runOneBackfillBatch).mockReset();
});

describe('processOnePipelineMessage — REQ-OPS-008', () => {
  it('short-circuits without throwing when audit row is missing', async () => {
    const { db, calls } = makeDb({ pipelineRow: null });
    const { queue: pq, sends } = makeQueue();
    const env = {
      DB: db,
      PIPELINE_JOBS: pq,
      SCRAPE_COORDINATOR: makeQueue().queue,
      DEDUP_SWEEP: makeQueue().queue,
    } as unknown as Env;
    await processOnePipelineMessage(env, {
      pipeline_run_id: RUN_ID,
      phase: 'scrape_kick',
    });
    expect(calls.updates.length).toBe(0);
    expect(sends.length).toBe(0);
  });

  it('short-circuits when audit row is already terminal', async () => {
    const { db, calls } = makeDb({
      pipelineRow: {
        id: RUN_ID,
        status: 'done',
        mode: 'full',
        current_phase: 'done',
        scrape_run_id: null,
        dedup_run_id: null,
        embed_processed: 0,
        embed_remaining: 0,
      },
    });
    const { queue: pq, sends } = makeQueue();
    const env = {
      DB: db,
      PIPELINE_JOBS: pq,
      SCRAPE_COORDINATOR: makeQueue().queue,
      DEDUP_SWEEP: makeQueue().queue,
    } as unknown as Env;
    await processOnePipelineMessage(env, {
      pipeline_run_id: RUN_ID,
      phase: 'dedup_wait',
    });
    expect(calls.updates.length).toBe(0);
    expect(sends.length).toBe(0);
  });

  it('reembed_flip flips embeddings to failed and advances to reembed_drain', async () => {
    const { db, calls } = makeDb({
      pipelineRow: {
        id: RUN_ID,
        status: 'running',
        mode: 'wipe',
        current_phase: 'reembed_flip',
        scrape_run_id: null,
        dedup_run_id: null,
        embed_processed: 0,
        embed_remaining: 0,
      },
    });
    const { queue: pq, sends } = makeQueue();
    const env = {
      DB: db,
      PIPELINE_JOBS: pq,
      SCRAPE_COORDINATOR: makeQueue().queue,
      DEDUP_SWEEP: makeQueue().queue,
    } as unknown as Env;
    await processOnePipelineMessage(env, {
      pipeline_run_id: RUN_ID,
      phase: 'reembed_flip',
    });
    // First update is the flip-all, second is the phase advance.
    const flipAll = calls.updates.find((c) =>
      c.sql.includes("SET embedding_status = 'failed'"),
    );
    expect(flipAll).toBeDefined();
    const advance = calls.updates.find(
      (c) =>
        c.sql.includes('UPDATE pipeline_runs') &&
        c.sql.includes('current_phase'),
    );
    expect(advance).toBeDefined();
    // Bound params: id, toPhase, now, fromPhase
    expect(advance!.params[0]).toBe(RUN_ID);
    expect(advance!.params[1]).toBe('reembed_drain');
    expect(advance!.params[3]).toBe('reembed_flip');
    // Continuation message enqueued.
    expect(sends.length).toBe(1);
    expect(sends[0]!.msg).toEqual({
      pipeline_run_id: RUN_ID,
      phase: 'reembed_drain',
    });
  });

  it('scrape_kick calls kickCoordinator and advances to scrape_wait', async () => {
    vi.mocked(kickCoordinator).mockResolvedValue({
      run_id: '01SCRAPERUN0000000000000BB',
      reused: false,
    });
    const { db, calls } = makeDb({
      pipelineRow: {
        id: RUN_ID,
        status: 'running',
        mode: 'full',
        current_phase: 'scrape_kick',
        scrape_run_id: null,
        dedup_run_id: null,
        embed_processed: 0,
        embed_remaining: 0,
      },
    });
    const { queue: pq, sends } = makeQueue();
    const env = {
      DB: db,
      PIPELINE_JOBS: pq,
      SCRAPE_COORDINATOR: makeQueue().queue,
      DEDUP_SWEEP: makeQueue().queue,
    } as unknown as Env;
    await processOnePipelineMessage(env, {
      pipeline_run_id: RUN_ID,
      phase: 'scrape_kick',
    });
    expect(kickCoordinator).toHaveBeenCalledTimes(1);
    const advance = calls.updates.find(
      (c) =>
        c.sql.includes('UPDATE pipeline_runs') &&
        c.sql.includes("current_phase = 'scrape_wait'"),
    );
    expect(advance).toBeDefined();
    expect(advance!.params[0]).toBe(RUN_ID);
    expect(advance!.params[1]).toBe('01SCRAPERUN0000000000000BB');
    expect(sends[0]!.msg).toEqual({
      pipeline_run_id: RUN_ID,
      phase: 'scrape_wait',
    });
  });

  it('scrape_wait re-enqueues with delaySeconds while scrape is still running', async () => {
    const { db } = makeDb({
      pipelineRow: {
        id: RUN_ID,
        status: 'running',
        mode: 'full',
        current_phase: 'scrape_wait',
        scrape_run_id: '01SCRAPERUN0000000000000BB',
        dedup_run_id: null,
        embed_processed: 0,
        embed_remaining: 0,
      },
      scrapeRow: { status: 'running', finalize_recorded: 0 },
    });
    const { queue: pq, sends } = makeQueue();
    const env = {
      DB: db,
      PIPELINE_JOBS: pq,
      SCRAPE_COORDINATOR: makeQueue().queue,
      DEDUP_SWEEP: makeQueue().queue,
    } as unknown as Env;
    await processOnePipelineMessage(env, {
      pipeline_run_id: RUN_ID,
      phase: 'scrape_wait',
    });
    expect(sends.length).toBe(1);
    expect(sends[0]!.msg).toEqual({
      pipeline_run_id: RUN_ID,
      phase: 'scrape_wait',
    });
    // delaySeconds option present so the queue holds the message.
    const opts = sends[0]!.opts as { delaySeconds?: number } | undefined;
    expect(opts?.delaySeconds).toBeGreaterThan(0);
  });

  it('scrape_wait advances to embed_drain when scrape is ready and finalize recorded', async () => {
    const { db, calls } = makeDb({
      pipelineRow: {
        id: RUN_ID,
        status: 'running',
        mode: 'full',
        current_phase: 'scrape_wait',
        scrape_run_id: '01SCRAPERUN0000000000000BB',
        dedup_run_id: null,
        embed_processed: 0,
        embed_remaining: 0,
      },
      scrapeRow: { status: 'ready', finalize_recorded: 1 },
    });
    const { queue: pq, sends } = makeQueue();
    const env = {
      DB: db,
      PIPELINE_JOBS: pq,
      SCRAPE_COORDINATOR: makeQueue().queue,
      DEDUP_SWEEP: makeQueue().queue,
    } as unknown as Env;
    await processOnePipelineMessage(env, {
      pipeline_run_id: RUN_ID,
      phase: 'scrape_wait',
    });
    const advance = calls.updates.find(
      (c) => c.sql.includes('UPDATE pipeline_runs') && c.params[1] === 'embed_drain',
    );
    expect(advance).toBeDefined();
    expect(sends[0]!.msg).toEqual({
      pipeline_run_id: RUN_ID,
      phase: 'embed_drain',
    });
  });

  it('embed_drain advances to dedup_kick when batch reports done:true', async () => {
    vi.mocked(runOneBackfillBatch).mockResolvedValue({
      ok: true,
      processed: 12,
      failed: 0,
      remaining: 0,
      done: true,
    });
    const { db, calls } = makeDb({
      pipelineRow: {
        id: RUN_ID,
        status: 'running',
        mode: 'full',
        current_phase: 'embed_drain',
        scrape_run_id: '01SCRAPERUN0000000000000BB',
        dedup_run_id: null,
        embed_processed: 0,
        embed_remaining: 0,
      },
    });
    const { queue: pq, sends } = makeQueue();
    const env = {
      DB: db,
      PIPELINE_JOBS: pq,
      SCRAPE_COORDINATOR: makeQueue().queue,
      DEDUP_SWEEP: makeQueue().queue,
    } as unknown as Env;
    await processOnePipelineMessage(env, {
      pipeline_run_id: RUN_ID,
      phase: 'embed_drain',
    });
    const advance = calls.updates.find((c) =>
      c.sql.includes("current_phase = ?2") && c.params[1] === 'dedup_kick',
    );
    expect(advance).toBeDefined();
    expect(sends[0]!.msg).toEqual({
      pipeline_run_id: RUN_ID,
      phase: 'dedup_kick',
    });
  });

  it('embed_drain self-chains while remaining > 0', async () => {
    vi.mocked(runOneBackfillBatch).mockResolvedValue({
      ok: true,
      processed: 50,
      failed: 0,
      remaining: 100,
      done: false,
    });
    const { db } = makeDb({
      pipelineRow: {
        id: RUN_ID,
        status: 'running',
        mode: 'full',
        current_phase: 'embed_drain',
        scrape_run_id: '01SCRAPERUN0000000000000BB',
        dedup_run_id: null,
        embed_processed: 0,
        embed_remaining: 0,
      },
    });
    const { queue: pq, sends } = makeQueue();
    const env = {
      DB: db,
      PIPELINE_JOBS: pq,
      SCRAPE_COORDINATOR: makeQueue().queue,
      DEDUP_SWEEP: makeQueue().queue,
    } as unknown as Env;
    await processOnePipelineMessage(env, {
      pipeline_run_id: RUN_ID,
      phase: 'embed_drain',
    });
    expect(sends.length).toBe(1);
    expect(sends[0]!.msg).toEqual({
      pipeline_run_id: RUN_ID,
      phase: 'embed_drain',
    });
  });

  it('dedup_kick inserts dedup_runs row and enqueues DEDUP_SWEEP message', async () => {
    const { db, calls } = makeDb({
      pipelineRow: {
        id: RUN_ID,
        status: 'running',
        mode: 'full',
        current_phase: 'dedup_kick',
        scrape_run_id: '01SCRAPERUN0000000000000BB',
        dedup_run_id: null,
        embed_processed: 200,
        embed_remaining: 0,
      },
    });
    const { queue: pq, sends: pqSends } = makeQueue();
    const { queue: dedupQ, sends: dedupSends } = makeQueue();
    const env = {
      DB: db,
      PIPELINE_JOBS: pq,
      SCRAPE_COORDINATOR: makeQueue().queue,
      DEDUP_SWEEP: dedupQ,
    } as unknown as Env;
    await processOnePipelineMessage(env, {
      pipeline_run_id: RUN_ID,
      phase: 'dedup_kick',
    });
    expect(calls.inserts.length).toBe(1);
    expect(calls.inserts[0]!.sql).toContain('INSERT INTO dedup_runs');
    expect(dedupSends.length).toBe(1);
    expect(pqSends[0]!.msg).toEqual({
      pipeline_run_id: RUN_ID,
      phase: 'dedup_wait',
    });
  });

  it('dedup_wait flips pipeline to status=done when dedup_runs.status=done', async () => {
    const { db, calls } = makeDb({
      pipelineRow: {
        id: RUN_ID,
        status: 'running',
        mode: 'full',
        current_phase: 'dedup_wait',
        scrape_run_id: '01SCRAPERUN0000000000000BB',
        dedup_run_id: '01DEDUPRUN00000000000000CC',
        embed_processed: 200,
        embed_remaining: 0,
      },
      dedupRow: { status: 'done' },
    });
    const { queue: pq, sends } = makeQueue();
    const env = {
      DB: db,
      PIPELINE_JOBS: pq,
      SCRAPE_COORDINATOR: makeQueue().queue,
      DEDUP_SWEEP: makeQueue().queue,
    } as unknown as Env;
    await processOnePipelineMessage(env, {
      pipeline_run_id: RUN_ID,
      phase: 'dedup_wait',
    });
    const flip = calls.updates.find((c) =>
      c.sql.includes("status = 'done'") && c.sql.includes('pipeline_runs'),
    );
    expect(flip).toBeDefined();
    expect(sends.length).toBe(0);
  });
});
