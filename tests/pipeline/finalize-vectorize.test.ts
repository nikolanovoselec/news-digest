// Tests for src/queue/scrape-finalize-consumer.ts — REQ-PIPE-003.
//
// Covers the semantic-dedup behavior: per-article Vectorize.queryById
// followed by mergeAsAltSource for any older sufficiently-similar
// match. Mocks Vectorize at the binding boundary.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processOneFinalize } from '~/queue/scrape-finalize-consumer';

interface DbCall {
  sql: string;
  params: unknown[];
}

interface MockDb {
  db: D1Database;
  calls: DbCall[];
  /** Article rows the SELECT will return (in order). */
  articleRows: Array<{
    id: string;
    published_at: number;
    ingested_at: number;
  }>;
  /** finalize_recorded value the gate probe returns. */
  finalizeRecorded: number;
  /** id-existence rows for the existence guard query. */
  existsIds: Set<string>;
  /** Last-flipped wonRecording outcome. */
  flipChanges: number;
}

function makeMockDb(opts: {
  articleRows: MockDb['articleRows'];
  finalizeRecorded?: number;
  existsIds?: Set<string>;
  flipChanges?: number;
}): MockDb {
  const calls: DbCall[] = [];
  const finalizeRecorded = opts.finalizeRecorded ?? 0;
  const existsIds = opts.existsIds ?? new Set<string>();
  const flipChanges = opts.flipChanges ?? 1;

  const prepare = vi.fn().mockImplementation((sql: string) => {
    return {
      bind: (...params: unknown[]) => {
        const stmt = {
          sql,
          params,
          first: vi.fn().mockImplementation(() => {
            calls.push({ sql, params });
            if (sql.includes('finalize_recorded FROM scrape_runs')) {
              return Promise.resolve({ finalize_recorded: finalizeRecorded });
            }
            if (sql.includes('SELECT 1 AS present FROM articles')) {
              const id = params[0] as string;
              return existsIds.has(id)
                ? Promise.resolve({ present: 1 })
                : Promise.resolve(null);
            }
            return Promise.resolve(null);
          }),
          all: vi.fn().mockImplementation(() => {
            calls.push({ sql, params });
            if (sql.includes('FROM articles\n        WHERE scrape_run_id')) {
              return Promise.resolve({ results: opts.articleRows });
            }
            return Promise.resolve({ results: [] });
          }),
          run: vi.fn().mockImplementation(() => {
            calls.push({ sql, params });
            if (sql.includes('UPDATE scrape_runs')) {
              return Promise.resolve({ meta: { changes: flipChanges } });
            }
            return Promise.resolve({ meta: { changes: 0 } });
          }),
        } as unknown as D1PreparedStatement;
        return stmt;
      },
    } as unknown as D1PreparedStatement;
  });

  const batch = vi.fn().mockImplementation((statements: unknown[]) => {
    for (const stmt of statements) {
      const s = stmt as { sql?: string; params?: unknown[] };
      if (typeof s.sql === 'string') {
        calls.push({ sql: s.sql, params: s.params ?? [] });
      }
    }
    return Promise.resolve([]);
  });

  const exec = vi.fn().mockResolvedValue(undefined);

  return {
    db: { prepare, batch, exec } as unknown as D1Database,
    calls,
    articleRows: opts.articleRows,
    finalizeRecorded,
    existsIds,
    flipChanges,
  };
}

interface MockVectorize {
  binding: Vectorize;
  queryByIdMock: ReturnType<typeof vi.fn>;
  deleteMock: ReturnType<typeof vi.fn>;
}

function makeMockVectorize(matchesById: Map<string, VectorizeMatch[]>): MockVectorize {
  const queryByIdMock = vi.fn().mockImplementation((id: string) => {
    return Promise.resolve({
      count: matchesById.get(id)?.length ?? 0,
      matches: matchesById.get(id) ?? [],
    });
  });
  const deleteMock = vi.fn().mockResolvedValue({ count: 0, ids: [] });
  return {
    binding: {
      queryById: queryByIdMock,
      query: vi.fn(),
      upsert: vi.fn(),
      deleteByIds: deleteMock,
    } as unknown as Vectorize,
    queryByIdMock,
    deleteMock,
  };
}

function makeEnv(db: D1Database, vectorize: Vectorize): Env {
  return {
    DB: db,
    VECTORIZE: vectorize,
    DEDUP_COSINE_THRESHOLD: '0.85',
  } as unknown as Env;
}

describe('processOneFinalize — REQ-PIPE-003', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('REQ-PIPE-003: no-ops when run already has finalize_recorded=1', async () => {
    const mockDb = makeMockDb({
      articleRows: [],
      finalizeRecorded: 1,
    });
    const mockVec = makeMockVectorize(new Map());
    const env = makeEnv(mockDb.db, mockVec.binding);
    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(mockVec.queryByIdMock).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003: merges new article into older Vectorize match above threshold', async () => {
    const newId = 'new-1';
    const oldId = 'old-1';
    const mockDb = makeMockDb({
      articleRows: [{ id: newId, published_at: 2000, ingested_at: 2000 }],
      existsIds: new Set([oldId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: oldId,
        score: 0.9,
        metadata: { published_at: 1000 },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding);

    await processOneFinalize(env, { scrape_run_id: 'r1' });

    // Six merge statements (mergeAsAltSource) were submitted to D1.batch.
    const mergeStmts = mockDb.calls.filter(
      (c) =>
        c.sql.includes('article_sources') ||
        c.sql.includes('article_tags') ||
        c.sql.includes('article_stars') ||
        c.sql.includes('article_reads') ||
        c.sql.match(/^DELETE FROM articles WHERE id = \?1$/),
    );
    expect(mergeStmts.length).toBeGreaterThanOrEqual(6);
    // Existing article wins — its id binds to ?1 in the merge SQL.
    const insertSourceStmt = mergeStmts.find((s) =>
      s.sql.includes('FROM articles WHERE id = ?2'),
    );
    expect(insertSourceStmt?.params[0]).toBe(oldId);
    expect(insertSourceStmt?.params[1]).toBe(newId);
    // The new article's vector is dropped from Vectorize.
    expect(mockVec.deleteMock).toHaveBeenCalledTimes(1);
    expect(mockVec.deleteMock).toHaveBeenCalledWith([newId]);
  });

  it('REQ-PIPE-003: skips matches with score below threshold', async () => {
    const newId = 'new-1';
    const oldId = 'old-1';
    const mockDb = makeMockDb({
      articleRows: [{ id: newId, published_at: 2000, ingested_at: 2000 }],
      existsIds: new Set([oldId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: oldId,
        score: 0.5,
        metadata: { published_at: 1000 },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding);

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(mockVec.deleteMock).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003: never merges into a match with newer or equal published_at', async () => {
    const newId = 'new-1';
    const newerId = 'newer-1';
    const equalId = 'equal-1';
    const mockDb = makeMockDb({
      articleRows: [{ id: newId, published_at: 2000, ingested_at: 2000 }],
      existsIds: new Set([newerId, equalId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: newerId,
        score: 0.95,
        metadata: { published_at: 3000 },
      } as unknown as VectorizeMatch,
      {
        id: equalId,
        score: 0.95,
        metadata: { published_at: 2000 },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding);

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(mockVec.deleteMock).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003: picks the OLDEST among multiple qualifying matches', async () => {
    const newId = 'new-1';
    const old1 = 'old-1';
    const old2 = 'old-2';
    const mockDb = makeMockDb({
      articleRows: [{ id: newId, published_at: 2000, ingested_at: 2000 }],
      existsIds: new Set([old1, old2]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: old1,
        score: 0.86,
        metadata: { published_at: 1500 },
      } as unknown as VectorizeMatch,
      {
        id: old2,
        score: 0.92,
        metadata: { published_at: 1000 },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding);

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    // old2 has the earlier published_at, so it wins regardless of cosine.
    const insertSourceStmt = mockDb.calls.find((c) =>
      c.sql.includes('FROM articles WHERE id = ?2'),
    );
    expect(insertSourceStmt?.params[0]).toBe(old2);
  });

  it('REQ-PIPE-003: skips a match whose D1 row is gone (stale-vector race)', async () => {
    const newId = 'new-1';
    const goneId = 'old-gone';
    const mockDb = makeMockDb({
      articleRows: [{ id: newId, published_at: 2000, ingested_at: 2000 }],
      existsIds: new Set(), // gone-id NOT in existsIds → null
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: goneId,
        score: 0.95,
        metadata: { published_at: 1000 },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding);

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(mockVec.deleteMock).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003: still flips the gate when zero articles have vectors', async () => {
    const mockDb = makeMockDb({ articleRows: [] });
    const mockVec = makeMockVectorize(new Map());
    const env = makeEnv(mockDb.db, mockVec.binding);

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    const gateUpdate = mockDb.calls.find((c) =>
      c.sql.includes('UPDATE scrape_runs'),
    );
    expect(gateUpdate).toBeDefined();
  });
});
