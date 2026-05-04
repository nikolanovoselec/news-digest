// Implements REQ-PIPE-002 (CF-003) — articles-repo idempotency contract.
//
// recordChunkCompletion is the single idempotency gate that prevents
// chunk-redelivery double-counting of tokens, cost, and ingest counts
// in scrape_runs. The first call for a given (scrape_run_id, chunk_index)
// MUST return true; every subsequent call (queue redelivery, retry)
// MUST return false. Pin that contract here so the gate cannot regress.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, applyD1Migrations } from '../fixtures/cloudflare-test';
import { recordChunkCompletion } from '~/lib/articles-repo';

async function seedScrapeRun(id: string): Promise<void> {
  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO scrape_runs (id, model_id, started_at, status, chunk_count) VALUES (?1, 'test', 0, 'running', 0)`,
    )
    .bind(id)
    .run();
}

describe('recordChunkCompletion — REQ-PIPE-002 / CF-003', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.DB_MIGRATIONS ?? []);
  });

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM scrape_chunk_completions');
  });

  it('REQ-PIPE-002: first call wins (returns true), second call for same (run, chunk) returns false', async () => {
    const runId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    await seedScrapeRun(runId);

    const first = await recordChunkCompletion(env.DB, runId, 0);
    const second = await recordChunkCompletion(env.DB, runId, 0);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('REQ-PIPE-002: distinct (run, chunk) pairs each independently win once', async () => {
    const runId = '01ARZ3NDEKTSV4RRFFQ69G5FBW';
    await seedScrapeRun(runId);

    const c0 = await recordChunkCompletion(env.DB, runId, 0);
    const c1 = await recordChunkCompletion(env.DB, runId, 1);
    const c0Again = await recordChunkCompletion(env.DB, runId, 0);

    expect(c0).toBe(true);
    expect(c1).toBe(true);
    expect(c0Again).toBe(false);

    const rows = await env.DB
      .prepare('SELECT chunk_index FROM scrape_chunk_completions WHERE scrape_run_id = ?1 ORDER BY chunk_index')
      .bind(runId)
      .all<{ chunk_index: number }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results?.[0]?.chunk_index).toBe(0);
    expect(rows.results?.[1]?.chunk_index).toBe(1);
  });

  it('REQ-PIPE-002: completed_at is recorded on the row of the winning call', async () => {
    const runId = '01ARZ3NDEKTSV4RRFFQ69G5FCX';
    await seedScrapeRun(runId);

    const completedAt = 1700000000;
    const first = await recordChunkCompletion(env.DB, runId, 5, completedAt);
    expect(first).toBe(true);

    const row = await env.DB
      .prepare('SELECT completed_at FROM scrape_chunk_completions WHERE scrape_run_id = ?1 AND chunk_index = ?2')
      .bind(runId, 5)
      .first<{ completed_at: number }>();
    expect(row?.completed_at).toBe(completedAt);
  });
});
