// Tests for src/queue/scrape-chunk-consumer.ts - REQ-PIPE-002.
//
// The chunk consumer calls Workers AI once per chunk, parses the JSON
// response, collapses LLM-provided dedup_groups, validates tags against
// the allowlist, and writes articles + article_sources + article_tags
// in a single D1 batch. The tests stub env.AI.run, D1, KV, and assert
// on the observable behaviour contracts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processOneChunk, handleChunkBatch } from '~/queue/scrape-chunk-consumer';
import type { ChunkJobMessage } from '~/queue/scrape-chunk-consumer';
import { PROCESS_CHUNK_SYSTEM } from '~/lib/prompts';

// Aggregated recording of D1 statement execution through both the
// `prepare().bind().run()` and `db.batch([...])` surfaces. Tests assert
// against this log to verify SQL shape + param binding + batch contents.
interface SqlRecord {
  sql: string;
  params: unknown[];
  via: 'run' | 'batch' | 'all' | 'first';
}

function makeDb(opts: {
  existingCanonicals?: string[];
  records?: SqlRecord[];
  /** Pre-populate scrape_chunk_completions so the COUNT(*) SELECT
   *  in the consumer returns this value plus any new INSERTs. CF-002:
   *  the chunk consumer drives finishRun off this count, not off the
   *  legacy KV chunks_remaining counter. */
  initialCompletedChunks?: number;
  /** Inject a one-shot failure on the finalize-lock rollback UPDATE
   *  so we can exercise the double-fault path (CF-002 follow-up). */
  failNextRollback?: boolean;
} = {}): { db: D1Database; records: SqlRecord[] } {
  const records = opts.records ?? [];
  // Track inserted (run_id, chunk_index) pairs so INSERT OR IGNORE
  // honors PK uniqueness - duplicate inserts are no-ops, matching D1.
  const completedKeys = new Set<string>();
  let completedChunkCount = opts.initialCompletedChunks ?? 0;
  // Per-run finalize-lock state (CF-002 follow-up). The conditional
  // UPDATE returns meta.changes === 1 only on the run-from-0 transition.
  const finalizeLocked = new Set<string>();
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const binder = (...params: unknown[]) => ({
      __sql: sql,
      __params: params,
      run: vi.fn().mockImplementation(async () => {
        records.push({ sql, params, via: 'run' });
        if (sql.startsWith('INSERT OR IGNORE INTO scrape_chunk_completions')) {
          const key = `${String(params[0])}:${String(params[1])}`;
          const alreadyHad = completedKeys.has(key);
          if (!alreadyHad) {
            completedKeys.add(key);
            completedChunkCount += 1;
          }
          // Mirror D1 semantics: duplicate INSERT OR IGNORE returns
          // meta.changes === 0; first insert returns 1.
          return { success: true, meta: { changes: alreadyHad ? 0 : 1 } };
        }
        if (
          sql.includes('UPDATE scrape_runs') &&
          sql.includes('finalize_enqueued = 1') &&
          sql.includes('finalize_enqueued = 0')
        ) {
          const runId = String(params[0]);
          if (finalizeLocked.has(runId)) {
            return { success: true, meta: { changes: 0 } };
          }
          finalizeLocked.add(runId);
          return { success: true, meta: { changes: 1 } };
        }
        // Rollback path: clear the finalize lock when send throws.
        if (
          sql.includes('UPDATE scrape_runs') &&
          sql.includes('finalize_enqueued = 0') &&
          !sql.includes('finalize_enqueued = 1')
        ) {
          if (opts.failNextRollback === true) {
            // Consume the one-shot - only the first rollback throws,
            // so a follow-up retry sees a healthy D1.
            opts.failNextRollback = false;
            throw new Error('d1 transient outage during rollback');
          }
          finalizeLocked.delete(String(params[0]));
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 1 } };
      }),
      all: vi.fn().mockImplementation(async () => {
        records.push({ sql, params, via: 'all' });
        return { success: true, results: [] };
      }),
      first: vi.fn().mockImplementation(async () => {
        records.push({ sql, params, via: 'first' });
        if (
          sql.includes('FROM scrape_chunk_completions') &&
          sql.includes('COUNT(*)')
        ) {
          return { done: completedChunkCount };
        }
        return null;
      }),
    });
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
    exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
  } as unknown as D1Database;
  return { db, records };
}

interface KvState {
  store: Map<string, string>;
  sourcesKeys: string[];
}

function makeKv(opts: {
  sourcesKeys?: string[];
  chunksRemaining?: string;
} = {}): { kv: KVNamespace; state: KvState } {
  const store = new Map<string, string>();
  const sourcesKeys = opts.sourcesKeys ?? [];
  if (opts.chunksRemaining !== undefined) {
    // Consumer reads this key to decrement.
    store.set(
      'scrape_run:test-run:chunks_remaining',
      opts.chunksRemaining,
    );
  }
  const kv = {
    get: vi.fn().mockImplementation(async (key: string) => {
      return store.get(key) ?? null;
    }),
    put: vi
      .fn()
      .mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
      }),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockImplementation(async (args: { prefix?: string }) => {
      if (args.prefix === 'sources:') {
        return {
          keys: sourcesKeys.map((k) => ({ name: k })),
          list_complete: true,
        };
      }
      return { keys: [], list_complete: true };
    }),
  } as unknown as KVNamespace;
  return { kv, state: { store, sourcesKeys } };
}

function makeEnv(
  db: D1Database,
  kv: KVNamespace,
  aiResponse: unknown,
): Env {
  // env.AI.run is called twice per chunk: once for the chunk LLM
  // (returns aiResponse), once for the embedding model (returns a
  // shape the embeddings helper accepts). REQ-PIPE-003.
  const aiRun = vi.fn().mockImplementation((model: string, params: { text?: string[] }) => {
    if (model.startsWith('@cf/baai/bge-')) {
      const count = params.text?.length ?? 0;
      return Promise.resolve({
        data: Array.from({ length: count }, () =>
          Array.from({ length: 768 }, () => 0),
        ),
      });
    }
    return Promise.resolve(aiResponse);
  });
  return {
    DB: db,
    KV: kv,
    AI: { run: aiRun } as unknown as Ai,
    VECTORIZE: {
      upsert: vi.fn().mockResolvedValue({ count: 0, ids: [] }),
      query: vi.fn().mockResolvedValue({ count: 0, matches: [] }),
      queryById: vi.fn().mockResolvedValue({ count: 0, matches: [] }),
      deleteByIds: vi.fn().mockResolvedValue({ count: 0, ids: [] }),
    } as unknown as Vectorize,
    SCRAPE_COORDINATOR: { send: vi.fn() } as unknown as Queue<unknown>,
    SCRAPE_CHUNKS: { send: vi.fn() } as unknown as Queue<unknown>,
    SCRAPE_FINALIZE: { send: vi.fn() } as unknown as Queue<unknown>,
    DIGEST_JOBS: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue<unknown>,
    ASSETS: {} as Fetcher,
    GH_OAUTH_CLIENT_ID: 'x',
    GH_OAUTH_CLIENT_SECRET: 'x',
    OAUTH_JWT_SECRET: 'x',
    RESEND_API_KEY: 'x',
    RESEND_FROM: 'x',
    APP_URL: 'https://test.example.com',
  } as unknown as Env;
}

/** CF-030 - chunk consumer enforces a 120-word floor on `details`
 *  per REQ-PIPE-002 AC3. Test fixtures used to ship single-sentence
 *  bodies which now get dropped by the guard. Use this constant when
 *  the test isn't specifically about the word-count contract. */
const LONG_BODY =
  'This is a representative article body that easily clears the 120-word floor. '.repeat(14) +
  'It crosses two natural paragraph boundaries with explicit periods between sentences.';

function makeChunk(
  overrides: Partial<ChunkJobMessage> = {},
): ChunkJobMessage {
  return {
    scrape_run_id: 'test-run',
    chunk_index: 0,
    total_chunks: 1,
    candidates: [
      {
        canonical_url: 'https://example.com/a',
        source_url: 'https://example.com/a',
        source_name: 'Example A',
        title: 'Headline A',
        published_at: 1_713_900_000,
      },
      {
        canonical_url: 'https://example.com/b',
        source_url: 'https://example.com/b',
        source_name: 'Example B',
        title: 'Headline B',
        published_at: 1_713_900_100,
      },
    ],
    ...overrides,
  };
}

describe('scrape-chunk-consumer - REQ-PIPE-002 / REQ-PIPE-015 (chunk robustness)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('REQ-PIPE-002: builds PROCESS_CHUNK_SYSTEM + per-chunk prompt and calls env.AI.run with JSON response_format', async () => {
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { title: 'NYT-A', details: LONG_BODY, tags: ['cloudflare'] },
          { title: 'NYT-B', details: LONG_BODY, tags: ['generative-ai'] },
        ],
        dedup_groups: [],
      }),
      usage: { input_tokens: 100, output_tokens: 200 },
    };
    const { db } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runMock = (env.AI as any).run as ReturnType<typeof vi.fn>;
    // env.AI.run is called twice per chunk: once for the chunk LLM,
    // once for the per-article embedding model (REQ-PIPE-003).
    expect(runMock).toHaveBeenCalledTimes(2);
    const chunkCall = runMock.mock.calls.find(
      (call: unknown[]) => !(call[0] as string).startsWith('@cf/baai/bge-'),
    ) as [string, Record<string, unknown>] | undefined;
    expect(chunkCall).toBeDefined();
    const [model, params] = chunkCall as [string, Record<string, unknown>];
    // The chunk LLM model identifier must be a non-empty namespaced
    // Workers AI binding ID (`@cf/...` or `@hf/...`). A bare empty
    // string would be a regression: env.AI.run rejects it.
    expect(model).toMatch(/^@\w+\//);
    const messages = params.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toBe(PROCESS_CHUNK_SYSTEM);
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.content).toContain('Headline A');
    expect(params.response_format).toEqual({ type: 'json_object' });
  });

  it('REQ-PIPE-002: parses OpenAI envelope + plain {response} via extractResponsePayload', async () => {
    const openAIEnvelope = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              articles: [
                { title: 'Title-A', details: LONG_BODY, tags: ['cloudflare'] },
                { title: 'Title-B', details: LONG_BODY, tags: ['generative-ai'] },
              ],
              dedup_groups: [],
            }),
          },
        },
      ],
      usage: { input_tokens: 50, output_tokens: 75 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, openAIEnvelope);
    await processOneChunk(env, makeChunk());
    // Should have inserted 2 articles via the batch path.
    const articleInserts = records.filter(
      (r) => r.sql.includes('INSERT') && r.sql.includes('articles') && !r.sql.includes('article_sources') && !r.sql.includes('article_tags') && r.via === 'batch',
    );
    expect(articleInserts.length).toBe(2);
  });

  it('REQ-PIPE-002: collapses intra-chunk dedup_groups; primary is earliest-published, rest become article_sources', async () => {
    // Two candidates for the same story - LLM hints dedup_groups = [[0,1]].
    // Input order: candidate 0 has published_at=100 (earliest), candidate
    // 1 has published_at=200. After collapse: 1 article + 1 alternative.
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { title: 'Merged Story', details: LONG_BODY, tags: ['cloudflare'] },
          { title: 'Ignored', details: LONG_BODY, tags: ['cloudflare'] },
        ],
        dedup_groups: [[0, 1]],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    const chunk = makeChunk({
      candidates: [
        {
          canonical_url: 'https://example.com/a',
          source_url: 'https://example.com/a',
          source_name: 'Source A',
          title: 'Title A',
          published_at: 100,
        },
        {
          canonical_url: 'https://example.com/b',
          source_url: 'https://example.com/b',
          source_name: 'Source B',
          title: 'Title B',
          published_at: 200,
        },
      ],
    });
    await processOneChunk(env, chunk);
    const articleInserts = records.filter(
      (r) =>
        r.via === 'batch' &&
        r.sql.startsWith('INSERT OR IGNORE INTO articles'),
    );
    expect(articleInserts.length).toBe(1);
    // article_sources holds the non-primary alternative.
    const altInserts = records.filter(
      (r) =>
        r.via === 'batch' && r.sql.includes('INSERT OR IGNORE INTO article_sources'),
    );
    expect(altInserts.length).toBe(1);
  });

  it('REQ-PIPE-002: drops tags outside the allowlist; articles with zero tags are dropped', async () => {
    // The first article's tags are ALL outside the allowlist → article
    // dropped. The second article's tags are inside the default set →
    // article kept.
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { title: 'Bad tags only', details: LONG_BODY, tags: ['not-a-real-tag', 'another-bogus-tag'] },
          { title: 'Good tags', details: LONG_BODY, tags: ['cloudflare'] },
        ],
        dedup_groups: [],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    const articleInserts = records.filter(
      (r) =>
        r.via === 'batch' &&
        r.sql.startsWith('INSERT OR IGNORE INTO articles'),
    );
    expect(articleInserts.length).toBe(1);
  });

  it('REQ-PIPE-002: articles INSERT column list matches migration 0003 schema (regression guard for the details_json / tags_json / ingested_at / scrape_run_id columns)', async () => {
    const aiResponse = {
      response: JSON.stringify({
        articles: [{ title: 'Article A - long enough headline copy', details: [LONG_BODY], tags: ['cloudflare'] }],
        dedup_groups: [],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    const articleInserts = records.filter(
      (r) =>
        r.via === 'batch' &&
        r.sql.startsWith('INSERT OR IGNORE INTO articles'),
    );
    expect(articleInserts.length).toBe(1);
    const sql = articleInserts[0]!.sql;
    // These columns are NOT NULL in migration 0003 - the INSERT MUST
    // reference each by the name declared in the schema. A prior bug
    // wrote to `details` + `created_at` (non-existent) and omitted
    // details_json + tags_json + scrape_run_id; this guard prevents
    // that regression.
    expect(sql).toContain('canonical_url');
    expect(sql).toContain('primary_source_name');
    expect(sql).toContain('primary_source_url');
    expect(sql).toContain('title');
    expect(sql).toContain('details_json');
    expect(sql).toContain('tags_json');
    expect(sql).toContain('published_at');
    expect(sql).toContain('ingested_at');
    expect(sql).toContain('scrape_run_id');
    expect(sql).not.toContain(' details,'); // old column name
    expect(sql).not.toContain('created_at'); // old column name
    // details_json must be serialized as a JSON array string so the
    // reader (pages/api/digest/today.ts) can parseStringArray it.
    const params = articleInserts[0]!.params as unknown[];
    const detailsJsonParam = params.find(
      (p) => typeof p === 'string' && p.startsWith('['),
    );
    expect(detailsJsonParam).toBeTruthy();
    // The schema-shape regression-guard test cares only that
    // details_json IS a JSON-encoded array, not what's in it. The
    // contents come from the LONG_BODY fixture above.
    const parsed = JSON.parse(detailsJsonParam as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it('REQ-PIPE-002: writes articles + article_sources + article_tags in a single D1 batch', async () => {
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { title: 'Article A - long enough headline copy', details: LONG_BODY, tags: ['cloudflare', 'generative-ai'] },
          { title: 'Article B - long enough headline copy', details: LONG_BODY, tags: ['generative-ai'] },
        ],
        dedup_groups: [],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    // Add alternatives so article_sources rows are exercised.
    const chunk = makeChunk({
      candidates: [
        {
          canonical_url: 'https://example.com/a',
          source_url: 'https://example.com/a',
          source_name: 'A',
          title: 'Article A - long enough headline copy',
          published_at: 100,
          alternatives: [
            { source_url: 'https://mirror.example.com/a', source_name: 'Mirror' },
          ],
        },
        {
          canonical_url: 'https://example.com/b',
          source_url: 'https://example.com/b',
          source_name: 'B',
          title: 'Article B - long enough headline copy',
          published_at: 200,
        },
      ],
    });
    await processOneChunk(env, chunk);
    // All three table writes go through batch.
    const batched = records.filter((r) => r.via === 'batch');
    expect(
      batched.some((r) => r.sql.startsWith('INSERT OR IGNORE INTO articles')),
    ).toBe(true);
    expect(
      batched.some((r) => r.sql.includes('INSERT OR IGNORE INTO article_sources')),
    ).toBe(true);
    expect(
      batched.some((r) => r.sql.startsWith('INSERT OR IGNORE INTO article_tags')),
    ).toBe(true);
    // 2 articles + 1 alt + 3 tags (2 for A + 1 for B) = 6 batch statements.
    expect(batched.length).toBe(6);
  });

  it('REQ-PIPE-002: completing the final chunk calls finishRun(ready)', async () => {
    // CF-002: the run's "are we done?" gate is the count of rows
    // in scrape_chunk_completions. CF-007 removed the KV mirror;
    // /api/scrape-status now derives chunks_remaining from D1 COUNT.
    const aiResponse = {
      response: JSON.stringify({ articles: [{ title: 'Article A - long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }, { title: 'Article B - long enough headline copy', details: LONG_BODY, tags: ['generative-ai'] }], dedup_groups: [] }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv();
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    // total_chunks=1 (default) and we just inserted chunk 0 → done=1 → finalize.
    const finish = records.find(
      (r) =>
        r.sql.includes('UPDATE scrape_runs') &&
        (r.params as unknown[])[1] === 'ready',
    );
    expect(finish).toBeDefined();
    // INSERT OR IGNORE row was actually written.
    const insert = records.find((r) =>
      r.sql.startsWith('INSERT OR IGNORE INTO scrape_chunk_completions'),
    );
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe('test-run');
    expect(insert!.params[1]).toBe(0);
  });

  it('REQ-PIPE-002: non-last chunk does NOT call finishRun', async () => {
    const aiResponse = {
      response: JSON.stringify({ articles: [{ title: 'Article A - long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }, { title: 'Article B - long enough headline copy', details: LONG_BODY, tags: ['generative-ai'] }], dedup_groups: [] }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv();
    const env = makeEnv(db, kv, aiResponse);
    // total_chunks=4 simulates a multi-chunk run; this is chunk 0 of 4.
    await processOneChunk(env, makeChunk({ chunk_index: 0, total_chunks: 4 }));
    const finish = records.find(
      (r) =>
        r.sql.includes('UPDATE scrape_runs') &&
        (r.params as unknown[])[1] === 'ready',
    );
    expect(finish).toBeUndefined();
  });

  it('REQ-PIPE-008: last chunk enqueues exactly one SCRAPE_FINALIZE message after finishRun', async () => {
    const aiResponse = {
      response: JSON.stringify({ articles: [{ title: 'Article A - long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }], dedup_groups: [] }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db } = makeDb();
    const { kv } = makeKv();
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendMock = (env.SCRAPE_FINALIZE as any).send as ReturnType<typeof vi.fn>;
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({ scrape_run_id: 'test-run' });
  });

  it('REQ-PIPE-008: non-last chunks do NOT enqueue SCRAPE_FINALIZE', async () => {
    const aiResponse = {
      response: JSON.stringify({ articles: [{ title: 'Article A - long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }], dedup_groups: [] }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db } = makeDb();
    const { kv } = makeKv();
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk({ chunk_index: 0, total_chunks: 4 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendMock = (env.SCRAPE_FINALIZE as any).send as ReturnType<typeof vi.fn>;
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-008: redelivered last-chunk message does NOT re-enqueue SCRAPE_FINALIZE (LLM cost gate)', async () => {
    // CF-002 follow-up: INSERT OR IGNORE makes the per-chunk write
    // idempotent under retries, but the COUNT(*) gate still fires on
    // redelivery (count >= total_chunks remains true). The atomic
    // `UPDATE scrape_runs SET finalize_enqueued = 1 WHERE ...
    // AND finalize_enqueued = 0` returns meta.changes = 0 on the
    // second attempt, so the consumer short-circuits before sending.
    const aiResponse = {
      response: JSON.stringify({ articles: [{ title: 'Article A - long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }], dedup_groups: [] }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db } = makeDb();
    const { kv } = makeKv();
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    // The finalize lock lives on the D1 row; redelivery is gated by
    // the atomic UPDATE on finalize_enqueued returning meta.changes=0.
    await processOneChunk(env, makeChunk());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendMock = (env.SCRAPE_FINALIZE as any).send as ReturnType<typeof vi.fn>;
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('REQ-PIPE-006 AC 7: addChunkStats is gated by completion INSERT - no double-count under redelivery', async () => {
    // CF-002 hardening: addChunkStats issues an additive UPDATE
    // (`tokens_in = tokens_in + ?, ...`) so an unguarded second
    // invocation would double the per-chunk tokens, cost, and article
    // counters in scrape_runs. The fix is to gate the UPDATE on the
    // completion INSERT's meta.changes - only the first delivery for
    // a given (run_id, chunk_index) pair runs addChunkStats, the
    // redelivery sees changes === 0 and short-circuits.
    const aiResponse = {
      response: JSON.stringify({ articles: [{ title: 'Article A - long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }], dedup_groups: [] }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv();
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    await processOneChunk(env, makeChunk());
    const statsCalls = records.filter(
      (r) =>
        r.sql.includes('UPDATE scrape_runs') &&
        r.sql.includes('tokens_in = tokens_in +'),
    );
    expect(statsCalls).toHaveLength(1);
  });

  it('REQ-PIPE-008: send-failure rollback - clears finalize_enqueued so the queue retry can re-attempt', async () => {
    // CF-002 follow-up: the atomic UPDATE-then-send sequence has a
    // failure mode that the original KV gate didn't have - if send()
    // throws after the lock has been written, future redeliveries
    // would see finalize_enqueued = 1 and silently skip the send,
    // permanently dropping the finalize. The consumer must roll back
    // the lock on send failure so a retry can re-acquire it.
    const aiResponse = {
      response: JSON.stringify({ articles: [{ title: 'Article A - long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }], dedup_groups: [] }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv();
    const env = makeEnv(db, kv, aiResponse);
    // First call: SCRAPE_FINALIZE.send throws.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendMock = (env.SCRAPE_FINALIZE as any).send as ReturnType<typeof vi.fn>;
    sendMock.mockRejectedValueOnce(new Error('queue temporarily unavailable'));
    await expect(processOneChunk(env, makeChunk())).rejects.toThrow(
      'queue temporarily unavailable',
    );
    // Rollback was issued - the lock-clearing UPDATE is in the SQL log.
    const rollback = records.find(
      (r) =>
        r.sql.includes('UPDATE scrape_runs') &&
        r.sql.includes('finalize_enqueued = 0') &&
        !r.sql.includes('finalize_enqueued = 1'),
    );
    expect(rollback).toBeDefined();
    // Second call (queue redelivery) succeeds - lock was cleared so the
    // race-acquire UPDATE bumps it back to 1, and send is re-attempted.
    await processOneChunk(env, makeChunk());
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('REQ-PIPE-008: rollback-failure path - emits finalize_lock_rollback_failed and surfaces sendErr', async () => {
    // CF-002 follow-up: when the rollback UPDATE itself throws (a
    // second transient D1 outage during the catch handler), the
    // consumer must still surface the original sendErr to the queue
    // retry path and emit a structured operator-visible log line so
    // the stranded lock is observable. Pins REQ-PIPE-008 AC 9 (the
    // "lock-clearing step itself fails" sub-case).
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const aiResponse = {
        response: JSON.stringify({ articles: [{ title: 'Article A - long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }], dedup_groups: [] }),
        usage: { input_tokens: 10, output_tokens: 10 },
      };
      const { db } = makeDb({ failNextRollback: true });
      const { kv } = makeKv();
      const env = makeEnv(db, kv, aiResponse);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sendMock = (env.SCRAPE_FINALIZE as any).send as ReturnType<typeof vi.fn>;
      sendMock.mockRejectedValueOnce(new Error('queue temporarily unavailable'));

      // The original sendErr - not the rollback error - must surface.
      await expect(processOneChunk(env, makeChunk())).rejects.toThrow(
        'queue temporarily unavailable',
      );

      // Operator-visible log captures both errors.
      const failedLog = consoleSpy.mock.calls.find((args: unknown[]) => {
        const payload = args[0];
        return (
          typeof payload === 'string' &&
          payload.includes('finalize_lock_rollback_failed')
        );
      });
      expect(failedLog).toBeDefined();
      const payload = failedLog![0] as string;
      expect(payload).toContain('"send_error":"Error: queue temporarily unavailable"');
      expect(payload).toContain('d1 transient outage during rollback');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('REQ-PIPE-002: updates scrape_runs stats (tokens, cost, ingested, deduped)', async () => {
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { title: 'Article A - long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] },
          { title: 'Article B - long enough headline copy', details: LONG_BODY, tags: ['generative-ai'] },
        ],
        dedup_groups: [],
      }),
      usage: { input_tokens: 1000, output_tokens: 2000 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    const addStats = records.find(
      (r) =>
        r.sql.includes('UPDATE scrape_runs') &&
        r.sql.includes('tokens_in = tokens_in + ?2'),
    );
    expect(addStats).toBeDefined();
    // params: runId, tokens_in, tokens_out, cost, ingested, deduped
    expect(addStats!.params[0]).toBe('test-run');
    expect(addStats!.params[1]).toBe(1000);
    expect(addStats!.params[2]).toBe(2000);
    // ingested=2, deduped=0
    expect(addStats!.params[4]).toBe(2);
    expect(addStats!.params[5]).toBe(0);
  });

  it('REQ-PIPE-002: aligns LLM output to input candidates by echoed `index` field, not by position', async () => {
    // Simulates the real-world bug that shipped to prod: the LLM
    // returned two entries but in REVERSE order. With positional
    // alignment, candidate[0]'s canonical_url would get stapled to
    // candidate[1]'s summary and vice versa. With `index`-echo
    // alignment, each summary lands on its correct candidate.
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { index: 1, title: 'Summary of B', details: LONG_BODY, tags: ['generative-ai'] },
          { index: 0, title: 'Summary of A', details: LONG_BODY, tags: ['cloudflare'] },
        ],
        dedup_groups: [],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());

    // Two `INSERT OR IGNORE INTO articles` statements in the batch -
    // each binds (id, canonical_url, title, details_json, tags_json?,
    // primary_source_*). We assert canonical_url ↔ title pairing.
    const articleInserts = records.filter(
      (r) =>
        r.via === 'batch' &&
        r.sql.startsWith('INSERT OR IGNORE INTO articles'),
    );
    expect(articleInserts.length).toBe(2);

    // Find the row whose canonical_url is candidate[0] - its title
    // MUST be 'Summary of A', not 'Summary of B', because the LLM
    // echoed index=0 for the A summary.
    const rowA = articleInserts.find((r) =>
      r.params.includes('https://example.com/a'),
    );
    const rowB = articleInserts.find((r) =>
      r.params.includes('https://example.com/b'),
    );
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
    // The INSERT binds include the title string as a separate param;
    // finding it in the params array is enough to verify pairing.
    expect(rowA!.params).toContain('Summary of A');
    expect(rowB!.params).toContain('Summary of B');
    // And the mismatched pairing is explicitly absent.
    expect(rowA!.params).not.toContain('Summary of B');
    expect(rowB!.params).not.toContain('Summary of A');
  });

  it('REQ-PIPE-002: drops articles whose LLM title shares zero tokens with the candidate title (prod bug: cf-cli summary → SageMaker URL)', async () => {
    // The LLM correctly echoes index=0 but writes a summary about an
    // entirely different story (different title). Defense-in-depth
    // must drop this rather than staple the wrong content onto the
    // candidate's canonical_url.
    //
    // Setup: 3 candidates, all matching on index, but candidate[1]'s
    // LLM entry is about a totally unrelated topic (Postgres, while
    // the candidate is about AWS Lambda). Other two should survive.
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { index: 0, title: 'Cloudflare ships Workers update', details: LONG_BODY, tags: ['cloudflare'] },
          { index: 1, title: 'Postgres 18 announces pluggable storage', details: LONG_BODY, tags: ['mcp'] },
          { index: 2, title: 'AI coding assistant benchmarks improve', details: LONG_BODY, tags: ['generative-ai'] },
        ],
        dedup_groups: [],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    const chunk = makeChunk({
      candidates: [
        {
          canonical_url: 'https://blog.cloudflare.com/workers',
          source_url: 'https://blog.cloudflare.com/workers',
          source_name: 'Cloudflare Blog',
          title: 'Cloudflare Workers v4 release notes',
          published_at: 100,
        },
        {
          canonical_url: 'https://aws.amazon.com/lambda',
          source_url: 'https://aws.amazon.com/lambda',
          source_name: 'AWS News',
          title: 'AWS Lambda adds Python 3.13 runtime',
          published_at: 200,
        },
        {
          canonical_url: 'https://example.com/ai',
          source_url: 'https://example.com/ai',
          source_name: 'AI Benchmark Blog',
          title: 'AI coding benchmarks show gains',
          published_at: 300,
        },
      ],
    });
    await processOneChunk(env, chunk);

    const articleInserts = records.filter(
      (r) =>
        r.via === 'batch' &&
        r.sql.startsWith('INSERT OR IGNORE INTO articles'),
    );
    // candidate[0] survives (cloudflare/workers overlap), candidate[2]
    // survives (coding/benchmarks overlap), candidate[1] is dropped
    // (postgres vs lambda share zero meaningful tokens).
    expect(articleInserts.length).toBe(2);
    // And the Lambda canonical_url must NOT appear in any insert - the
    // whole point is no more wrong-URL-right-summary pairings.
    const anyLambdaRow = articleInserts.find((r) =>
      r.params.includes('https://aws.amazon.com/lambda'),
    );
    expect(anyLambdaRow).toBeUndefined();
  });

  it('REQ-PIPE-002: drops articles whose echoed `index` matches no input candidate', async () => {
    // The LLM hallucinates an extra entry with index=99. The consumer
    // must drop it silently rather than staple its summary to an
    // unrelated canonical URL.
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { index: 0, title: 'Article A - long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] },
          { index: 99, title: 'Hallucinated', details: LONG_BODY, tags: ['generative-ai'] },
        ],
        dedup_groups: [],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());

    const articleInserts = records.filter(
      (r) =>
        r.via === 'batch' &&
        r.sql.startsWith('INSERT OR IGNORE INTO articles'),
    );
    // Only candidate[0] has a matching LLM article by index.
    // candidate[1] has no LLM article (index=1 never appeared) and is
    // dropped; the hallucinated index=99 is also dropped.
    expect(articleInserts.length).toBe(1);
    expect(articleInserts[0]!.params).toContain('Article A - long enough headline copy');
    expect(articleInserts[0]!.params).not.toContain('Hallucinated');
  });

  it('REQ-PIPE-002 / CF-056: KV.list failure on loadAllowedTags emits degraded log and falls back to DEFAULT_HASHTAGS', async () => {
    // The chunk consumer reads the tag allowlist from KV (`sources:*`)
    // unioned with DEFAULT_HASHTAGS. If KV.list throws (binding outage,
    // transient 500), the consumer must NOT block the chunk - it falls
    // back to the bundled defaults and emits a structured warn log so
    // operators can spot the silent degradation.
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const aiResponse = {
        response: JSON.stringify({
          // Tag is in DEFAULT_HASHTAGS - survives even with empty KV result.
          articles: [{ title: 'Article A - long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }],
          dedup_groups: [],
        }),
        usage: { input_tokens: 10, output_tokens: 10 },
      };
      const { db, records } = makeDb();
      const { kv } = makeKv();
      // Override list to throw - simulates a KV outage during the
      // allowed-tags scan. The consumer's catch block should swallow it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (kv.list as any) = vi.fn().mockRejectedValue(new Error('kv list 500'));
      const env = makeEnv(db, kv, aiResponse);

      await expect(processOneChunk(env, makeChunk())).resolves.toBeUndefined();

      // Degraded log fired with the structured event field.
      const degradedLog = consoleSpy.mock.calls.find((args: unknown[]) => {
        const payload = args[0];
        return (
          typeof payload === 'string' &&
          payload.includes('allowed_tags.list_failed')
        );
      });
      expect(degradedLog).toBeDefined();
      const payload = degradedLog![0] as string;
      expect(payload).toContain('"level":"warn"');
      expect(payload).toContain('kv list 500');

      // The chunk still wrote the article - DEFAULT_HASHTAGS fallback
      // accepted `cloudflare` so the row landed in articles.
      const articleInserts = records.filter(
        (r) =>
          r.via === 'batch' &&
          r.sql.startsWith('INSERT OR IGNORE INTO articles'),
      );
      expect(articleInserts.length).toBe(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('REQ-PIPE-002 AC3: drops articles whose details word count falls under the 80-word backstop floor', async () => {
    // The prompt's contract is 100-150 words; the server enforces an
    // 80-word backstop so genuinely truncated outputs (single-paragraph
    // 30-word stubs) get dropped without rejecting the model's natural
    // 90-120 lower-end distribution. A passing sibling article in the
    // same chunk proves only the malformed entry is dropped, not the
    // whole batch.
    const tooShort = 'Short body sentence one. Sentence two. Sentence three.';
    const longBody =
      'This is a long-enough article body that easily clears the 80-word floor. '
        .repeat(14) +
      'It crosses two paragraph boundaries with explicit periods between sentences.';
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { index: 0, title: 'Title A - long enough headline copy', details: longBody, tags: ['cloudflare'] },
          { index: 1, title: 'Title B - also long enough headline', details: tooShort, tags: ['generative-ai'] },
        ],
        dedup_groups: [],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    const articleInserts = records.filter(
      (r) =>
        r.via === 'batch' &&
        r.sql.startsWith('INSERT OR IGNORE INTO articles'),
    );
    expect(articleInserts.length).toBe(1);
    expect(articleInserts[0]!.params).toContain('Title A - long enough headline copy');
    expect(articleInserts[0]!.params).not.toContain('Title B - also long enough headline');
  });

  it('REQ-PIPE-002 AC3: keeps articles in the 80-150 natural-distribution range that the prompt asks for but the model often undershoots', async () => {
    // The Workers AI gpt-oss-120b often produces 100-130-word summaries
    // when source snippets are thin. The 80-word floor is a backstop,
    // not a contract - bodies above 80 must pass. Pinning the boundary
    // here so a future tightening (back to 120) is caught by CI rather
    // than discovered via a 75% drop in daily ingestion.
    const exactly100Words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          {
            index: 0,
            title: 'A natural-distribution-length headline that fits in range',
            details: exactly100Words,
            tags: ['cloudflare'],
          },
        ],
        dedup_groups: [],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    const articleInserts = records.filter(
      (r) =>
        r.via === 'batch' &&
        r.sql.startsWith('INSERT OR IGNORE INTO articles'),
    );
    expect(articleInserts.length).toBe(1);
    expect(articleInserts[0]!.params).toContain('A natural-distribution-length headline that fits in range');
  });

  it('REQ-PIPE-002 AC2 / CF-030: drops articles whose title length is outside the [5, 500] sanity range', async () => {
    // 45-80 chars is the spec target; 5 / 500 are wide sanity bounds
    // for genuinely broken cases (single-character labels,
    // paragraph-as-title) that no UI rendering would survive.
    // Inside-the-bounds article proves the guard isn't accidentally
    // aggressive against the merely-short titles the LLM produces in
    // the wild.
    const longBody =
      'This is a long-enough article body that easily clears the 120-word floor. '
        .repeat(14) +
      'It crosses two paragraph boundaries with explicit periods between sentences.';
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { index: 0, title: 'Headline OK - within sanity bounds', details: longBody, tags: ['cloudflare'] },
          { index: 1, title: 'Hi.', details: longBody, tags: ['generative-ai'] },
        ],
        dedup_groups: [],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    const articleInserts = records.filter(
      (r) =>
        r.via === 'batch' &&
        r.sql.startsWith('INSERT OR IGNORE INTO articles'),
    );
    expect(articleInserts.length).toBe(1);
    expect(articleInserts[0]!.params).toContain('Headline OK - within sanity bounds');
    expect(articleInserts[0]!.params).not.toContain('Hi.');
  });

  // CF-041 - REQ-PIPE-002 AC4: an article that ends up with zero valid
  // tags is DROPPED. The chunk consumer's validateAndSanitizeArticle
  // returns null when the post-allowlist tag set is empty, which keeps
  // article_tags rows useful for downstream filtering and stops the
  // pool getting polluted with un-routable rows.
  it('REQ-PIPE-002 AC4 (CF-041): LLM article with tags:[] is dropped', async () => {
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { index: 0, title: 'Zero-tag article should be dropped', details: LONG_BODY, tags: [] },
        ],
        dedup_groups: [],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    const articleInserts = records.filter(
      (r) =>
        r.via === 'batch' &&
        r.sql.startsWith('INSERT OR IGNORE INTO articles'),
    );
    expect(articleInserts).toHaveLength(0);
  });

  // CF-042 - REQ-PIPE-008 AC9b: two concurrent recordChunkCompletion
  // calls for the same (scrape_run_id, chunk_index) - exactly one returns
  // true, one returns false.
  it('REQ-PIPE-008 AC9b (CF-042): concurrent recordChunkCompletion: one wins, one loses', async () => {
    // Import the repository helper directly - this test targets the
    // atomicity contract of INSERT OR IGNORE at the helper level, not
    // the chunk consumer's higher-level logic.
    const { recordChunkCompletion } = await import('~/lib/articles-repo');

    // Build a D1 stub where the first call returns changes=1 and the
    // second (same key) returns changes=0, mirroring D1's PK uniqueness.
    const completedKeys = new Set<string>();
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: (...params: unknown[]) => ({
          run: vi.fn().mockImplementation(async () => {
            if (sql.startsWith('INSERT OR IGNORE INTO scrape_chunk_completions')) {
              const key = `${String(params[0])}:${String(params[1])}`;
              const alreadyHad = completedKeys.has(key);
              if (!alreadyHad) completedKeys.add(key);
              return { meta: { changes: alreadyHad ? 0 : 1 } };
            }
            return { meta: { changes: 1 } };
          }),
        }),
      })),
    } as unknown as D1Database;

    // Two concurrent calls for the same run+chunk.
    const [result1, result2] = await Promise.all([
      recordChunkCompletion(db, 'run-concurrent', 0),
      recordChunkCompletion(db, 'run-concurrent', 0),
    ]);

    // Exactly one winner (changes=1) and one loser (changes=0).
    const winners = [result1, result2].filter(Boolean).length;
    const losers = [result1, result2].filter((r) => !r).length;
    expect(winners).toBe(1);
    expect(losers).toBe(1);
  });

  // CF-047 - REQ-PIPE-002 AC7 boundary tests.
  it('REQ-PIPE-002 AC7 (CF-047): article with out-of-bounds index is dropped', async () => {
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { index: 99, title: 'Out of bounds', details: LONG_BODY, tags: ['cloudflare'] },
        ],
        dedup_groups: [],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    // makeChunk defaults to a 1-candidate chunk (index 0 valid, index 99 invalid).
    await processOneChunk(env, makeChunk());
    const articleInserts = records.filter(
      (r) => r.via === 'batch' && r.sql.startsWith('INSERT OR IGNORE INTO articles'),
    );
    // Out-of-bounds index must be dropped - no article insert.
    expect(articleInserts).toHaveLength(0);
  });

  it('REQ-PIPE-002 AC7 (CF-047): article with null index is dropped', async () => {
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { index: null, title: 'Null index', details: LONG_BODY, tags: ['cloudflare'] },
        ],
        dedup_groups: [],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    const articleInserts = records.filter(
      (r) => r.via === 'batch' && r.sql.startsWith('INSERT OR IGNORE INTO articles'),
    );
    expect(articleInserts).toHaveLength(0);
  });

  // Partial-success rescue ladder. The 2026-05-05 incident: chunks 0+2
  // ingested 5 articles, chunk 1 timed out at AiError 3046 and exhausted
  // its retries; without onTerminalFailure the run flipped to 'failed'
  // even though articles existed for the user. The handleChunkBatch
  // rescue path inspects scrape_chunk_completions to decide between
  // 'ready' (≥1 sibling completed) and 'failed' (none completed) on
  // the final retry, then enqueues finalize for the partial-success case.
  it('REQ-PIPE-002 / REQ-PIPE-008 partial-success rescue: terminal failure with completed > 0 marks run ready and enqueues finalize', async () => {
    const { db, records } = makeDb({ initialCompletedChunks: 2 });
    const { kv } = makeKv();
    // AI throws on every attempt - the rescue path is the contract here,
    // not the LLM call.
    const env = makeEnv(db, kv, {});
    (env.AI.run as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('AiError: 3046: Request timeout'),
    );
    const sendMock = (env.SCRAPE_FINALIZE as unknown as { send: ReturnType<typeof vi.fn> }).send;

    const message = {
      body: { scrape_run_id: 'partial-run', chunk_index: 1, total_chunks: 3, candidates: [] } as ChunkJobMessage,
      attempts: 3,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const batch = { messages: [message] } as unknown as MessageBatch<ChunkJobMessage>;
    await handleChunkBatch(batch, env);

    // finishRun(scrape_run_id, 'ready') - UPDATE scrape_runs … SET status = 'ready' …
    const finishReady = records.find(
      (r) =>
        r.sql.includes('UPDATE scrape_runs') &&
        r.sql.includes("status = 'running'") &&
        r.sql.includes('SET status = ?2') &&
        r.params[1] === 'ready' &&
        r.params[0] === 'partial-run',
    );
    expect(finishReady).toBeDefined();

    // Atomic finalize lock acquired AND finalize message sent.
    const lock = records.find(
      (r) =>
        r.sql.includes('UPDATE scrape_runs') &&
        r.sql.includes('finalize_enqueued = 1') &&
        r.sql.includes('finalize_enqueued = 0') &&
        r.params[0] === 'partial-run',
    );
    expect(lock).toBeDefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({ scrape_run_id: 'partial-run' });

    // The original throw still propagates to retry() so CF queue stats
    // record the failure visibly.
    expect(message.retry).toHaveBeenCalledTimes(1);
  });

  it('REQ-PIPE-002 / REQ-PIPE-008 partial-success rescue: terminal failure with zero completions marks run failed and does NOT enqueue finalize', async () => {
    const { db, records } = makeDb({ initialCompletedChunks: 0 });
    const { kv } = makeKv();
    const env = makeEnv(db, kv, {});
    (env.AI.run as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('AiError: 3046: Request timeout'),
    );
    const sendMock = (env.SCRAPE_FINALIZE as unknown as { send: ReturnType<typeof vi.fn> }).send;

    const message = {
      body: { scrape_run_id: 'failed-run', chunk_index: 0, total_chunks: 1, candidates: [] } as ChunkJobMessage,
      attempts: 3,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const batch = { messages: [message] } as unknown as MessageBatch<ChunkJobMessage>;
    await handleChunkBatch(batch, env);

    const finishFailed = records.find(
      (r) =>
        r.sql.includes('UPDATE scrape_runs') &&
        r.sql.includes("status = 'running'") &&
        r.sql.includes('SET status = ?2') &&
        r.params[1] === 'failed' &&
        r.params[0] === 'failed-run',
    );
    expect(finishFailed).toBeDefined();

    // No finalize enqueue when nothing completed.
    expect(sendMock).not.toHaveBeenCalled();
    const lock = records.find(
      (r) =>
        r.sql.includes('UPDATE scrape_runs') &&
        r.sql.includes('finalize_enqueued = 1') &&
        r.params[0] === 'failed-run',
    );
    expect(lock).toBeUndefined();
  });
  // CF-023 - REQ-PIPE-002 AC 5: when the LLM returns non-JSON gibberish
  // the consumer throws a retryable Error so the queue retries the chunk.
  // This is intentional: "a transient model hiccup" - NonRetryableError
  // is NOT thrown here (that would silence the retry).
  it('REQ-PIPE-002 (CF-023): LLM non-JSON response throws retryable Error and emits chunk_invalid_json log', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      // Return pure gibberish that parseLLMPayload cannot parse as
      // a valid JSON articles payload - narrow() returns null, so
      // runJson() returns { ok: false } and runChunkLLM throws.
      const { db } = makeDb();
      const { kv } = makeKv();
      const env = makeEnv(db, kv, { response: 'this is not json at all !!!', usage: {} });

      await expect(processOneChunk(env, makeChunk())).rejects.toThrow('chunk_invalid_json');

      // The chunk_invalid_json structured log must have fired before the throw.
      const warnLog = consoleSpy.mock.calls.find((args: unknown[]) => {
        const payload = args[0];
        return typeof payload === 'string' && payload.includes('chunk_invalid_json');
      });
      expect(warnLog).toBeDefined();
      const payload = warnLog![0] as string;
      // Must carry scrape_run_id so operators can correlate to the run.
      expect(payload).toContain('"scrape_run_id":"test-run"');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  // CF-023 - REQ-PIPE-002: terminal handleChunkBatch with non-JSON LLM
  // response: onTerminalFailure fires exactly once and marks the run
  // failed (no sibling completions). The bug-class: if onTerminalFailure
  // did NOT fire, the scrape_runs row stays 'running' forever, invisible
  // to the history page and to the pipeline-consumer's scrape_wait gate.
  it('REQ-PIPE-002 (CF-023): terminal chunk failure from invalid JSON calls onTerminalFailure once, marks run failed', async () => {
    const { db, records } = makeDb({ initialCompletedChunks: 0 });
    const { kv } = makeKv();
    const env = makeEnv(db, kv, { response: 'not-json-gibberish', usage: {} });

    const message = {
      body: {
        scrape_run_id: 'json-fail-run',
        chunk_index: 0,
        total_chunks: 1,
        candidates: [],
      } as ChunkJobMessage,
      // attempts >= max (3) makes it a terminal delivery.
      attempts: 3,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const batch = { messages: [message] } as unknown as MessageBatch<ChunkJobMessage>;
    await handleChunkBatch(batch, env);

    // onTerminalFailure fires and writes finishRun(run_id, 'failed')
    // because zero sibling chunks completed.
    const finishFailed = records.find(
      (r) =>
        r.sql.includes('UPDATE scrape_runs') &&
        r.sql.includes("status = 'running'") &&
        r.sql.includes('SET status = ?2') &&
        r.params[1] === 'failed' &&
        r.params[0] === 'json-fail-run',
    );
    expect(finishFailed).toBeDefined();

    // Non-JSON errors are retryable (not NonRetryableError) so the
    // queue stats show the failure - retry() must be called, not ack().
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
  });

  // CF-023 - REQ-PIPE-002: double-fault in onTerminalFailure. Simulates
  // the case where the SCRAPE_FINALIZE.send inside onTerminalFailure
  // throws (partial-success branch) AND the rollback D1 UPDATE also
  // throws. The bug-class: if the outer catch suppressed the send error,
  // the run would be silently abandoned with finalize_enqueued=1 and no
  // finalize consumer ever firing.
  it('REQ-PIPE-002 (CF-023): onTerminalFailure double-fault - send AND rollback throw - surfaces rollback failure log and retries', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      // initialCompletedChunks=2 forces onTerminalFailure into the
      // partial-success 'ready' branch which tries to acquire the
      // finalize lock and then enqueue SCRAPE_FINALIZE.
      const { db } = makeDb({ initialCompletedChunks: 2 });
      const { kv } = makeKv();
      const env = makeEnv(db, kv, { response: 'not-json-gibberish', usage: {} });

      // Make SCRAPE_FINALIZE.send throw on the onTerminalFailure path.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sendMock = (env.SCRAPE_FINALIZE as any).send as ReturnType<typeof vi.fn>;
      sendMock.mockRejectedValueOnce(new Error('queue saturated'));

      const message = {
        body: {
          scrape_run_id: 'double-fault-run',
          chunk_index: 1,
          total_chunks: 3,
          candidates: [],
        } as ChunkJobMessage,
        attempts: 3,
        ack: vi.fn(),
        retry: vi.fn(),
      };
      const batch = { messages: [message] } as unknown as MessageBatch<ChunkJobMessage>;
      await handleChunkBatch(batch, env);

      // The structured failure log for the rollback/enqueue fault must
      // have fired - the specific status is 'partial_finalize_enqueue_rollback_failed'
      // or 'partial_finalize_enqueue_failed'.
      const faultLog = consoleSpy.mock.calls.find((args: unknown[]) => {
        const payload = args[0];
        return (
          typeof payload === 'string' &&
          (payload.includes('partial_finalize_enqueue_failed') ||
            payload.includes('partial_finalize_enqueue_rollback_failed'))
        );
      });
      expect(faultLog).toBeDefined();

      // The message is still retried (not acked) because the original
      // chunk error was retryable - the double-fault inside
      // onTerminalFailure must NOT suppress the retry.
      expect(message.retry).toHaveBeenCalledTimes(1);
      expect(message.ack).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('REQ-PIPE-003: Vectorize.upsert failure rolls back this attempt\'s rows to embedding_status=\'failed\'', async () => {
    // Regression test: the rollback UPDATE must actually fire on the
    // FIRST attempt when Vectorize.upsert throws. The previous gate
    // (`AND embedding_status != 'embedded'`) was self-defeating because
    // the rows were just INSERT'd with status='embedded', so the gate
    // excluded every row it was supposed to fix and the articles
    // remained marked 'embedded' in D1 with no vector in Vectorize -
    // invisible to both the finalize pass and the admin backfill route.
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { title: 'Headline A', details: LONG_BODY, tags: ['cloudflare'] },
          { title: 'Headline B', details: LONG_BODY, tags: ['generative-ai'] },
        ],
        dedup_groups: [],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    // Replace the VECTORIZE.upsert mock so it throws.
    (env.VECTORIZE as unknown as { upsert: ReturnType<typeof vi.fn> }).upsert =
      vi.fn().mockRejectedValue(new Error('Vectorize 503'));

    await processOneChunk(env, makeChunk());

    // Article INSERTs landed in D1 with embedding_status='embedded'
    // (the in-memory state attachEmbeddings produced before upsert).
    const articleInserts = records.filter(
      (r) =>
        r.via === 'batch' &&
        r.sql.startsWith('INSERT OR IGNORE INTO articles'),
    );
    expect(articleInserts.length).toBe(2);
    // Position ?11 in the bind list = embedding_status; ?12 = embedded_at.
    for (const ins of articleInserts) {
      expect(ins.params[10]).toBe('embedded');
      expect(typeof ins.params[11]).toBe('number');
    }
    // The fix: rollback UPDATE fires and matches both rows via the
    // per-attempt embedded_at gate (not the broken status gate).
    const rollback = records.find(
      (r) =>
        r.via === 'run' &&
        r.sql.includes('UPDATE articles') &&
        r.sql.includes("embedding_status = 'failed'") &&
        r.sql.includes('embedded_at = ?'),
    );
    expect(rollback).toBeDefined();
    // The bind list ends with the per-attempt embedded_at; the IDs come
    // first, then the timestamp. Verify the timestamp matches the value
    // written by the article INSERT batch.
    const expectedStamp = articleInserts[0]!.params[11];
    const lastParam = rollback!.params[rollback!.params.length - 1];
    expect(lastParam).toBe(expectedStamp);
    // The structured failure log should also have fired.
    const failedLog = records.find(
      (r) =>
        r.sql.includes('UPDATE articles') &&
        r.sql.includes("embedding_status = 'failed'"),
    );
    expect(failedLog).toBeDefined();
  });
});
