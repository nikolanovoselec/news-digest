// Tests for src/lib/scrape-run.ts — REQ-PIPE-006.
//
// All three helpers are thin wrappers over D1 prepared statements, so
// the tests assert on the bound parameters and the SQL shape rather
// than spinning up a real D1 instance. A separate integration test
// (added when migration 0003 lands) exercises the full table.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startRun, addChunkStats, finishRun } from '~/lib/scrape-run';

interface Call {
  sql: string;
  params: unknown[];
}

function makeDb(calls: Call[]): D1Database {
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: (...params: unknown[]) => ({
      run: vi.fn().mockImplementation(async () => {
        calls.push({ sql, params });
        return { success: true, meta: { changes: 1 } };
      }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
    }),
  }));
  return { prepare } as unknown as D1Database;
}

describe('scrape-run helpers — REQ-PIPE-006', () => {
  beforeEach(() => {
    // Pin time so the unix-seconds column is deterministic in assertions.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('REQ-PIPE-006: startRun inserts a row with status=running and started_at=now', async () => {
    const calls: Call[] = [];
    const db = makeDb(calls);
    const nowSeconds = Math.floor(new Date('2026-04-23T12:00:00Z').getTime() / 1000);

    await startRun(db, {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      model_id: '@cf/google/gemma-4-26b-a4b-it',
      chunk_count: 5,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.sql).toMatch(/INSERT\s+INTO\s+scrape_runs/i);
    expect(call.sql).toContain("'running'");
    // Param order: id, model_id, started_at, chunk_count
    expect(call.params[0]).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(call.params[1]).toBe('@cf/google/gemma-4-26b-a4b-it');
    expect(call.params[2]).toBe(nowSeconds);
    expect(call.params[3]).toBe(5);
  });

  it('REQ-PIPE-006: startRun defaults chunk_count to 0 when not provided (schema NOT NULL compliance)', async () => {
    // The schema declares `chunk_count INTEGER NOT NULL DEFAULT 0`.
    // Binding NULL explicitly bypasses the DEFAULT and trips the
    // constraint in production (observed live at 2026-04-23 via
    // /api/admin/force-refresh tail logs). Guard against that regression.
    const calls: Call[] = [];
    const db = makeDb(calls);
    await startRun(db, {
      id: 'run-id-2',
      model_id: '@cf/google/gemma-4-26b-a4b-it',
    });

    expect(calls).toHaveLength(1);
    expect((calls[0] as Call).params[3]).toBe(0);
    expect((calls[0] as Call).params[3]).not.toBeNull();
  });

  it('REQ-PIPE-006: addChunkStats accumulates tokens/cost/ingested/deduped', async () => {
    const calls: Call[] = [];
    const db = makeDb(calls);

    await addChunkStats(db, 'run-abc', {
      tokens_in: 5000,
      tokens_out: 1200,
      estimated_cost_usd: 0.0125,
      articles_ingested: 42,
      articles_deduped: 7,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    // Verify the column += ? pattern is present for every accumulator.
    expect(call.sql).toMatch(/tokens_in\s*=\s*tokens_in\s*\+/i);
    expect(call.sql).toMatch(/tokens_out\s*=\s*tokens_out\s*\+/i);
    expect(call.sql).toMatch(/estimated_cost_usd\s*=\s*estimated_cost_usd\s*\+/i);
    expect(call.sql).toMatch(/articles_ingested\s*=\s*articles_ingested\s*\+/i);
    expect(call.sql).toMatch(/articles_deduped\s*=\s*articles_deduped\s*\+/i);
    expect(call.sql).toMatch(/WHERE\s+id\s*=/i);

    // id first, then the five delta values.
    expect(call.params[0]).toBe('run-abc');
    expect(call.params).toContain(5000);
    expect(call.params).toContain(1200);
    expect(call.params).toContain(0.0125);
    expect(call.params).toContain(42);
    expect(call.params).toContain(7);
  });

  it('REQ-PIPE-006: finishRun transitions status to ready and sets finished_at', async () => {
    const calls: Call[] = [];
    const db = makeDb(calls);
    const nowSeconds = Math.floor(new Date('2026-04-23T12:00:00Z').getTime() / 1000);

    await finishRun(db, 'run-ready', 'ready');

    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.sql).toMatch(/UPDATE\s+scrape_runs/i);
    expect(call.sql).toMatch(/status\s*=/i);
    expect(call.sql).toMatch(/finished_at\s*=/i);
    expect(call.params).toContain('run-ready');
    expect(call.params).toContain('ready');
    expect(call.params).toContain(nowSeconds);
  });

  it('REQ-PIPE-006: finishRun with status=failed is allowed', async () => {
    const calls: Call[] = [];
    const db = makeDb(calls);

    await finishRun(db, 'run-failed', 'failed');

    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.params).toContain('failed');
    expect(call.params).toContain('run-failed');
  });
});
