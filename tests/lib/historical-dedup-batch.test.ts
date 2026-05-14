// Tests for runHistoricalDedupBatch — REQ-PIPE-003 AC 9 + REQ-PIPE-009.
//
// The per-batch dedup body lives in src/lib/historical-dedup.ts as a
// pure helper called from both the synchronous admin endpoint
// (backwards-compat path) and the queue-driven sweep consumer
// (default path). Testing the helper directly avoids the auth and
// queue-binding boilerplate and exercises the merge / threshold /
// cursor / Vectorize-delete logic that any caller depends on.
//
// One test per AC bullet (mirrors the previous admin-route tests that
// drove the same logic via POST):
//   1. empty corpus → done:true, scanned:0, merged:0
//   2. happy path → merge SQL + Vectorize.deleteByIds for matched duplicate
//   3. threshold filter — score < 0.78 is NOT merged; merged:0
//   4. bidirectional (AD42) — strictly-older match in auto-band folds self
//      into match; equal-time tie-broken by ULID; older below auto-band stays
//      skipped (only the rerank-band/auto split changed shape)
//   5. stale D1 row guard — match id in Vectorize but not in D1; merged:0, no delete
//   6. cursor pagination — composite cursor recovers equal-time pair across batches
//   7. Vectorize.deleteByIds failure — best-effort; merged count still reported
//   8. AC 11 — same-vendor cosine penalty
//   9. REQ-PIPE-009 — borderline cosine triggers LLM rerank

import { describe, it, expect, vi } from 'vitest';
import { runHistoricalDedupBatch } from '~/lib/historical-dedup';

const DEFAULT_THRESHOLD = 0.88;

interface ArticleRow {
  id: string;
  title?: string;
  source_snippet?: string | null;
  published_at: number;
  primary_source_url: string;
}

interface ExistenceGuardEntry {
  present: number;
  title?: string;
  source_snippet?: string | null;
}

interface DbFixture {
  articles: ArticleRow[];
  existenceGuardResults: Record<string, ExistenceGuardEntry | null>;
  remainingCount: number;
  batchCalls: Array<Array<{ sql: string; params: unknown[] }>>;
  allCalls: Array<{ sql: string; params: unknown[] }>;
  paginatedRemaining?: boolean;
}

function makeDb(fixture: DbFixture): D1Database {
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const bound: unknown[] = [];

    const ops = {
      first: vi.fn().mockImplementation(async () => {
        if (sql.includes('SELECT COUNT(*) AS c')) {
          if (fixture.paginatedRemaining) {
            const cursorPa =
              typeof bound[0] === 'number' ? (bound[0] as number) : -1;
            const cursorId = typeof bound[1] === 'string' ? bound[1] : '';
            const remaining = fixture.articles.filter(
              (row) =>
                row.published_at > cursorPa ||
                (row.published_at === cursorPa && row.id > cursorId),
            ).length;
            return { c: remaining };
          }
          return { c: fixture.remainingCount };
        }
        if (sql.includes('SELECT id, title, source_snippet FROM articles')) {
          const matchId = bound[0] as string;
          const result = fixture.existenceGuardResults[matchId];
          if (result === undefined || result === null) return null;
          return {
            id: matchId,
            title: result.title ?? '',
            source_snippet: result.source_snippet ?? null,
          };
        }
        return null;
      }),
      all: vi.fn().mockImplementation(async () => {
        if (
          sql.includes('SELECT id, title, source_snippet, published_at') &&
          sql.includes("embedding_status = 'embedded'")
        ) {
          fixture.allCalls.push({ sql, params: [...bound] });
          const cursorPa =
            typeof bound[0] === 'number' ? (bound[0] as number) : -1;
          const cursorId = typeof bound[1] === 'string' ? bound[1] : '';
          const limit =
            typeof bound[2] === 'number' ? (bound[2] as number) : 100;
          const sorted = [...fixture.articles].sort((a, b) => {
            if (a.published_at !== b.published_at) {
              return a.published_at - b.published_at;
            }
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          });
          const page = sorted
            .filter(
              (row) =>
                row.published_at > cursorPa ||
                (row.published_at === cursorPa && row.id > cursorId),
            )
            .slice(0, limit);
          return { results: page };
        }
        return { results: [] };
      }),
      run: vi.fn().mockImplementation(async () => {
        return { success: true, meta: { changes: 1 } };
      }),
    };
    const stmt = {
      ...ops,
      bind: (...params: unknown[]) => {
        bound.push(...params);
        return { ...ops, sql, params };
      },
    };
    return stmt as unknown as D1PreparedStatement;
  });
  const batch = vi.fn().mockImplementation(async (statements: unknown[]) => {
    const stmts = statements.map((s) => {
      const cast = s as { sql?: string; params?: unknown[] };
      return { sql: cast.sql ?? '', params: cast.params ?? [] };
    });
    fixture.batchCalls.push(stmts);
    return [];
  });
  return { prepare, batch } as unknown as D1Database;
}

function makeVectorize(opts: {
  queryByIdResults?: Record<string, VectorizeMatches>;
  deleteByIdsFails?: boolean;
  queryByIdAllFail?: boolean;
}): Vectorize {
  return {
    queryById: vi.fn().mockImplementation(async (id: string) => {
      if (opts.queryByIdAllFail) {
        throw new Error('Vectorize service unavailable');
      }
      const result = opts.queryByIdResults?.[id];
      return result ?? { count: 0, matches: [] };
    }),
    deleteByIds: vi.fn().mockImplementation(async (_ids: string[]) => {
      if (opts.deleteByIdsFails) {
        throw new Error('Vectorize delete service unavailable');
      }
      return { count: _ids.length, ids: _ids };
    }),
    query: vi.fn(),
    upsert: vi.fn(),
  } as unknown as Vectorize;
}

interface KvStore {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeKv(watermarkSeconds: number | null): KvStore {
  const get = vi.fn().mockImplementation(async (key: string) => {
    if (key === 'dedup:auto_sweep_watermark') {
      return watermarkSeconds === null ? null : String(watermarkSeconds);
    }
    return null;
  });
  return {
    get,
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

interface CallOpts {
  articles: ArticleRow[];
  existenceGuardResults?: Record<string, ExistenceGuardEntry | null>;
  remainingCount?: number;
  queryByIdResults?: Record<string, VectorizeMatches>;
  deleteByIdsFails?: boolean;
  queryByIdAllFail?: boolean;
  cursor?: { pa: number; id: string } | null;
  batch?: number;
  aiRun?: (model: string, params: Record<string, unknown>) => Promise<unknown>;
  rerankFloor?: string;
  cosineThreshold?: string;
  highConfidenceCosine?: string;
  paginatedRemaining?: boolean;
  /** When set (seconds-since-epoch), the KV mock returns this value for
   *  the watermark key so the sweep can apply its skip-if-both-predate
   *  rule. Null/undefined → KV.get returns null (cold start, default). */
  kvWatermarkSeconds?: number | null;
  /** When true, runHistoricalDedupBatch is called with
   *  `{bypassWatermark: true}` so the watermark is ignored. */
  bypassWatermark?: boolean;
}

async function callBatch(opts: CallOpts) {
  const fixture: DbFixture = {
    articles: opts.articles,
    existenceGuardResults: opts.existenceGuardResults ?? {},
    remainingCount: opts.remainingCount ?? 0,
    batchCalls: [],
    allCalls: [],
    ...(opts.paginatedRemaining !== undefined
      ? { paginatedRemaining: opts.paginatedRemaining }
      : {}),
  };
  const db = makeDb(fixture);
  const vectorize = makeVectorize({
    queryByIdResults: opts.queryByIdResults ?? {},
    deleteByIdsFails: opts.deleteByIdsFails ?? false,
    queryByIdAllFail: opts.queryByIdAllFail ?? false,
  });
  const aiRun =
    opts.aiRun ??
    vi.fn().mockResolvedValue({ response: '{"same_event":false}' });
  const kv = makeKv(opts.kvWatermarkSeconds ?? null);
  const env = {
    DB: db,
    VECTORIZE: vectorize,
    AI: { run: aiRun },
    KV: kv,
    DEDUP_RERANK_FLOOR: opts.rerankFloor,
    DEDUP_COSINE_THRESHOLD: opts.cosineThreshold,
    DEDUP_HIGH_CONFIDENCE_COSINE: opts.highConfidenceCosine,
  } as unknown as Env;

  const options =
    opts.bypassWatermark === true ? { bypassWatermark: true } : undefined;
  const result = await runHistoricalDedupBatch(
    env,
    opts.cursor ?? null,
    opts.batch ?? 100,
    options,
  );
  return { result, fixture, vectorize, aiRun, kv };
}

function singleMatch(opts: {
  id: string;
  score: number;
  published_at: number;
  primary_source_url?: string;
}): VectorizeMatches {
  return {
    count: 1,
    matches: [
      {
        id: opts.id,
        score: opts.score,
        metadata: {
          published_at: opts.published_at,
          primary_source_url:
            opts.primary_source_url ?? 'https://other-publisher.example/post',
        },
      } as VectorizeMatch,
    ],
  };
}

describe('runHistoricalDedupBatch — REQ-PIPE-003', () => {
  it('REQ-PIPE-003: empty corpus returns done:true, scanned:0, merged:0', async () => {
    const { result } = await callBatch({ articles: [] });
    expect(result.scanned).toBe(0);
    expect(result.merged).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.done).toBe(true);
    expect(result.next_cursor).toBeNull();
  });

  it('REQ-PIPE-003: happy path issues merge SQL and calls Vectorize.deleteByIds', async () => {
    const SELF_ID = 'article-older';
    const MATCH_ID = 'article-newer';
    const { result, fixture, vectorize } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_000,
          primary_source_url: 'https://acme.example/self',
        },
      ],
      existenceGuardResults: { [MATCH_ID]: { present: 1 } },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: DEFAULT_THRESHOLD + 0.01,
          published_at: 1_700_000_100,
        }),
      },
    });
    expect(result.scanned).toBe(1);
    expect(result.merged).toBe(1);
    expect(fixture.batchCalls.length).toBeGreaterThanOrEqual(1);
    const merged = fixture.batchCalls.flat();
    const altInsert = merged.find(
      (s) =>
        s.sql.includes('INSERT') &&
        s.sql.includes('article_sources') &&
        s.sql.includes('FROM articles'),
    );
    expect(altInsert).toBeDefined();
    const deleteByIds = vectorize.deleteByIds as ReturnType<typeof vi.fn>;
    expect(deleteByIds).toHaveBeenCalled();
    const deletedIds = deleteByIds.mock.calls.flat().flat() as string[];
    expect(deletedIds).toContain(MATCH_ID);
  });

  it('REQ-PIPE-003: match below threshold is NOT merged', async () => {
    const SELF_ID = 'self';
    const MATCH_ID = 'low-score';
    const { result, fixture, vectorize } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_000,
          primary_source_url: 'https://acme.example/self',
        },
      ],
      existenceGuardResults: { [MATCH_ID]: { present: 1 } },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.5,
          published_at: 1_700_000_100,
        }),
      },
    });
    expect(result.merged).toBe(0);
    expect(fixture.batchCalls.length).toBe(0);
    expect(vectorize.deleteByIds).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003 / AD42: strictly-older auto-band match folds self INTO match', async () => {
    // AD42 PASS 1: a `self` whose top match is OLDER and clears the
    // auto-merge threshold means the older article is the cluster
    // anchor — self folds into it. Pre-AD42 this was silently
    // skipped (one-direction sweep).
    const SELF_ID = 'self-newer';
    const OLDER_ID = 'older-anchor';
    const { result, fixture, vectorize } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_000,
          primary_source_url: 'https://acme.example/self',
        },
      ],
      existenceGuardResults: { [OLDER_ID]: { present: 1 } },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: OLDER_ID,
          score: 0.95,
          published_at: 1_699_999_900,
        }),
      },
    });
    expect(result.merged).toBe(1);
    // Merge runs with older as winner, self as loser.
    expect(fixture.batchCalls.length).toBe(1);
    const merged = fixture.batchCalls.flat();
    const altInsert = merged.find(
      (s) =>
        s.sql.includes('INSERT') &&
        s.sql.includes('article_sources') &&
        s.sql.includes('FROM articles'),
    );
    expect(altInsert).toBeDefined();
    expect(vectorize.deleteByIds).toHaveBeenCalled();
    const deletedIds = (vectorize.deleteByIds as ReturnType<typeof vi.fn>).mock
      .calls.flat()
      .flat() as string[];
    expect(deletedIds).toContain(SELF_ID);
  });

  it('REQ-PIPE-003 / AD42: strictly-older match BELOW auto threshold does not fold self', async () => {
    // PASS 1 only fires for auto-band matches (>= threshold). A
    // border-band older match is the responsibility of the rerank
    // path, not the auto-fold-into-older fast-path.
    const SELF_ID = 'self';
    const OLDER_ID = 'older-border';
    const { result, fixture, vectorize } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_000,
          primary_source_url: 'https://acme.example/self',
        },
      ],
      existenceGuardResults: { [OLDER_ID]: { present: 1 } },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: OLDER_ID,
          score: 0.85,
          published_at: 1_699_999_900,
        }),
      },
    });
    expect(result.merged).toBe(0);
    expect(fixture.batchCalls.length).toBe(0);
    expect(vectorize.deleteByIds).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003: equal-time match with HIGHER ULID merges into self', async () => {
    const SELF_ID = '01AAAAAAAAAAAAAAAAAAAAAAAA';
    const MATCH_ID = '01ZZZZZZZZZZZZZZZZZZZZZZZZ';
    const { result, fixture, vectorize } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_000,
          primary_source_url: 'https://acme.example/self',
        },
      ],
      existenceGuardResults: { [MATCH_ID]: { present: 1 } },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.95,
          published_at: 1_700_000_000,
        }),
      },
    });
    expect(result.merged).toBe(1);
    expect(fixture.batchCalls.length).toBe(1);
    expect(vectorize.deleteByIds).toHaveBeenCalledWith([MATCH_ID]);
  });

  it('REQ-PIPE-003 / AD42: equal-time match with LOWER ULID folds self IN (PASS 1)', async () => {
    // Pre-AD42 historical-dedup walked oldest-first and only absorbed
    // strictly-newer matches into self, silently skipping equal-time
    // matches with a lower ULID (the "tie-break older" side). AD42's
    // bidirectional PASS 1 now picks them up: when a match is auto-band
    // AND tie-break-older-than-self, self folds INTO match (mirroring
    // the finalize-consumer's bidirectional path from AD41).
    const SELF_ID = '01ZZZZZZZZZZZZZZZZZZZZZZZZ';
    const MATCH_ID = '01AAAAAAAAAAAAAAAAAAAAAAAA';
    const { result, fixture, vectorize } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_000,
          primary_source_url: 'https://acme.example/self',
        },
      ],
      existenceGuardResults: { [MATCH_ID]: { present: 1 } },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.95,
          published_at: 1_700_000_000,
        }),
      },
    });
    expect(result.merged).toBe(1);
    expect(fixture.batchCalls.length).toBe(1);
    expect(vectorize.deleteByIds).toHaveBeenCalledWith([SELF_ID]);
  });

  it('REQ-PIPE-003: stale Vectorize match missing from D1 is skipped', async () => {
    const SELF_ID = 'self';
    const STALE_ID = 'stale';
    const { result, fixture, vectorize } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_000,
          primary_source_url: 'https://acme.example/self',
        },
      ],
      existenceGuardResults: { [STALE_ID]: null },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: STALE_ID,
          score: 0.95,
          published_at: 1_700_000_100,
        }),
      },
    });
    expect(result.merged).toBe(0);
    expect(fixture.batchCalls.length).toBe(0);
    expect(vectorize.deleteByIds).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003: composite cursor binds as (pa, id)', async () => {
    const CURSOR_PA = 1_700_000_500;
    const CURSOR_ID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
    const { fixture } = await callBatch({
      articles: [],
      cursor: { pa: CURSOR_PA, id: CURSOR_ID },
    });
    expect(fixture.allCalls.length).toBeGreaterThanOrEqual(1);
    const sel = fixture.allCalls[0]!;
    expect(sel.params[0]).toBe(CURSOR_PA);
    expect(sel.params[1]).toBe(CURSOR_ID);
    expect(sel.sql).toContain('published_at > ?1');
    expect(sel.sql).toContain('published_at = ?1 AND id > ?2');
    expect(sel.sql).toContain('ORDER BY published_at ASC, id ASC');
  });

  it('REQ-PIPE-003: equal-time pair across batch boundary recovered by composite cursor', async () => {
    const SHARED_PA = 1_700_000_000;
    const ARTICLES = [
      { id: '01AAA0000000000000000000A1', published_at: SHARED_PA, primary_source_url: 'https://x.example/a' },
      { id: '01AAA0000000000000000000A2', published_at: SHARED_PA, primary_source_url: 'https://x.example/b' },
      { id: '01AAA0000000000000000000A3', published_at: SHARED_PA, primary_source_url: 'https://x.example/c' },
    ];
    const r1 = await callBatch({
      articles: ARTICLES,
      paginatedRemaining: true,
      batch: 2,
    });
    expect(r1.result.scanned).toBe(2);
    expect(r1.result.next_cursor).toEqual({
      pa: SHARED_PA,
      id: ARTICLES[1]!.id,
    });
    expect(r1.result.done).toBe(false);

    const r2 = await callBatch({
      articles: ARTICLES,
      paginatedRemaining: true,
      batch: 2,
      cursor: r1.result.next_cursor,
    });
    expect(r2.result.scanned).toBe(1);
    expect(r2.result.done).toBe(true);
    expect(r2.result.next_cursor).toEqual({
      pa: SHARED_PA,
      id: ARTICLES[2]!.id,
    });
  });

  it('REQ-PIPE-003: Vectorize.deleteByIds failure does not suppress merged count', async () => {
    const SELF_ID = 'older';
    const MATCH_ID = 'newer';
    const { result } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_000,
          primary_source_url: 'https://acme.example/self',
        },
      ],
      existenceGuardResults: { [MATCH_ID]: { present: 1 } },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: DEFAULT_THRESHOLD + 0.01,
          published_at: 1_700_000_100,
        }),
      },
      deleteByIdsFails: true,
    });
    expect(result.merged).toBe(1);
  });

  it('REQ-PIPE-003 AC 11: same-vendor pair just above threshold falls below penalty (no merge)', async () => {
    const SELF_ID = 'self';
    const MATCH_ID = 'old';
    // score=0.91 is just above DEFAULT_COSINE_THRESHOLD=0.88; the
    // same-vendor penalty (-0.05) pushes the adjusted score to 0.86,
    // which is below threshold but above DEFAULT_RERANK_FLOOR=0.70 so
    // the LLM rerank fires. With the default `same_event:false` mock
    // the pair stays distinct (merged=0).
    const { result, fixture, vectorize } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_500,
          primary_source_url: 'https://blog.example.com/new',
        },
      ],
      existenceGuardResults: { [MATCH_ID]: { present: 1 } },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.91,
          published_at: 1_700_001_000,
          primary_source_url: 'https://news.example.com/old',
        }),
      },
    });
    expect(result.merged).toBe(0);
    expect(fixture.batchCalls.length).toBe(0);
    expect(vectorize.deleteByIds).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003 AC 11: same-vendor pair well above threshold still merges after penalty', async () => {
    const SELF_ID = 'self';
    const MATCH_ID = 'old';
    const { result, fixture } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_500,
          primary_source_url: 'https://blog.example.com/new',
        },
      ],
      existenceGuardResults: { [MATCH_ID]: { present: 1 } },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.95,
          published_at: 1_700_001_000,
          primary_source_url: 'https://news.example.com/old',
        }),
      },
    });
    expect(result.merged).toBe(1);
    expect(fixture.batchCalls.length).toBeGreaterThan(0);
  });

  it('REQ-PIPE-003 AD40: high-confidence raw cosine auto-merges same-vendor pair (penalty bypassed)', async () => {
    // Wire-syndicated story: same eTLD+1, raw 0.93. With high-
    // confidence band at 0.92 the penalty is skipped and the pair
    // auto-merges deterministically — even when the regular threshold
    // is set above (0.95) what the post-penalty adjusted score would
    // produce.
    const SELF_ID = 'older';
    const MATCH_ID = 'newer';
    const { result, fixture } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_500,
          primary_source_url: 'https://blog.example.com/older',
        },
      ],
      existenceGuardResults: { [MATCH_ID]: { present: 1 } },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.93,
          published_at: 1_700_001_000,
          primary_source_url: 'https://news.example.com/newer',
        }),
      },
      cosineThreshold: '0.95',
      highConfidenceCosine: '0.92',
    });
    expect(result.merged).toBe(1);
    expect(fixture.batchCalls.length).toBeGreaterThan(0);
  });

  it('REQ-PIPE-003 AD40: cosine just below high-confidence band still subject to penalty', async () => {
    const SELF_ID = 'older';
    const MATCH_ID = 'newer';
    const { result, fixture } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_500,
          primary_source_url: 'https://blog.example.com/older',
        },
      ],
      existenceGuardResults: { [MATCH_ID]: { present: 1 } },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.91,
          published_at: 1_700_001_000,
          primary_source_url: 'https://news.example.com/newer',
        }),
      },
      cosineThreshold: '0.95',
      highConfidenceCosine: '0.92',
    });
    // 0.91 < 0.92 high-confidence, penalty applied → 0.86, < 0.95
    // threshold; lands in rerank band, default `same_event:false` mock
    // rejects, no merge.
    expect(result.merged).toBe(0);
    expect(fixture.batchCalls.length).toBe(0);
  });

  it('REQ-PIPE-003 AC 11: cross-vendor pair just above threshold merges (no penalty)', async () => {
    const SELF_ID = 'self';
    const MATCH_ID = 'old';
    const { result, fixture } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_500,
          primary_source_url: 'https://acme.example/new',
        },
      ],
      existenceGuardResults: { [MATCH_ID]: { present: 1 } },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.89,
          published_at: 1_700_001_000,
          primary_source_url: 'https://other-publisher.example/old',
        }),
      },
    });
    expect(result.merged).toBe(1);
    expect(fixture.batchCalls.length).toBeGreaterThan(0);
  });

  it('REQ-PIPE-009: borderline cosine with LLM yes merges newer article', async () => {
    const SELF_ID = 'older';
    const MATCH_ID = 'newer';
    // AD48: batched call returns `{verdicts:[{i, same_event}]}`. One
    // borderline pair → one verdict at index 0.
    const aiRun = vi.fn().mockResolvedValue({
      response: '{"verdicts":[{"i":0,"same_event":true}]}',
    });
    // score=0.74 sits in the [DEFAULT_RERANK_FLOOR=0.70,
    // DEFAULT_COSINE_THRESHOLD=0.78) borderline band so the LLM is
    // invoked. Above 0.78 the auto-merge path runs without rerank.
    const { result, fixture, vectorize } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          title: 'Romania Government Collapses',
          source_snippet: 'Coalition lost majority in vote.',
          published_at: 1_700_000_500,
          primary_source_url: 'https://oldsite.example/x',
        },
      ],
      existenceGuardResults: {
        [MATCH_ID]: {
          present: 1,
          title: 'Romania PM Ousted',
          source_snippet: 'Bolojan removed.',
        },
      },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.74,
          published_at: 1_700_001_000,
          primary_source_url: 'https://newsite.example/y',
        }),
      },
      aiRun,
    });
    expect(result.merged).toBe(1);
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(fixture.batchCalls.length).toBeGreaterThan(0);
    expect(vectorize.deleteByIds).toHaveBeenCalled();
  });

  it('REQ-PIPE-009: borderline cosine with LLM no stays distinct', async () => {
    const SELF_ID = 'older';
    const MATCH_ID = 'newer';
    const aiRun = vi.fn().mockResolvedValue({ response: '{"same_event":false}' });
    const { result, fixture } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          title: 'OpenAI GPT-7',
          source_snippet: 'Multimodal.',
          published_at: 1_700_000_500,
          primary_source_url: 'https://oldsite.example/x',
        },
      ],
      existenceGuardResults: {
        [MATCH_ID]: { present: 1, title: 'Sora 2', source_snippet: 'Video.' },
      },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.74,
          published_at: 1_700_001_000,
          primary_source_url: 'https://newsite.example/y',
        }),
      },
      aiRun,
    });
    expect(result.merged).toBe(0);
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(fixture.batchCalls.length).toBe(0);
  });

  it('REQ-PIPE-003 AC 13: match outside the 7d time window is skipped despite high cosine', async () => {
    const SELF_ID = 'self';
    const MATCH_ID = 'older-by-8-days';
    const SELF_PA = 1_700_000_000;
    const EIGHT_DAYS_LATER = SELF_PA + 8 * 24 * 60 * 60;
    // Score is well above the auto-merge threshold but the match is 8
    // days newer — outside the default 7d news-cycle window. Hard
    // gate skips it before the cosine check; merged stays 0 and no
    // Vectorize delete is issued.
    const { result, fixture, vectorize } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          published_at: SELF_PA,
          primary_source_url: 'https://acme.example/self',
        },
      ],
      existenceGuardResults: { [MATCH_ID]: { present: 1 } },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.95,
          published_at: EIGHT_DAYS_LATER,
          primary_source_url: 'https://other.example/post',
        }),
      },
    });
    expect(result.merged).toBe(0);
    expect(fixture.batchCalls.length).toBe(0);
    expect(vectorize.deleteByIds).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003 AC 13: match exactly at the 7d boundary is included (boundary inclusive)', async () => {
    const SELF_ID = 'self';
    const MATCH_ID = 'older-by-7d-exact';
    const SELF_PA = 1_700_000_000;
    const SEVEN_DAYS = 7 * 24 * 60 * 60;
    const { result, fixture } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          published_at: SELF_PA,
          primary_source_url: 'https://acme.example/self',
        },
      ],
      existenceGuardResults: { [MATCH_ID]: { present: 1 } },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.95,
          published_at: SELF_PA + SEVEN_DAYS,
          primary_source_url: 'https://other.example/post',
        }),
      },
    });
    expect(result.merged).toBe(1);
    expect(fixture.batchCalls.length).toBeGreaterThan(0);
  });

  it('REQ-PIPE-003 AC 13: time window is env-tunable (DEDUP_TIME_WINDOW_SECONDS=60 blocks a 5-minute spread)', async () => {
    const SELF_ID = 'self';
    const MATCH_ID = 'older-by-5-min';
    const SELF_PA = 1_700_000_000;
    const FIVE_MINUTES = 5 * 60;
    // Override the window to 60 seconds via env. A 5-minute delta is
    // outside that tighter window, so the match is skipped despite a
    // 0.95 cosine.
    const fixture: DbFixture = {
      articles: [
        {
          id: SELF_ID,
          published_at: SELF_PA,
          primary_source_url: 'https://acme.example/self',
        },
      ],
      existenceGuardResults: { [MATCH_ID]: { present: 1 } },
      remainingCount: 0,
      batchCalls: [],
      allCalls: [],
    };
    const db = makeDb(fixture);
    const vectorize = makeVectorize({
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.95,
          published_at: SELF_PA + FIVE_MINUTES,
          primary_source_url: 'https://other.example/post',
        }),
      },
    });
    const env = {
      DB: db,
      VECTORIZE: vectorize,
      AI: { run: vi.fn() },
      KV: makeKv(null),
      DEDUP_TIME_WINDOW_SECONDS: '60',
    } as unknown as Env;
    const result = await runHistoricalDedupBatch(env, null, 100);
    expect(result.merged).toBe(0);
    expect(fixture.batchCalls.length).toBe(0);
    expect(vectorize.deleteByIds).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003 / CF-004: total Vectorize outage returns done:false with input cursor preserved', async () => {
    // CF-004 (AD45). When every Vectorize.queryById in the batch
    // throws, the prior implementation silently advanced the cursor
    // past every failed self, leaving cross-tick duplicates unmerged
    // once Vectorize recovered. The aligned behavior (mirroring
    // scrape-finalize-consumer) keeps the cursor at the input position
    // and reports `done: false` so the queue-driven sweep self-chains
    // a retry instead of skipping the range.
    const INPUT_CURSOR = { pa: 1_700_000_000, id: 'cursor-anchor' };
    const SELF_A = 'self-a';
    const SELF_B = 'self-b';
    const { result, vectorize, fixture } = await callBatch({
      articles: [
        {
          id: SELF_A,
          published_at: 1_700_000_100,
          primary_source_url: 'https://acme.example/a',
        },
        {
          id: SELF_B,
          published_at: 1_700_000_200,
          primary_source_url: 'https://acme.example/b',
        },
      ],
      cursor: INPUT_CURSOR,
      queryByIdAllFail: true,
    });
    expect(result.done).toBe(false);
    expect(result.merged).toBe(0);
    expect(result.next_cursor).toEqual(INPUT_CURSOR);
    expect(result.remaining).toBe(2);
    expect(result.scanned).toBe(2);
    // Both rows were attempted; both failed; no merges issued; no
    // Vectorize.deleteByIds calls (no removedIds to delete).
    const queryById = vectorize.queryById as ReturnType<typeof vi.fn>;
    expect(queryById).toHaveBeenCalledTimes(2);
    expect(fixture.batchCalls.length).toBe(0);
    const deleteByIds = vectorize.deleteByIds as ReturnType<typeof vi.fn>;
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003 / CF-004: partial Vectorize outage still advances cursor (only TOTAL outage halts)', async () => {
    // If at least one queryById succeeds, we're not in a corpus-wide
    // outage — the cursor advances normally and `done` reflects the
    // remaining-count query. This boundary case is what distinguishes
    // CF-004's gate from "any failure halts the batch."
    const SELF_OK = 'self-ok';
    const SELF_FAIL = 'self-fail';
    const queryByIdMock = vi
      .fn()
      .mockImplementationOnce(async () => ({ count: 0, matches: [] }))
      .mockImplementationOnce(async () => {
        throw new Error('Vectorize timeout');
      });
    const fixture: DbFixture = {
      articles: [
        {
          id: SELF_OK,
          published_at: 1_700_000_100,
          primary_source_url: 'https://acme.example/a',
        },
        {
          id: SELF_FAIL,
          published_at: 1_700_000_200,
          primary_source_url: 'https://acme.example/b',
        },
      ],
      existenceGuardResults: {},
      remainingCount: 0,
      batchCalls: [],
      allCalls: [],
    };
    const db = makeDb(fixture);
    const vectorize = {
      queryById: queryByIdMock,
      deleteByIds: vi.fn().mockResolvedValue({ count: 0, ids: [] }),
      query: vi.fn(),
      upsert: vi.fn(),
    } as unknown as Vectorize;
    const env = {
      DB: db,
      VECTORIZE: vectorize,
      AI: { run: vi.fn().mockResolvedValue({ response: '{"same_event":false}' }) },
      KV: makeKv(null),
    } as unknown as Env;
    const result = await runHistoricalDedupBatch(env, null, 100);
    // Cursor advanced past both rows (last row is SELF_FAIL).
    expect(result.done).toBe(true);
    expect(result.next_cursor).toEqual({
      pa: 1_700_000_200,
      id: SELF_FAIL,
    });
    expect(queryByIdMock).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------
  // REQ-PIPE-009 AD48 — watermark skip on the borderline rerank path.
  // Both pair members predate the prior auto-sweep watermark ⇒ skip the
  // LLM. Either is newer ⇒ call the LLM as usual. `bypassWatermark: true`
  // ⇒ always call regardless of timestamps.
  //
  // The OLD/NEW ULIDs below encode ms timestamps via Crockford base32 in
  // their first 10 chars. ulidTime() decodes those chars to ms.
  //   OLD prefix `01BMZFF600` ⇒ ms=1_500_000_000_000 (before watermark)
  //   NEW prefix `01Q9GD6E00` ⇒ ms=1_900_000_000_000 (after watermark)
  // Watermark = 1_700_000_000 seconds = 1_700_000_000_000 ms.
  // ---------------------------------------------------------------
  const OLD_ULID_A = '01BMZFF600AAAAAAAAAAAAAAAA';
  const OLD_ULID_B = '01BMZFF600BBBBBBBBBBBBBBBB';
  const NEW_ULID_A = '01Q9GD6E00AAAAAAAAAAAAAAAA';
  const WATERMARK_SECONDS = 1_700_000_000;

  it('REQ-PIPE-009 AD48: both pair members predate watermark — LLM skipped', async () => {
    const aiRun = vi.fn();
    const { result } = await callBatch({
      kvWatermarkSeconds: WATERMARK_SECONDS,
      articles: [
        {
          id: OLD_ULID_A,
          title: 'Old self',
          source_snippet: 'a',
          published_at: 1_700_000_500,
          primary_source_url: 'https://oldsite.example/x',
        },
      ],
      existenceGuardResults: {
        [OLD_ULID_B]: { present: 1, title: 'Old match', source_snippet: 'b' },
      },
      queryByIdResults: {
        [OLD_ULID_A]: singleMatch({
          id: OLD_ULID_B,
          score: 0.74,
          published_at: 1_700_001_000,
          primary_source_url: 'https://newsite.example/y',
        }),
      },
      aiRun,
    });
    expect(aiRun).not.toHaveBeenCalled();
    expect(result.merged).toBe(0);
  });

  it('REQ-PIPE-009 AD48: one pair member newer than watermark — LLM called', async () => {
    // Self is OLD, match is NEW → not both predate → must rerank.
    const aiRun = vi.fn().mockResolvedValue({
      response: '{"verdicts":[{"i":0,"same_event":false}]}',
    });
    const { result } = await callBatch({
      kvWatermarkSeconds: WATERMARK_SECONDS,
      articles: [
        {
          id: OLD_ULID_A,
          title: 'Old self',
          source_snippet: 'a',
          published_at: 1_700_000_500,
          primary_source_url: 'https://oldsite.example/x',
        },
      ],
      existenceGuardResults: {
        [NEW_ULID_A]: { present: 1, title: 'New match', source_snippet: 'b' },
      },
      queryByIdResults: {
        [OLD_ULID_A]: singleMatch({
          id: NEW_ULID_A,
          score: 0.74,
          published_at: 1_700_001_000,
          primary_source_url: 'https://newsite.example/y',
        }),
      },
      aiRun,
    });
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(result.merged).toBe(0);
  });

  it('REQ-PIPE-009 AD48: bypassWatermark=true always calls LLM regardless of timestamps', async () => {
    const aiRun = vi.fn().mockResolvedValue({
      response: '{"verdicts":[{"i":0,"same_event":true}]}',
    });
    const { result, fixture } = await callBatch({
      kvWatermarkSeconds: WATERMARK_SECONDS,
      bypassWatermark: true,
      articles: [
        {
          id: OLD_ULID_A,
          title: 'Old self',
          source_snippet: 'a',
          published_at: 1_700_000_500,
          primary_source_url: 'https://oldsite.example/x',
        },
      ],
      existenceGuardResults: {
        [OLD_ULID_B]: { present: 1, title: 'Old match', source_snippet: 'b' },
      },
      queryByIdResults: {
        [OLD_ULID_A]: singleMatch({
          id: OLD_ULID_B,
          score: 0.74,
          published_at: 1_700_001_000,
          primary_source_url: 'https://newsite.example/y',
        }),
      },
      aiRun,
    });
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(result.merged).toBe(1);
    expect(fixture.batchCalls.length).toBeGreaterThan(0);
  });

  it('REQ-PIPE-009: cosine below floor does not invoke LLM', async () => {
    const SELF_ID = 'older';
    const MATCH_ID = 'newer';
    const aiRun = vi.fn();
    const { result } = await callBatch({
      articles: [
        {
          id: SELF_ID,
          title: 'A',
          source_snippet: 'a',
          published_at: 1_700_000_500,
          primary_source_url: 'https://oldsite.example/x',
        },
      ],
      existenceGuardResults: {
        [MATCH_ID]: { present: 1, title: 'B', source_snippet: 'b' },
      },
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.5,
          published_at: 1_700_001_000,
          primary_source_url: 'https://newsite.example/y',
        }),
      },
      aiRun,
    });
    expect(result.merged).toBe(0);
    expect(aiRun).not.toHaveBeenCalled();
  });
});
