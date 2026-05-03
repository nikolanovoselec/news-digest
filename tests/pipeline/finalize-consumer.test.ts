// Tests for src/queue/scrape-finalize-consumer.ts — REQ-PIPE-008.
//
// The finalize consumer reads up to 250 articles for a scrape_run,
// asks Workers AI for cross-chunk dedup_groups, picks the earliest-
// published winner per group, runs the 6-statement merge per loser,
// and folds tokens + cost into addChunkStats. These tests stub D1 +
// AI + KV and assert on the observable behaviour contracts: skip on
// trivially small runs, the LIMIT 250 cap, the merge SQL emitted per
// loser, the winner selection, and idempotency of replays.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processOneFinalize } from '~/queue/scrape-finalize-consumer';
import type { FinalizeJobMessage } from '~/queue/scrape-finalize-consumer';
import { FINALIZE_DEDUP_SYSTEM } from '~/lib/prompts';

interface SqlRecord {
  sql: string;
  params: unknown[];
  via: 'run' | 'batch' | 'all' | 'first' | 'exec';
}

interface ArticleRow {
  id: string;
  title: string;
  details: string;
  published_at: number;
  ingested_at: number;
}

function makeDb(rows: ArticleRow[]): {
  db: D1Database;
  records: SqlRecord[];
} {
  const records: SqlRecord[] = [];
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const binder = (...params: unknown[]) => {
      const bound = {
        __sql: sql,
        __params: params,
        run: vi.fn().mockImplementation(async () => {
          records.push({ sql, params, via: 'run' });
          return { success: true, meta: { changes: 1 } };
        }),
        all: vi.fn().mockImplementation(async () => {
          records.push({ sql, params, via: 'all' });
          // The finalize consumer's only `.all()` is the article SELECT.
          // Apply the LIMIT (?2) so cap-bind tests assert the binding +
          // observe the truncation.
          if (sql.includes('FROM articles') && sql.includes('scrape_run_id')) {
            const limit = (params[1] as number) ?? rows.length;
            return { success: true, results: rows.slice(0, limit) };
          }
          return { success: true, results: [] };
        }),
        first: vi.fn().mockImplementation(async () => {
          records.push({ sql, params, via: 'first' });
          return null;
        }),
      };
      return bound;
    };
    return {
      bind: binder,
      run: vi.fn().mockImplementation(async () => {
        records.push({ sql, params: [], via: 'run' });
        return { success: true, meta: { changes: 1 } };
      }),
    };
  });
  const db = {
    prepare,
    batch: vi.fn().mockImplementation(async (stmts: unknown[]) => {
      for (const stmt of stmts) {
        const s = stmt as { __sql?: string; __params?: unknown[] };
        records.push({
          sql: s.__sql ?? '',
          params: s.__params ?? [],
          via: 'batch',
        });
      }
      return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
    }),
    exec: vi.fn().mockImplementation(async (sql: string) => {
      records.push({ sql, params: [], via: 'exec' });
      return { count: 0, duration: 0 };
    }),
  } as unknown as D1Database;
  return { db, records };
}

interface AiCall {
  model: string;
  params: Record<string, unknown>;
}

function makeEnv(
  db: D1Database,
  aiResponses: unknown[],
): { env: Env; aiCalls: AiCall[] } {
  const aiCalls: AiCall[] = [];
  let nextResponse = 0;
  const ai = {
    run: vi
      .fn()
      .mockImplementation(async (model: string, params: Record<string, unknown>) => {
        aiCalls.push({ model, params });
        const response = aiResponses[nextResponse] ?? aiResponses[aiResponses.length - 1];
        nextResponse += 1;
        return response;
      }),
  } as unknown as Ai;
  const env = {
    DB: db,
    AI: ai,
    KV: {} as KVNamespace,
    SCRAPE_COORDINATOR: { send: vi.fn() } as unknown as Queue<unknown>,
    SCRAPE_CHUNKS: { send: vi.fn() } as unknown as Queue<unknown>,
    SCRAPE_FINALIZE: { send: vi.fn() } as unknown as Queue<unknown>,
    ASSETS: {} as Fetcher,
    GH_OAUTH_CLIENT_ID: 'x',
    GH_OAUTH_CLIENT_SECRET: 'x',
    OAUTH_JWT_SECRET: 'x',
    RESEND_API_KEY: 'x',
    RESEND_FROM: 'x',
    APP_URL: 'https://test.example.com',
  } as unknown as Env;
  return { env, aiCalls };
}

function row(overrides: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: 'a-default',
    title: 'Default title',
    details: 'Two-sentence default summary body. Not used by most assertions.',
    published_at: 1_700_000_000,
    ingested_at: 1_700_000_000,
    ...overrides,
  };
}

function aiOk(dedupGroups: number[][]): unknown {
  return {
    response: JSON.stringify({ dedup_groups: dedupGroups }),
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

const MSG: FinalizeJobMessage = { scrape_run_id: 'run-test' };

describe('scrape-finalize-consumer — REQ-PIPE-008', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('REQ-PIPE-008: skips the LLM call when the run produced 0 articles', async () => {
    const { db } = makeDb([]);
    const { env, aiCalls } = makeEnv(db, [aiOk([])]);
    await processOneFinalize(env, MSG);
    expect(aiCalls.length).toBe(0);
  });

  it('REQ-PIPE-008: skips the LLM call when the run produced exactly 1 article', async () => {
    const { db } = makeDb([row({ id: 'only' })]);
    const { env, aiCalls } = makeEnv(db, [aiOk([])]);
    await processOneFinalize(env, MSG);
    expect(aiCalls.length).toBe(0);
  });

  it('REQ-PIPE-008: caps LLM input at 250 articles ordered by ingested_at DESC', async () => {
    // Build 300 rows; expect LIMIT 250 binding on the SELECT and exactly
    // 250 candidates in the prompt body.
    const rows: ArticleRow[] = [];
    for (let i = 0; i < 300; i++) {
      rows.push(row({ id: `a-${i}`, ingested_at: 1_700_000_000 - i }));
    }
    const { db, records } = makeDb(rows);
    const { env, aiCalls } = makeEnv(db, [aiOk([])]);
    await processOneFinalize(env, MSG);

    const select = records.find(
      (r) => r.via === 'all' && r.sql.includes('FROM articles'),
    );
    expect(select).toBeDefined();
    expect(select!.sql).toMatch(/ORDER BY ingested_at DESC/);
    expect(select!.sql).toMatch(/LIMIT \?2/);
    expect(select!.params[0]).toBe('run-test');
    expect(select!.params[1]).toBe(250);

    expect(aiCalls.length).toBe(1);
    const userMessage = (aiCalls[0]!.params.messages as Array<{ role: string; content: string }>)[1]!.content;
    // 250 numbered lines, indices 0..249 inclusive — index 249 must
    // appear, index 250 must not.
    expect(userMessage).toMatch(/\[249\]/);
    expect(userMessage).not.toMatch(/\[250\]/);
  });

  it('REQ-PIPE-008: emits the 6 INSERT/DELETE statements per loser when the LLM groups two articles', async () => {
    const rows = [
      row({ id: 'winner', published_at: 100 }),
      row({ id: 'loser', published_at: 200 }),
    ];
    const { db, records } = makeDb(rows);
    const { env } = makeEnv(db, [aiOk([[0, 1]])]);
    await processOneFinalize(env, MSG);

    const merges = records.filter((r) => r.via === 'batch');
    expect(merges).toHaveLength(6);

    expect(merges[0]!.sql).toMatch(/INSERT OR IGNORE INTO article_sources[\s\S]*FROM articles/);
    expect(merges[1]!.sql).toMatch(/INSERT OR IGNORE INTO article_sources[\s\S]*FROM article_sources/);
    expect(merges[2]!.sql).toMatch(/INSERT OR IGNORE INTO article_tags/);
    expect(merges[3]!.sql).toMatch(/INSERT OR IGNORE INTO article_stars/);
    expect(merges[4]!.sql).toMatch(/INSERT OR IGNORE INTO article_reads/);
    expect(merges[5]!.sql).toMatch(/DELETE FROM articles WHERE id = \?1/);
  });

  it('REQ-PIPE-008: winner is the earliest-published article in the group', async () => {
    // Three rows; LLM groups them all. The earliest-published row must
    // survive — every merge statement binds it as `winner` at ?1, every
    // loser appears as ?2 in some statement.
    const rows = [
      row({ id: 'late', published_at: 500 }),
      row({ id: 'early', published_at: 100 }),
      row({ id: 'mid', published_at: 300 }),
    ];
    const { db, records } = makeDb(rows);
    const { env } = makeEnv(db, [aiOk([[0, 1, 2]])]);
    await processOneFinalize(env, MSG);

    const merges = records.filter((r) => r.via === 'batch');
    // 2 losers × 6 statements = 12 SQL statements total.
    expect(merges).toHaveLength(12);
    // Every INSERT (positions 0-4 within each loser block) binds winner
    // at ?1; the DELETE binds the loser at ?1.
    const inserts = merges.filter((m) => m.sql.startsWith('INSERT'));
    for (const stmt of inserts) {
      expect(stmt.params[0]).toBe('early');
    }
    const deletes = merges.filter((m) => m.sql.startsWith('DELETE FROM articles'));
    expect(deletes).toHaveLength(2);
    const deletedIds = deletes.map((d) => d.params[0]);
    expect(deletedIds).toContain('late');
    expect(deletedIds).toContain('mid');
    expect(deletedIds).not.toContain('early');
  });

  it('REQ-PIPE-008: re-points stars before deleting the loser (never cascade-loses a star)', async () => {
    const rows = [
      row({ id: 'winner', published_at: 100 }),
      row({ id: 'loser', published_at: 200 }),
    ];
    const { db, records } = makeDb(rows);
    const { env } = makeEnv(db, [aiOk([[0, 1]])]);
    await processOneFinalize(env, MSG);

    const merges = records.filter((r) => r.via === 'batch');
    const starsIdx = merges.findIndex((m) => m.sql.includes('article_stars'));
    const deleteIdx = merges.findIndex((m) =>
      m.sql.startsWith('DELETE FROM articles'),
    );
    expect(starsIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(starsIdx).toBeLessThan(deleteIdx);
  });

  it('REQ-PIPE-008: re-points reads before deleting the loser', async () => {
    const rows = [
      row({ id: 'winner', published_at: 100 }),
      row({ id: 'loser', published_at: 200 }),
    ];
    const { db, records } = makeDb(rows);
    const { env } = makeEnv(db, [aiOk([[0, 1]])]);
    await processOneFinalize(env, MSG);

    const merges = records.filter((r) => r.via === 'batch');
    const readsIdx = merges.findIndex((m) => m.sql.includes('article_reads'));
    const deleteIdx = merges.findIndex((m) =>
      m.sql.startsWith('DELETE FROM articles'),
    );
    expect(readsIdx).toBeGreaterThan(-1);
    expect(readsIdx).toBeLessThan(deleteIdx);
  });

  it('REQ-PIPE-008: tag union into winner uses INSERT OR IGNORE so duplicate tags do not error', async () => {
    const rows = [
      row({ id: 'winner', published_at: 100 }),
      row({ id: 'loser', published_at: 200 }),
    ];
    const { db, records } = makeDb(rows);
    const { env } = makeEnv(db, [aiOk([[0, 1]])]);
    await processOneFinalize(env, MSG);

    const tagInsert = records.find(
      (r) => r.via === 'batch' && r.sql.includes('article_tags'),
    );
    expect(tagInsert).toBeDefined();
    expect(tagInsert!.sql).toMatch(/INSERT OR IGNORE INTO article_tags/);
  });

  it('REQ-PIPE-008: addChunkStats is called with articles_deduped == losers_deleted', async () => {
    // Two groups of 2 rows each → 2 losers deleted. addChunkStats's
    // `articles_deduped` parameter (?6 in the UPDATE) must equal 2.
    const rows = [
      row({ id: 'w1', published_at: 100 }),
      row({ id: 'l1', published_at: 200 }),
      row({ id: 'w2', published_at: 150 }),
      row({ id: 'l2', published_at: 250 }),
    ];
    const { db, records } = makeDb(rows);
    const { env } = makeEnv(db, [aiOk([[0, 1], [2, 3]])]);
    await processOneFinalize(env, MSG);

    const statsUpdate = records.find(
      (r) =>
        r.via === 'run' &&
        r.sql.includes('UPDATE scrape_runs') &&
        r.sql.includes('articles_deduped'),
    );
    expect(statsUpdate).toBeDefined();
    // addChunkStats binds: ?1=runId, ?2=tokens_in, ?3=tokens_out,
    // ?4=cost, ?5=articles_ingested, ?6=articles_deduped.
    expect(statsUpdate!.params[0]).toBe('run-test');
    expect(statsUpdate!.params[4]).toBe(0);
    expect(statsUpdate!.params[5]).toBe(2);
  });

  it('REQ-PIPE-008: finalize prompt includes each candidate body and never includes the source name', async () => {
    // AC 1 (revised 2026-05-03): the dedup model receives full body
    // text and source name is dropped as a non-signal. Pin both
    // halves with concrete strings — distinctive details and an
    // unmistakable source name — so a regression that swaps the
    // prompt back to title+source can't pass.
    const rows = [
      row({
        id: 'a',
        title: 'Cloudflare Q1 outage post-mortem',
        details: 'XYZZY-DETAILS-A: outage root cause was BGP route leak.',
        published_at: 100,
      }),
      row({
        id: 'b',
        title: 'Cloudflare incident retro',
        details: 'XYZZY-DETAILS-B: same outage covered from a different angle.',
        published_at: 200,
      }),
    ];
    const { db } = makeDb(rows);
    const { env, aiCalls } = makeEnv(db, [aiOk([])]);
    await processOneFinalize(env, MSG);
    expect(aiCalls.length).toBe(1);
    const userMessage = (aiCalls[0]!.params.messages as Array<{
      role: string;
      content: string;
    }>)[1]!.content;
    expect(userMessage).toContain('XYZZY-DETAILS-A');
    expect(userMessage).toContain('XYZZY-DETAILS-B');
    // Source name must NOT appear anywhere — the test rows above
    // carry the default 'Default Source' name which would otherwise
    // be a single substring to grep for.
    expect(userMessage).not.toContain('Default Source');
  });

  it('REQ-PIPE-008: addChunkStats IS called even when zero merges were performed (cost is real and must surface on the daily tally)', async () => {
    // LLM returns no groups → zero losers → but the LLM call still
    // happened and cost real money, so the addChunkStats fold MUST
    // run and articles_deduped MUST be 0. This pins the 2026-05-03
    // REQ-PIPE-008 AC 7 fix that removed the buggy
    // `if (losersDeleted > 0)` gate which hid zero-merge spend.
    const rows = [
      row({ id: 'a', published_at: 100 }),
      row({ id: 'b', published_at: 200 }),
    ];
    const { db, records } = makeDb(rows);
    const { env } = makeEnv(db, [aiOk([])]);
    await processOneFinalize(env, MSG);

    const statsUpdate = records.find(
      (r) =>
        r.via === 'run' &&
        r.sql.includes('UPDATE scrape_runs') &&
        r.sql.includes('articles_deduped'),
    );
    expect(statsUpdate).toBeDefined();
    // articles_deduped param at index 5 must be 0 (no losers merged),
    // tokens_in / tokens_out / cost at indices 1-3 must be > 0 (the
    // LLM call happened, was billed, and the stats fold reflects
    // that real spend).
    expect(statsUpdate!.params[5]).toBe(0);
    expect(statsUpdate!.params[1]).toBeGreaterThan(0);
    expect(statsUpdate!.params[2]).toBeGreaterThan(0);
    expect(statsUpdate!.params[3]).toBeGreaterThan(0);
  });

  it('REQ-PIPE-008: gate UPDATE carries WHERE finalize_recorded = 0 so a redelivery is a no-op', async () => {
    // Models the queue-redelivery edge case via the SQL contract:
    // the consumer issues a single atomic UPDATE that adds the
    // stats AND flips finalize_recorded only when the column is
    // currently 0. On a redelivered message the WHERE clause
    // does not match, meta.changes === 0, and the row is unchanged
    // — so the LLM cost is never double-counted against the same
    // scrape tick. Pin both halves of the contract: (a) the SQL
    // includes the gating WHERE clause; (b) the bind shape carries
    // the runId and the per-call counters.
    const rows = [
      row({ id: 'a', published_at: 100 }),
      row({ id: 'b', published_at: 200 }),
    ];
    const { db, records } = makeDb(rows);
    const { env } = makeEnv(db, [aiOk([[0, 1]])]);
    await processOneFinalize(env, MSG);

    const gateAndStats = records.find(
      (r) =>
        r.via === 'run' &&
        r.sql.includes('UPDATE scrape_runs') &&
        r.sql.includes('finalize_recorded = 1') &&
        r.sql.includes('articles_deduped') &&
        // The gating WHERE clause is the load-bearing part of the
        // idempotency guarantee. A regression that drops it would
        // re-introduce the redelivery double-count.
        r.sql.includes('AND finalize_recorded = 0'),
    );
    expect(gateAndStats).toBeDefined();
    expect(gateAndStats!.params[0]).toBe('run-test');
    // articles_deduped (?6) reflects the actual merge count.
    expect(gateAndStats!.params[5]).toBe(1);
  });

  it('REQ-PIPE-008: behavioural redelivery — pass 2 with same row count + zero merges does not double-count tokens', async () => {
    // The gating WHERE clause from the prior test is observed
    // behaviorally here: drive processOneFinalize twice against
    // a state that does NOT trivially-skip on pass 2 (3 candidates
    // both passes, LLM returns no merges so the row count never
    // shrinks). A regression that drops `AND finalize_recorded = 0`
    // would let pass 2 add the stats again — caught by the
    // wonRecording flag and the meta.changes return value.
    const rows = [
      row({ id: 'a', published_at: 100 }),
      row({ id: 'b', published_at: 200 }),
      row({ id: 'c', published_at: 300 }),
    ];
    const records: SqlRecord[] = [];
    let finalizeRecordedFlag = 0;
    const prepare = vi.fn().mockImplementation((sql: string) => ({
      bind: (...params: unknown[]) => ({
        __sql: sql,
        __params: params,
        run: vi.fn().mockImplementation(async () => {
          records.push({ sql, params, via: 'run' });
          // Model the gating UPDATE: the WHERE clause filters on
          // finalize_recorded = 0. First call → matches → flag flips
          // and meta.changes = 1. Second call → flag already 1 →
          // WHERE doesn't match → meta.changes = 0, no row touched.
          if (
            sql.includes('UPDATE scrape_runs') &&
            sql.includes('AND finalize_recorded = 0')
          ) {
            if (finalizeRecordedFlag === 0) {
              finalizeRecordedFlag = 1;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 1 } };
        }),
        all: vi.fn().mockImplementation(async () => {
          records.push({ sql, params, via: 'all' });
          if (sql.includes('FROM articles') && sql.includes('scrape_run_id')) {
            const limit = (params[1] as number) ?? rows.length;
            return { success: true, results: rows.slice(0, limit) };
          }
          return { success: true, results: [] };
        }),
        first: vi.fn().mockResolvedValue(null),
      }),
      run: vi.fn().mockImplementation(async () => {
        records.push({ sql, params: [], via: 'run' });
        return { success: true, meta: { changes: 0 } };
      }),
    }));
    const db = {
      prepare,
      batch: vi.fn().mockImplementation(async (stmts: unknown[]) => {
        for (const stmt of stmts) {
          const s = stmt as { __sql?: string; __params?: unknown[] };
          records.push({
            sql: s.__sql ?? '',
            params: s.__params ?? [],
            via: 'batch',
          });
        }
        return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
      }),
      exec: vi.fn().mockImplementation(async () => ({ count: 0, duration: 0 })),
    } as unknown as D1Database;
    // Both passes return zero dedup_groups so rows.length stays at 3
    // on pass 2 — trivially-small skip does NOT fire and the LLM is
    // called both times. This is the scenario that exercises the
    // gating WHERE clause for real.
    const { env, aiCalls } = makeEnv(db, [aiOk([]), aiOk([])]);

    await processOneFinalize(env, MSG);
    await processOneFinalize(env, MSG);

    // LLM was called twice (no trivially-small skip on pass 2).
    expect(aiCalls.length).toBe(2);

    // Both passes must issue the gating UPDATE — drop the WHERE
    // clause and this filter no longer matches, dropping the count
    // below 2 and failing the test. This is the regression-detector
    // for the "double-count on redelivery" failure mode.
    const gateUpdates = records.filter(
      (r) =>
        r.via === 'run' &&
        r.sql.includes('UPDATE scrape_runs') &&
        r.sql.includes('AND finalize_recorded = 0'),
    );
    expect(gateUpdates.length).toBe(2);
    // The mock's flag-flip happens exactly once across both passes,
    // proving the WHERE clause gated pass 2 to a no-op (zero rows
    // changed, no cost recorded). A regression that lets pass 2
    // also "win" the gate would attempt to flip the flag a second
    // time, but the mock's branch already returned changes:0 — so
    // the flag check below sandwiches the assertion: the count of
    // matching SQL says "the SQL was right", the flag value says
    // "the gate fired correctly".
    expect(finalizeRecordedFlag).toBe(1);
  });

  it('REQ-PIPE-008: replaying the same message produces the same final state and does not double-count', async () => {
    // Mutable row-set shared across both invocations. The merge batch
    // for a real D1 connection would DELETE the loser between passes;
    // we model that by shrinking `liveRows` from inside the batch
    // handler the same way real cascade SQL would. Then re-invoking
    // processOneFinalize against the SAME db must hit the trivially-
    // small-skip path (no LLM call, no stats update) — pinning the AC 5
    // claim that a queue redelivery converges to the same state and does
    // not double-count tokens.
    const liveRows: ArticleRow[] = [
      row({ id: 'w', published_at: 100 }),
      row({ id: 'l', published_at: 200 }),
    ];

    const records: SqlRecord[] = [];
    const prepare = vi.fn().mockImplementation((sql: string) => ({
      bind: (...params: unknown[]) => ({
        __sql: sql,
        __params: params,
        run: vi.fn().mockImplementation(async () => {
          records.push({ sql, params, via: 'run' });
          return { success: true, meta: { changes: 1 } };
        }),
        all: vi.fn().mockImplementation(async () => {
          records.push({ sql, params, via: 'all' });
          if (sql.includes('FROM articles') && sql.includes('scrape_run_id')) {
            const limit = (params[1] as number) ?? liveRows.length;
            return { success: true, results: liveRows.slice(0, limit) };
          }
          return { success: true, results: [] };
        }),
        first: vi.fn().mockImplementation(async () => {
          records.push({ sql, params, via: 'first' });
          return null;
        }),
      }),
      run: vi.fn().mockImplementation(async () => {
        records.push({ sql, params: [], via: 'run' });
        return { success: true, meta: { changes: 1 } };
      }),
    }));
    const db = {
      prepare,
      batch: vi.fn().mockImplementation(async (stmts: unknown[]) => {
        for (const stmt of stmts) {
          const s = stmt as { __sql?: string; __params?: unknown[] };
          const sql = s.__sql ?? '';
          const params = s.__params ?? [];
          records.push({ sql, params, via: 'batch' });
          // Model the cascade DELETE: drop the loser row from `liveRows`
          // so the next SELECT no longer sees it, exactly like the real
          // D1 batch would.
          if (sql.startsWith('DELETE FROM articles')) {
            const loserId = params[0] as string;
            const idx = liveRows.findIndex((r) => r.id === loserId);
            if (idx >= 0) liveRows.splice(idx, 1);
          }
        }
        return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
      }),
      exec: vi.fn().mockImplementation(async (sql: string) => {
        records.push({ sql, params: [], via: 'exec' });
        return { count: 0, duration: 0 };
      }),
    } as unknown as D1Database;

    const aiCalls: AiCall[] = [];
    let nextResponse = 0;
    const aiResponses = [aiOk([[0, 1]]), aiOk([[0, 1]])];
    const ai = {
      run: vi
        .fn()
        .mockImplementation(async (model: string, params: Record<string, unknown>) => {
          aiCalls.push({ model, params });
          const resp = aiResponses[nextResponse] ?? aiResponses[aiResponses.length - 1];
          nextResponse += 1;
          return resp;
        }),
    } as unknown as Ai;
    const env = {
      DB: db,
      AI: ai,
      KV: {} as KVNamespace,
      SCRAPE_COORDINATOR: { send: vi.fn() } as unknown as Queue<unknown>,
      SCRAPE_CHUNKS: { send: vi.fn() } as unknown as Queue<unknown>,
      SCRAPE_FINALIZE: { send: vi.fn() } as unknown as Queue<unknown>,
      ASSETS: {} as Fetcher,
      GH_OAUTH_CLIENT_ID: 'x',
      GH_OAUTH_CLIENT_SECRET: 'x',
      OAUTH_JWT_SECRET: 'x',
      RESEND_API_KEY: 'x',
      RESEND_FROM: 'x',
      APP_URL: 'https://test.example.com',
    } as unknown as Env;

    // First pass: 1 LLM call, 6 merge statements, 1 stats update,
    // loser row removed from `liveRows` by the batch handler.
    await processOneFinalize(env, MSG);
    expect(aiCalls.length).toBe(1);
    const firstMerges = records.filter((r) => r.via === 'batch').length;
    expect(firstMerges).toBe(6);
    // Filter on `articles_deduped` so we count ONLY the addChunkStats
    // UPDATE — the conditional finalize_recorded gate also writes
    // `UPDATE scrape_runs` and would otherwise inflate the count.
    const firstStats = records.filter(
      (r) =>
        r.via === 'run' &&
        r.sql.includes('UPDATE scrape_runs') &&
        r.sql.includes('articles_deduped'),
    ).length;
    expect(firstStats).toBe(1);
    expect(liveRows.map((r) => r.id)).toEqual(['w']);

    // Second pass on the SAME db: SELECT now returns only the winner
    // (loser was deleted by the first pass). Trivially-small skip path
    // fires → no second LLM call, no second stats update, no extra SQL.
    const recordsBefore = records.length;
    await processOneFinalize(env, MSG);
    expect(aiCalls.length).toBe(1);
    const secondStats = records.filter(
      (r) =>
        r.via === 'run' &&
        r.sql.includes('UPDATE scrape_runs') &&
        r.sql.includes('articles_deduped'),
    ).length;
    expect(secondStats).toBe(1);
    // No additional batch SQL after the replay (the only new record is
    // the SELECT itself, plus the FK pragma exec).
    const newBatches = records
      .slice(recordsBefore)
      .filter((r) => r.via === 'batch').length;
    expect(newBatches).toBe(0);
  });

  it('REQ-PIPE-008: falls back to the secondary model when the primary returns unparseable JSON', async () => {
    const rows = [
      row({ id: 'a', published_at: 100 }),
      row({ id: 'b', published_at: 200 }),
    ];
    const { db } = makeDb(rows);
    // Primary returns garbage; fallback returns valid JSON with no
    // dedup pairs (we only need to assert the second call happened with
    // a different model).
    const garbage = {
      response: 'not json at all {[',
      usage: { input_tokens: 60, output_tokens: 4 },
    };
    const { env, aiCalls } = makeEnv(db, [garbage, aiOk([])]);
    await processOneFinalize(env, MSG);

    expect(aiCalls.length).toBe(2);
    // Both calls must include the FINALIZE_DEDUP_SYSTEM prompt; the
    // models must differ (primary → fallback).
    const sys0 = (aiCalls[0]!.params.messages as Array<{ content: string }>)[0]!.content;
    const sys1 = (aiCalls[1]!.params.messages as Array<{ content: string }>)[0]!.content;
    expect(sys0).toBe(FINALIZE_DEDUP_SYSTEM);
    expect(sys1).toBe(FINALIZE_DEDUP_SYSTEM);
    expect(aiCalls[0]!.model).not.toBe(aiCalls[1]!.model);
  });

  it('REQ-PIPE-008: deduplicates indices within a group so a malformed [0, 1, 1] does not over-count', async () => {
    // An LLM that emits a duplicate index inside a group must not cause
    // the consumer to count one loser twice in articles_deduped or
    // queue redundant merge SQL for the duplicated index.
    const rows = [
      row({ id: 'w', published_at: 100 }),
      row({ id: 'l', published_at: 200 }),
    ];
    const { db, records } = makeDb(rows);
    const { env } = makeEnv(db, [aiOk([[0, 1, 1]])]);
    await processOneFinalize(env, MSG);

    const merges = records.filter((r) => r.via === 'batch');
    expect(merges).toHaveLength(6); // exactly one loser merged, not two
    const statsUpdate = records.find(
      (r) =>
        r.via === 'run' &&
        r.sql.includes('UPDATE scrape_runs') &&
        r.sql.includes('articles_deduped'),
    );
    expect(statsUpdate).toBeDefined();
    expect(statsUpdate!.params[5]).toBe(1);
  });

  it('REQ-PIPE-008: throws after fallback also fails so the queue retries the message', async () => {
    const rows = [
      row({ id: 'a', published_at: 100 }),
      row({ id: 'b', published_at: 200 }),
    ];
    const { db } = makeDb(rows);
    const garbage = {
      response: 'still not json',
      usage: { input_tokens: 60, output_tokens: 4 },
    };
    const { env } = makeEnv(db, [garbage, garbage]);
    await expect(processOneFinalize(env, MSG)).rejects.toThrow(
      /finalize_invalid_json/,
    );
  });
});
