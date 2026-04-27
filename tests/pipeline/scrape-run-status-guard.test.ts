// Integration test for src/lib/scrape-run.ts finishRun status-flap guard
// — REQ-PIPE-006.
//
// Uses @cloudflare/vitest-pool-workers + miniflare-backed D1 so the
// `WHERE status = 'running'` predicate is actually evaluated. The unit
// tests in scrape-run.test.ts use a vi.fn() mock that does not execute
// SQL, so they cannot catch a regression that drops the guard.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, applyD1Migrations } from '../fixtures/cloudflare-test';
import { startRun, finishRun } from '~/lib/scrape-run';

const RUN_ID = '01JSCRAPERUNGUARDTEST000001';

async function readStatus(): Promise<string | null> {
  const row = await env.DB
    .prepare('SELECT status FROM scrape_runs WHERE id = ?1')
    .bind(RUN_ID)
    .first<{ status: string }>();
  return row?.status ?? null;
}

describe('finishRun — REQ-PIPE-006 status-flap guard', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.DB_MIGRATIONS ?? []);
  });

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM scrape_runs');
  });

  it('REQ-PIPE-006: a finished run stays ready when a late failed chunk re-enters finishRun', async () => {
    // Seed a run that has already reached the terminal 'ready' state
    // (e.g. via the COUNT(*) gate after the last chunk inserted).
    await startRun(env.DB, {
      id: RUN_ID,
      model_id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
      chunk_count: 3,
    });
    await finishRun(env.DB, RUN_ID, 'ready');
    expect(await readStatus()).toBe('ready');

    // A late-arriving chunk (its retries exhausted *after* the run was
    // already finalized) tries to mark the run failed. The guard must
    // suppress this so the dashboard does not flap from ready to failed.
    await finishRun(env.DB, RUN_ID, 'failed');
    expect(await readStatus()).toBe('ready');
  });

  it('REQ-PIPE-006: a running run still transitions to ready normally', async () => {
    await startRun(env.DB, {
      id: RUN_ID,
      model_id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
      chunk_count: 1,
    });
    expect(await readStatus()).toBe('running');

    await finishRun(env.DB, RUN_ID, 'ready');
    expect(await readStatus()).toBe('ready');
  });

  it('REQ-PIPE-006: a running run still transitions to failed normally', async () => {
    await startRun(env.DB, {
      id: RUN_ID,
      model_id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
      chunk_count: 1,
    });
    expect(await readStatus()).toBe('running');

    await finishRun(env.DB, RUN_ID, 'failed');
    expect(await readStatus()).toBe('failed');
  });

  it('REQ-PIPE-006: an already-failed run does not re-flip on second failed write', async () => {
    await startRun(env.DB, {
      id: RUN_ID,
      model_id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
      chunk_count: 1,
    });
    await finishRun(env.DB, RUN_ID, 'failed');
    const firstFinishedAt = await env.DB
      .prepare('SELECT finished_at FROM scrape_runs WHERE id = ?1')
      .bind(RUN_ID)
      .first<{ finished_at: number }>();
    expect(firstFinishedAt?.finished_at).toBeTypeOf('number');

    // Idempotency: a second failed write is a no-op (status already
    // left 'running'). finished_at must not shift.
    await new Promise((r) => setTimeout(r, 1100));
    await finishRun(env.DB, RUN_ID, 'failed');
    const secondFinishedAt = await env.DB
      .prepare('SELECT finished_at FROM scrape_runs WHERE id = ?1')
      .bind(RUN_ID)
      .first<{ finished_at: number }>();
    expect(secondFinishedAt?.finished_at).toBe(firstFinishedAt?.finished_at);
  });
});
