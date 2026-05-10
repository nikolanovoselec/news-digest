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
    title?: string;
    source_snippet?: string | null;
    published_at: number;
    ingested_at: number;
    primary_source_url: string;
  }>;
  /** finalize_recorded value the gate probe returns. */
  finalizeRecorded: number;
  /** id-existence rows for the existence guard query. */
  existsIds: Set<string>;
  /** Title + snippet rows the rerank existence-fetch returns. */
  existingArticleData: Map<
    string,
    { title: string; source_snippet: string | null }
  >;
  /** Last-flipped wonRecording outcome. */
  flipChanges: number;
}

function makeMockDb(opts: {
  articleRows: MockDb['articleRows'];
  finalizeRecorded?: number;
  existsIds?: Set<string>;
  existingArticleData?: MockDb['existingArticleData'];
  flipChanges?: number;
}): MockDb {
  const calls: DbCall[] = [];
  const finalizeRecorded = opts.finalizeRecorded ?? 0;
  const existsIds = opts.existsIds ?? new Set<string>();
  const existingArticleData = opts.existingArticleData ?? new Map();
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
            if (sql.includes('SELECT id, title, source_snippet FROM articles')) {
              const id = params[0] as string;
              const data = existingArticleData.get(id);
              if (data !== undefined) {
                return Promise.resolve({
                  id,
                  title: data.title,
                  source_snippet: data.source_snippet,
                });
              }
              return Promise.resolve(null);
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
    existingArticleData,
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

interface MockSweepQueue {
  binding: Queue;
  sends: unknown[];
}

function makeMockSweepQueue(): MockSweepQueue {
  const sends: unknown[] = [];
  const send = vi.fn().mockImplementation(async (msg: unknown) => {
    sends.push(msg);
  });
  return {
    binding: { send, sendBatch: vi.fn() } as unknown as Queue,
    sends,
  };
}

function makeEnv(
  db: D1Database,
  vectorize: Vectorize,
  opts: {
    sameVendorPenalty?: string;
    rerankFloor?: string;
    cosineThreshold?: string;
    highConfidenceCosine?: string;
    aiBinding?: { run: (model: string, params: Record<string, unknown>) => Promise<unknown> };
    sweepQueue?: Queue;
  } = {},
): Env {
  return {
    DB: db,
    VECTORIZE: vectorize,
    DEDUP_SWEEP: opts.sweepQueue ?? makeMockSweepQueue().binding,
    AI: opts.aiBinding ?? {
      run: vi.fn().mockResolvedValue({ response: '{"same_event":false}' }),
    },
    DEDUP_COSINE_THRESHOLD: opts.cosineThreshold ?? '0.85',
    DEDUP_SAME_VENDOR_PENALTY: opts.sameVendorPenalty ?? '0.05',
    DEDUP_RERANK_FLOOR: opts.rerankFloor ?? '0.72',
    DEDUP_HIGH_CONFIDENCE_COSINE: opts.highConfidenceCosine ?? '0.92',
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
      articleRows: [
        {
          id: newId,
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://newsite.example/post/2',
        },
      ],
      existsIds: new Set([oldId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: oldId,
        score: 0.9,
        metadata: {
          published_at: 1000,
          primary_source_url: 'https://oldsite.example/post/1',
        },
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
      articleRows: [
        {
          id: newId,
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://newsite.example/post/2',
        },
      ],
      existsIds: new Set([oldId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: oldId,
        score: 0.5,
        metadata: {
          published_at: 1000,
          primary_source_url: 'https://oldsite.example/post/1',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding);

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(mockVec.deleteMock).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003 AD40: equal-published_at pair merges when self has newer ULID (tie-break)', async () => {
    // self.id='new-1' > match.id='equal-1' lexicographically (n > e),
    // so self is the newer ULID and should fold into match — parallels
    // the historical-dedup tie-break the finalize loop was missing.
    // Equal published_at is common with wire-syndicated stories that
    // share epoch-second resolution after RSS pubDate parsing.
    const newId = 'new-1';
    const equalId = 'equal-1';
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: newId,
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://newsite.example/post/2',
        },
      ],
      existsIds: new Set([equalId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: equalId,
        score: 0.95,
        metadata: {
          published_at: 2000,
          primary_source_url: 'https://other.example/b',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding);

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(mockVec.deleteMock).toHaveBeenCalledWith([newId]);
  });

  it('REQ-PIPE-003 AC 15 (AD41): equal-published_at pair merges when self has older ULID (match folds into self)', async () => {
    // self.id='aaa-1' < match.id='zzz-1' lexicographically, so self is
    // the older ULID and wins the tie-break. With bidirectional finalize
    // (AD41), the merge fires in this iteration with self as winner —
    // the match (zzz-1) is deleted from Vectorize. Pre-AD41 this side
    // skipped on the assumption the other iteration would handle it,
    // which left clusters un-merged when the match was already stored
    // and never re-finalized.
    const selfId = 'aaa-1';
    const matchId = 'zzz-1';
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: selfId,
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://newsite.example/a',
        },
      ],
      existsIds: new Set([matchId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(selfId, [
      {
        id: matchId,
        score: 0.95,
        metadata: {
          published_at: 2000,
          primary_source_url: 'https://other.example/z',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding);

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    // Match folds INTO self → loser is matchId, winner is selfId.
    expect(mockVec.deleteMock).toHaveBeenCalledTimes(1);
    expect(mockVec.deleteMock).toHaveBeenCalledWith([matchId]);
  });

  it('REQ-PIPE-003 AD40: high-confidence raw cosine auto-merges same-vendor pair (penalty bypassed)', async () => {
    // Wire-syndicated story scenario: same eTLD+1 publisher network,
    // raw cosine 0.93 (near-identical headlines). Without the high-
    // confidence band, the 0.05 vendor penalty would drop adjusted to
    // 0.88, which at AD39's 0.88 threshold is borderline (subject to
    // LLM rejection). The high-confidence band must bypass the penalty
    // and auto-merge so wire-syndicated near-duplicates land
    // deterministically.
    const newId = 'new-1';
    const oldId = 'old-1';
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: newId,
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://blog.example.com/new-post',
        },
      ],
      existsIds: new Set([oldId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: oldId,
        score: 0.93,
        metadata: {
          published_at: 1000,
          primary_source_url: 'https://news.example.com/old-post',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding, {
      // Threshold 0.85 (test default) + penalty 0.05 = adjusted 0.88;
      // without the high-confidence bypass we'd hit auto-merge anyway.
      // Force the bypass to be load-bearing by lifting the threshold
      // above adjusted: 0.93 - 0.05 = 0.88 < 0.90.
      cosineThreshold: '0.90',
      highConfidenceCosine: '0.92',
    });

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(mockVec.deleteMock).toHaveBeenCalledWith([newId]);
  });

  it('REQ-PIPE-003 AD40: same-vendor pair just below high-confidence band still subject to penalty', async () => {
    // Confirms the high-confidence band is a hard cutoff at the
    // configured cosine — pairs at 0.91 (just below 0.92) still get
    // the same-vendor penalty applied, falling into rerank or below.
    const newId = 'new-1';
    const oldId = 'old-1';
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: newId,
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://blog.example.com/new-post',
        },
      ],
      existsIds: new Set([oldId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: oldId,
        score: 0.91,
        metadata: {
          published_at: 1000,
          primary_source_url: 'https://news.example.com/old-post',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    // Default test AI binding returns same_event:false, so a pair that
    // lands in the rerank band ends up not merging.
    const env = makeEnv(mockDb.db, mockVec.binding, {
      cosineThreshold: '0.90',
      highConfidenceCosine: '0.92',
    });

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(mockVec.deleteMock).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003: picks the OLDEST among multiple qualifying matches', async () => {
    const newId = 'new-1';
    const old1 = 'old-1';
    const old2 = 'old-2';
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: newId,
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://newsite.example/post/2',
        },
      ],
      existsIds: new Set([old1, old2]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: old1,
        score: 0.86,
        metadata: {
          published_at: 1500,
          primary_source_url: 'https://aaa.example/x',
        },
      } as unknown as VectorizeMatch,
      {
        id: old2,
        score: 0.92,
        metadata: {
          published_at: 1000,
          primary_source_url: 'https://bbb.example/y',
        },
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
      articleRows: [
        {
          id: newId,
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://newsite.example/post/2',
        },
      ],
      existsIds: new Set(), // gone-id NOT in existsIds → null
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: goneId,
        score: 0.95,
        metadata: {
          published_at: 1000,
          primary_source_url: 'https://oldsite.example/post/1',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding);

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(mockVec.deleteMock).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003 AC 11: same-vendor pair just above threshold falls below after penalty (no merge)', async () => {
    const newId = 'new-1';
    const oldId = 'old-1';
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: newId,
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://blog.example.com/new-post',
        },
      ],
      existsIds: new Set([oldId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    // Raw cosine 0.87 > threshold 0.85, but same eTLD+1 → adjusted 0.82 < 0.85.
    matches.set(newId, [
      {
        id: oldId,
        score: 0.87,
        metadata: {
          published_at: 1000,
          primary_source_url: 'https://news.example.com/old-post',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding);

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(mockVec.deleteMock).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003 AC 11: same-vendor pair well above threshold still merges after penalty', async () => {
    const newId = 'new-1';
    const oldId = 'old-1';
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: newId,
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://blog.example.com/new-post',
        },
      ],
      existsIds: new Set([oldId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    // Raw cosine 0.95, same eTLD+1 → adjusted 0.90 still >= 0.85.
    matches.set(newId, [
      {
        id: oldId,
        score: 0.95,
        metadata: {
          published_at: 1000,
          primary_source_url: 'https://news.example.com/old-post',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding);

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(mockVec.deleteMock).toHaveBeenCalledWith([newId]);
  });

  it('REQ-PIPE-003 AC 11: cross-vendor pair just above threshold merges (penalty does not apply)', async () => {
    const newId = 'new-1';
    const oldId = 'old-1';
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: newId,
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://acme.example/new',
        },
      ],
      existsIds: new Set([oldId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    // Raw cosine 0.87, different eTLD+1 → no penalty, still >= 0.85.
    matches.set(newId, [
      {
        id: oldId,
        score: 0.87,
        metadata: {
          published_at: 1000,
          primary_source_url: 'https://other-publisher.example/old',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding);

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(mockVec.deleteMock).toHaveBeenCalledWith([newId]);
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

  it('REQ-PIPE-009: borderline cosine with LLM yes -> merges as alt-source', async () => {
    const newId = 'new-1';
    const oldId = 'old-1';
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: newId,
          title: 'Romania PM Ousted in No-Confidence Vote',
          source_snippet: 'Bolojan removed after coalition collapse.',
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://newsite.example/post/2',
        },
      ],
      existsIds: new Set([oldId]),
      existingArticleData: new Map([
        [
          oldId,
          {
            title: 'Romania Government Collapses as Far-Right Coalition Forms',
            source_snippet: 'Government falls; far-right coalition takes over.',
          },
        ],
      ]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: oldId,
        score: 0.78,
        metadata: {
          published_at: 1000,
          primary_source_url: 'https://oldsite.example/post/1',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const aiRun = vi
      .fn()
      .mockResolvedValue({ response: '{"same_event":true}' });
    const env = makeEnv(mockDb.db, mockVec.binding, {
      aiBinding: { run: aiRun },
    });

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(mockVec.deleteMock).toHaveBeenCalledWith([newId]);
  });

  it('REQ-PIPE-009 / AD42: top borderline rejected by LLM falls through to next candidate', async () => {
    // AD42 multi-rerank: the finalize consumer walks borderline
    // candidates in best-first order. If the top candidate is rejected
    // by the LLM rerank, the next candidate is reranked. If the second
    // is accepted, the article merges into THAT one.
    const newId = 'new-1';
    const topId = 'old-top';
    const nextId = 'old-next';
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: newId,
          title: 'Cloudflare Layoffs Spook Markets',
          source_snippet: 'Stock dives 23% on layoff news.',
          published_at: 3000,
          ingested_at: 3000,
          primary_source_url: 'https://newsite.example/cf-1',
        },
      ],
      existsIds: new Set([topId, nextId]),
      existingArticleData: new Map([
        [
          topId,
          {
            title: 'Different Topic Entirely',
            source_snippet: 'Unrelated story that happens to score similarly.',
          },
        ],
        [
          nextId,
          {
            title: 'Cloudflare Stock Falls After Layoff Announcement',
            source_snippet: 'Markets react to AI-driven workforce cut.',
          },
        ],
      ]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: topId,
        score: 0.84,
        metadata: {
          published_at: 2000,
          primary_source_url: 'https://oldsite.example/top',
        },
      } as unknown as VectorizeMatch,
      {
        id: nextId,
        score: 0.81,
        metadata: {
          published_at: 1500,
          primary_source_url: 'https://oldsite.example/next',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const aiRun = vi
      .fn()
      .mockResolvedValueOnce({ response: '{"same_event":false}' })
      .mockResolvedValueOnce({ response: '{"same_event":true}' });
    const env = makeEnv(mockDb.db, mockVec.binding, {
      aiBinding: { run: aiRun },
    });

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(aiRun).toHaveBeenCalledTimes(2);
    expect(mockVec.deleteMock).toHaveBeenCalledWith([newId]);
  });

  it('REQ-PIPE-009: borderline cosine with LLM no -> stays standalone', async () => {
    const newId = 'new-1';
    const oldId = 'old-1';
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: newId,
          title: 'OpenAI Releases GPT-7',
          source_snippet: 'New model with multimodal grounding.',
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://newsite.example/post/2',
        },
      ],
      existsIds: new Set([oldId]),
      existingArticleData: new Map([
        [
          oldId,
          {
            title: 'OpenAI Announces Sora 2',
            source_snippet: 'Improved video generation model.',
          },
        ],
      ]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: oldId,
        score: 0.78,
        metadata: {
          published_at: 1000,
          primary_source_url: 'https://oldsite.example/post/1',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const aiRun = vi
      .fn()
      .mockResolvedValue({ response: '{"same_event":false}' });
    const env = makeEnv(mockDb.db, mockVec.binding, {
      aiBinding: { run: aiRun },
    });

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(mockVec.deleteMock).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-009: auto-merge band (>= threshold) bypasses LLM rerank', async () => {
    const newId = 'new-1';
    const oldId = 'old-1';
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: newId,
          title: 'Anthropic Ships Claude 5',
          source_snippet: 'New flagship model.',
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://newsite.example/post/2',
        },
      ],
      existsIds: new Set([oldId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: oldId,
        score: 0.92,
        metadata: {
          published_at: 1000,
          primary_source_url: 'https://oldsite.example/post/1',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const aiRun = vi.fn();
    const env = makeEnv(mockDb.db, mockVec.binding, {
      aiBinding: { run: aiRun },
    });

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(aiRun).not.toHaveBeenCalled();
    expect(mockVec.deleteMock).toHaveBeenCalledWith([newId]);
  });

  it('REQ-PIPE-009: cosine below floor never invokes LLM', async () => {
    const newId = 'new-1';
    const oldId = 'old-1';
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: newId,
          title: 'Article A',
          source_snippet: 'snippet a',
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://newsite.example/post/2',
        },
      ],
      existsIds: new Set([oldId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: oldId,
        score: 0.5,
        metadata: {
          published_at: 1000,
          primary_source_url: 'https://oldsite.example/post/1',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const aiRun = vi.fn();
    const env = makeEnv(mockDb.db, mockVec.binding, {
      aiBinding: { run: aiRun },
    });

    await processOneFinalize(env, { scrape_run_id: 'r1' });
    expect(aiRun).not.toHaveBeenCalled();
    expect(mockVec.deleteMock).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003 AC 13: match outside the 72h time window is skipped despite high cosine', async () => {
    const newId = 'new-1';
    const oldId = 'old-9-days-ago';
    const NEW_PA = 1_700_000_000;
    const NINE_DAYS = 9 * 24 * 60 * 60;
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: newId,
          published_at: NEW_PA,
          ingested_at: NEW_PA,
          primary_source_url: 'https://newsite.example/post/2',
        },
      ],
      existsIds: new Set([oldId]),
    });
    // High cosine but match is 9 days older — outside the 72h window
    // so the time-window guard skips before any threshold check.
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: oldId,
        score: 0.95,
        metadata: {
          published_at: NEW_PA - NINE_DAYS,
          primary_source_url: 'https://oldsite.example/post/1',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding);
    await processOneFinalize(env, { scrape_run_id: 'r1' });
    // No merge statements were issued (no article_sources INSERTs).
    const mergeStmts = mockDb.calls.filter(
      (c) => c.sql.includes('article_sources') && c.sql.includes('INSERT'),
    );
    expect(mergeStmts).toHaveLength(0);
    expect(mockVec.deleteMock).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003 AC 13: match within the time window merges normally', async () => {
    const newId = 'new-1';
    const oldId = 'old-2-days-ago';
    const NEW_PA = 1_700_000_000;
    const TWO_DAYS = 2 * 24 * 60 * 60;
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: newId,
          published_at: NEW_PA,
          ingested_at: NEW_PA,
          primary_source_url: 'https://newsite.example/post/2',
        },
      ],
      existsIds: new Set([oldId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: oldId,
        score: 0.95,
        metadata: {
          published_at: NEW_PA - TWO_DAYS,
          primary_source_url: 'https://oldsite.example/post/1',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding);
    await processOneFinalize(env, { scrape_run_id: 'r1' });
    const mergeStmts = mockDb.calls.filter(
      (c) => c.sql.includes('article_sources') && c.sql.includes('INSERT'),
    );
    expect(mergeStmts.length).toBeGreaterThanOrEqual(1);
    expect(mockVec.deleteMock).toHaveBeenCalledWith([newId]);
  });

  it('REQ-PIPE-003 AC 13: time window is env-tunable (DEDUP_TIME_WINDOW_SECONDS=60 blocks a 5-minute spread)', async () => {
    const newId = 'new-1';
    const oldId = 'old-5-min-ago';
    const NEW_PA = 1_700_000_000;
    const FIVE_MIN = 5 * 60;
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: newId,
          published_at: NEW_PA,
          ingested_at: NEW_PA,
          primary_source_url: 'https://newsite.example/post/2',
        },
      ],
      existsIds: new Set([oldId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(newId, [
      {
        id: oldId,
        score: 0.95,
        metadata: {
          published_at: NEW_PA - FIVE_MIN,
          primary_source_url: 'https://oldsite.example/post/1',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    // Override window to 60s — five-minute delta is now outside.
    const env = {
      ...makeEnv(mockDb.db, mockVec.binding),
      DEDUP_TIME_WINDOW_SECONDS: '60',
    } as unknown as Env;
    await processOneFinalize(env, { scrape_run_id: 'r1' });
    const mergeStmts = mockDb.calls.filter(
      (c) => c.sql.includes('article_sources') && c.sql.includes('INSERT'),
    );
    expect(mergeStmts).toHaveLength(0);
    expect(mockVec.deleteMock).not.toHaveBeenCalled();
  });

  // AD41 — bidirectional finalize merge. The newly-ingested article
  // can be the OLDER side of the pair (slow-aggregator copy that
  // arrives in a later tick with an earlier published_at than its
  // already-stored match). The merge must still fire, with the late-
  // arriving older article as winner.
  it('REQ-PIPE-003 AC 15 (AD41): late-arriving older article absorbs already-stored newer match', async () => {
    const lateOlderId = 'late-older-1'; // just-ingested, OLDER published_at
    const storedNewerId = 'stored-newer-1'; // already in D1, NEWER published_at
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: lateOlderId,
          title: 'Late older title',
          source_snippet: 'snippet',
          published_at: 1_000_000, // OLDER
          ingested_at: 2_000_500, // ingested later
          primary_source_url: 'https://kron4.example/post/1',
        },
      ],
      existsIds: new Set([storedNewerId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set(lateOlderId, [
      {
        id: storedNewerId,
        score: 0.93, // raw above high-confidence band (cross-eTLD anyway)
        metadata: {
          published_at: 1_050_000, // NEWER than self by 50k seconds (~14h, < 72h window)
          primary_source_url: 'https://latimes.example/post/2',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding);

    await processOneFinalize(env, { scrape_run_id: 'r1' });

    // Merge must have fired with the LATE-ARRIVING-OLDER article
    // (lateOlderId) as winner — its id binds to ?1 in the alt-source
    // INSERT, the already-stored newer one (storedNewerId) is the
    // loser at ?2.
    const insertSourceStmt = mockDb.calls.find((c) =>
      c.sql.includes('FROM articles WHERE id = ?2'),
    );
    expect(insertSourceStmt?.params[0]).toBe(lateOlderId);
    expect(insertSourceStmt?.params[1]).toBe(storedNewerId);
    // The Vectorize delete targets the LOSER (storedNewerId), not self.
    expect(mockVec.deleteMock).toHaveBeenCalledTimes(1);
    expect(mockVec.deleteMock).toHaveBeenCalledWith([storedNewerId]);
  });

  // AD41 — bidirectional finalize must skip a candidate that was
  // already absorbed by an earlier iteration in the same pass. Without
  // the `losersDeleted.has(match.id)` guard, the second iteration
  // would attempt to merge against an article whose D1 row had just
  // been folded into the previous winner, producing either a
  // duplicate alt-source insert or a 404 on the loser-side fetch.
  it('REQ-PIPE-003 AC 15 (AD41): skips a Vectorize match that an earlier iteration in the same pass already absorbed', async () => {
    // Two newly-ingested rows A and B share the same Vectorize match
    // X (already stored). A iterates first and absorbs X (A is older,
    // selfIsOlder=true → X is loser). When B's iteration runs, X
    // re-appears in B's Vectorize results (the vector hasn't been
    // physically deleted yet — that happens in the trailing
    // deleteByIds batch). The skip must fire so B does NOT attempt a
    // second merge against X.
    const aId = 'a-older';
    const bId = 'b-newer';
    const xId = 'x-already-stored';
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: aId,
          title: 'a',
          source_snippet: 's',
          published_at: 1_000_000,
          ingested_at: 2_000_000,
          primary_source_url: 'https://aaa.example/post',
        },
        {
          id: bId,
          title: 'b',
          source_snippet: 's',
          // ~14h newer than X (50_000s delta) — strictly inside the
          // default 72h window so the time-window gate cannot mask
          // the skip-branch discriminator. Without `losersDeleted
          // .has(match.id)` at consumer.ts:302, B would proceed to
          // merge X (selfIsOlder=false → match older → self folds
          // into match) and produce a SECOND alt-source insert.
          published_at: 1_100_000,
          ingested_at: 2_000_001,
          primary_source_url: 'https://bbb.example/post',
        },
      ],
      existsIds: new Set([xId]),
    });
    const matches = new Map<string, VectorizeMatch[]>();
    // A's match list returns X (high-confidence cosine, ~14h delta).
    matches.set(aId, [
      {
        id: xId,
        score: 0.95,
        metadata: {
          published_at: 1_050_000,
          primary_source_url: 'https://ccc.example/post',
        },
      } as unknown as VectorizeMatch,
    ]);
    // B's match list ALSO returns X — but X has just been absorbed
    // into A and lives in losersDeleted. The skip must fire.
    matches.set(bId, [
      {
        id: xId,
        score: 0.95,
        metadata: {
          published_at: 1_050_000,
          primary_source_url: 'https://ccc.example/post',
        },
      } as unknown as VectorizeMatch,
    ]);
    const mockVec = makeMockVectorize(matches);
    const env = makeEnv(mockDb.db, mockVec.binding);

    await processOneFinalize(env, { scrape_run_id: 'r1' });

    // Exactly ONE Vectorize delete (X), enqueued by A's iteration.
    // B's iteration must NOT have produced a second delete call.
    expect(mockVec.deleteMock).toHaveBeenCalledTimes(1);
    expect(mockVec.deleteMock).toHaveBeenCalledWith([xId]);
    // Exactly ONE alt-source insert — A absorbed X. B must not have
    // produced a second insert against X.
    const insertSourceCalls = mockDb.calls.filter((c) =>
      c.sql.includes('FROM articles WHERE id = ?2'),
    );
    expect(insertSourceCalls).toHaveLength(1);
    expect(insertSourceCalls[0]?.params[0]).toBe(aId);
    expect(insertSourceCalls[0]?.params[1]).toBe(xId);
  });

  // AD41 — automatic post-tick dedup sweep. After a successful finalize
  // (gate flipped, wonRecording=true), exactly one DEDUP_SWEEP message
  // is enqueued with a non-null cursor scoped to the recent past, so
  // pairs the per-tick pass cannot see (Vectorize indexing latency,
  // late-arriving-older articles, etc.) get a second chance via the
  // queue-driven historical sweep.
  it('REQ-PIPE-003 AC 16 (AD41): enqueues a DEDUP_SWEEP message after successful finalize', async () => {
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: 'a-1',
          title: 't',
          source_snippet: 's',
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://a.example/x',
        },
      ],
      flipChanges: 1,
    });
    const matches = new Map<string, VectorizeMatch[]>();
    matches.set('a-1', []); // no candidates → no per-tick merge
    const mockVec = makeMockVectorize(matches);
    const sweepQueue = makeMockSweepQueue();
    const env = makeEnv(mockDb.db, mockVec.binding, {
      sweepQueue: sweepQueue.binding,
    });

    await processOneFinalize(env, { scrape_run_id: 'r1' });

    expect(sweepQueue.sends).toHaveLength(1);
    const msg = sweepQueue.sends[0] as {
      run_id: string;
      cursor: { pa: number; id: string } | null;
    };
    expect(typeof msg.run_id).toBe('string');
    expect(msg.run_id.length).toBeGreaterThan(0);
    expect(msg.cursor).not.toBeNull();
    expect(msg.cursor?.id).toBe('');
    expect(msg.cursor?.pa).toBeGreaterThan(0); // some recent epoch second
    // The cursor must seed the sweep at "now - 72h" - i.e., NOT 0
    // (which would scan the full corpus). 24h is a generous lower
    // bound; AUTO_SWEEP_LOOKBACK_SECONDS is 72h (AD42 widened from 48h
    // to match DEDUP_TIME_WINDOW_SECONDS).
    const now = Math.floor(Date.now() / 1000);
    expect(msg.cursor?.pa).toBeGreaterThan(now - 73 * 3600);
    expect(msg.cursor?.pa).toBeLessThan(now - 24 * 3600);
  });

  // AD41 — auto-sweep is best-effort. When the gate flip races and
  // loses (concurrent finalize redelivery), the auto-sweep MUST NOT
  // fire — only the winner enqueues the sweep, otherwise duplicate
  // sweeps would race on the same recent corpus tail.
  it('REQ-PIPE-003 AC 16 (AD41): does NOT enqueue DEDUP_SWEEP when gate flip loses race', async () => {
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: 'a-1',
          title: 't',
          source_snippet: 's',
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://a.example/x',
        },
      ],
      flipChanges: 0, // race lost — UPDATE found no rows where finalize_recorded=0
    });
    const mockVec = makeMockVectorize(new Map([['a-1', []]]));
    const sweepQueue = makeMockSweepQueue();
    const env = makeEnv(mockDb.db, mockVec.binding, {
      sweepQueue: sweepQueue.binding,
    });

    await processOneFinalize(env, { scrape_run_id: 'r1' });

    expect(sweepQueue.sends).toHaveLength(0);
  });

  // AD41 — when DEDUP_SWEEP.send rejects mid-flight (transient queue
  // outage, throttling), the dedup_runs row inserted by enqueueAutoSweep
  // must be flipped to status='failed' with the captured error message
  // so operators polling dedup_runs can distinguish a stuck-running row
  // from a sweep that's genuinely still walking. Mirrors the operator
  // path's behavior in /api/admin/historical-dedup.
  it('REQ-PIPE-003 AC 16 (AD41): flips dedup_runs to status=failed when queue.send rejects', async () => {
    const mockDb = makeMockDb({
      articleRows: [
        {
          id: 'a-1',
          title: 't',
          source_snippet: 's',
          published_at: 2000,
          ingested_at: 2000,
          primary_source_url: 'https://a.example/x',
        },
      ],
    });
    const mockVec = makeMockVectorize(new Map([['a-1', []]]));
    const sendErr = new Error('queue down');
    const failingQueue: Queue = {
      send: vi.fn().mockRejectedValue(sendErr),
      sendBatch: vi.fn(),
    } as unknown as Queue;
    const env = makeEnv(mockDb.db, mockVec.binding, {
      sweepQueue: failingQueue,
    });

    // The outer caller in processOneFinalize swallows the error and
    // logs `finalize_auto_sweep_enqueue_failed`, so this resolves.
    await processOneFinalize(env, { scrape_run_id: 'r1' });

    // The dedup_runs row was first inserted with status='running'.
    const insertCall = mockDb.calls.find(
      (c) =>
        c.sql.includes('INSERT INTO dedup_runs') &&
        c.sql.includes("'running'"),
    );
    expect(insertCall).toBeDefined();
    // Recover the sweep run id from the INSERT and assert the
    // subsequent UPDATE targets the SAME row.
    const sweepRunId = insertCall?.params[0];
    expect(sweepRunId).toEqual(expect.any(String));
    // The error path then UPDATEs the same row to status='failed' with
    // the captured error message bound at ?2.
    const failUpdate = mockDb.calls.find(
      (c) =>
        c.sql.includes("status='failed'") &&
        c.sql.includes('UPDATE dedup_runs'),
    );
    expect(failUpdate).toBeDefined();
    expect(failUpdate?.params[0]).toBe(sweepRunId);
    // String(err) for an Error instance yields "Error: queue down"
    // (matches the operator path's coercion in /api/admin/historical-dedup).
    expect(failUpdate?.params[1]).toBe(String(sendErr));
    // Pin the new `AND status='running'` guard so a regression that
    // drops it (allowing double-flips of an already-failed row) lands
    // on a failing assertion.
    expect(failUpdate?.sql).toMatch(/WHERE\s+id\s*=\s*\?1\s+AND\s+status\s*=\s*'running'/);
  });

  // AD41 — when both DEDUP_SWEEP.send AND the secondary fail-flip
  // UPDATE fail (queue down + D1 transient error), the original send
  // error must reach the caller and be the one logged. The inner
  // try/catch around the UPDATE swallows the secondary error so it
  // cannot mask the primary. Without this, operators would see a
  // misleading D1 error in `finalize_auto_sweep_enqueue_failed`
  // instead of the real queue-down cause.
  it('REQ-PIPE-003 AC 16 (AD41): secondary D1 error during fail-flip is swallowed; processOneFinalize still resolves', async () => {
    // Custom mockDb where prepare().run() rejects ONLY on the
    // status='failed' UPDATE. Other DML (INSERT, gate-flip UPDATE)
    // succeeds normally so processOneFinalize reaches the auto-sweep
    // enqueue branch.
    const calls: DbCall[] = [];
    const customPrepare = vi.fn().mockImplementation((sql: string) => {
      return {
        bind: (...params: unknown[]) => {
          return {
            sql,
            params,
            first: vi.fn().mockImplementation(() => {
              calls.push({ sql, params });
              if (sql.includes('finalize_recorded FROM scrape_runs')) {
                return Promise.resolve({ finalize_recorded: 0 });
              }
              return Promise.resolve(null);
            }),
            all: vi.fn().mockImplementation(() => {
              calls.push({ sql, params });
              if (sql.includes('FROM articles\n        WHERE scrape_run_id')) {
                return Promise.resolve({
                  results: [
                    {
                      id: 'a-1',
                      title: 't',
                      source_snippet: 's',
                      published_at: 2000,
                      ingested_at: 2000,
                      primary_source_url: 'https://a.example/x',
                    },
                  ],
                });
              }
              return Promise.resolve({ results: [] });
            }),
            run: vi.fn().mockImplementation(() => {
              calls.push({ sql, params });
              if (sql.includes('UPDATE scrape_runs')) {
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("status='failed'")) {
                return Promise.reject(new Error('d1 transient'));
              }
              return Promise.resolve({ meta: { changes: 0 } });
            }),
          } as unknown as D1PreparedStatement;
        },
      } as unknown as D1PreparedStatement;
    });
    const customDb = {
      prepare: customPrepare,
      batch: vi.fn().mockResolvedValue([]),
      exec: vi.fn().mockResolvedValue(undefined),
    } as unknown as D1Database;
    const mockVec = makeMockVectorize(new Map([['a-1', []]]));
    const sendErr = new Error('queue down');
    const failingQueue: Queue = {
      send: vi.fn().mockRejectedValue(sendErr),
      sendBatch: vi.fn(),
    } as unknown as Queue;
    const env = makeEnv(customDb, mockVec.binding, {
      sweepQueue: failingQueue,
    });

    // Spy on the structured log channel so we can assert that the
    // ORIGINAL queue-send error is what reaches the caller, not the
    // secondary D1 transient error. Without the inner try/catch in
    // enqueueAutoSweep, the secondary error would propagate and the
    // outer log line would carry 'd1 transient' instead — defeating
    // the purpose of the catch and misleading operators about the
    // real failure cause.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Outer try/catch in processOneFinalize swallows the rethrown
    // primary error. Test contract: this resolves cleanly.
    await expect(
      processOneFinalize(env, { scrape_run_id: 'r1' }),
    ).resolves.toBeUndefined();

    // The fail-flip UPDATE was attempted (it then rejected, but the
    // inner catch swallowed it).
    const failUpdate = calls.find((c) =>
      c.sql.includes("status='failed'"),
    );
    expect(failUpdate).toBeDefined();

    // Load-bearing assertion: the outer log line must reference the
    // queue-send error, not the secondary D1 error. console.log is
    // called with a JSON string per src/lib/log.ts.
    const enqueueFailedLog = logSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.includes('finalize_auto_sweep_enqueue_failed'));
    expect(enqueueFailedLog).toBeDefined();
    expect(enqueueFailedLog).toContain('queue down');
    expect(enqueueFailedLog).not.toContain('d1 transient');

    logSpy.mockRestore();
  });
});
