// Tests for src/queue/scrape-chunk-consumer.ts — REQ-PIPE-002.
//
// The chunk consumer calls Workers AI once per chunk, parses the JSON
// response, collapses LLM-provided dedup_groups, validates tags against
// the allowlist, and writes articles + article_sources + article_tags
// in a single D1 batch. The tests stub env.AI.run, D1, KV, and assert
// on the observable behaviour contracts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processOneChunk } from '~/queue/scrape-chunk-consumer';
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
  // honors PK uniqueness — duplicate inserts are no-ops, matching D1.
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
            // Consume the one-shot — only the first rollback throws,
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
  return {
    DB: db,
    KV: kv,
    AI: {
      run: vi.fn().mockResolvedValue(aiResponse),
    } as unknown as Ai,
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

/** CF-030 — chunk consumer enforces a 120-word floor on `details`
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

describe('scrape-chunk-consumer — REQ-PIPE-002', () => {
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
    expect(runMock).toHaveBeenCalledTimes(1);
    const [model, params] = runMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(typeof model).toBe('string');
    expect(model.length).toBeGreaterThan(0);
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
    // Two candidates for the same story — LLM hints dedup_groups = [[0,1]].
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
        articles: [{ title: 'Article A — long enough headline copy', details: [LONG_BODY], tags: ['cloudflare'] }],
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
    // These columns are NOT NULL in migration 0003 — the INSERT MUST
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
          { title: 'Article A — long enough headline copy', details: LONG_BODY, tags: ['cloudflare', 'generative-ai'] },
          { title: 'Article B — long enough headline copy', details: LONG_BODY, tags: ['generative-ai'] },
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
          title: 'Article A — long enough headline copy',
          published_at: 100,
          alternatives: [
            { source_url: 'https://mirror.example.com/a', source_name: 'Mirror' },
          ],
        },
        {
          canonical_url: 'https://example.com/b',
          source_url: 'https://example.com/b',
          source_name: 'B',
          title: 'Article B — long enough headline copy',
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

  it('REQ-PIPE-002: completing the final chunk calls finishRun(ready) and zeroes the KV mirror', async () => {
    // CF-002: the run's "are we done?" gate is now the count of rows
    // in scrape_chunk_completions, not a KV decrement. The KV counter
    // is kept as a derived mirror so /api/scrape-status keeps working.
    const aiResponse = {
      response: JSON.stringify({ articles: [{ title: 'Article A — long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }, { title: 'Article B — long enough headline copy', details: LONG_BODY, tags: ['generative-ai'] }], dedup_groups: [] }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv, state } = makeKv();
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    // total_chunks=1 (default) and we just inserted chunk 0 → done=1 → finalize.
    expect(state.store.get('scrape_run:test-run:chunks_remaining')).toBe('0');
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

  it('REQ-PIPE-002: non-last chunk leaves the KV mirror above zero and does NOT call finishRun', async () => {
    const aiResponse = {
      response: JSON.stringify({ articles: [{ title: 'Article A — long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }, { title: 'Article B — long enough headline copy', details: LONG_BODY, tags: ['generative-ai'] }], dedup_groups: [] }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv, state } = makeKv();
    const env = makeEnv(db, kv, aiResponse);
    // total_chunks=4 simulates a multi-chunk run; this is chunk 0 of 4.
    await processOneChunk(env, makeChunk({ chunk_index: 0, total_chunks: 4 }));
    expect(state.store.get('scrape_run:test-run:chunks_remaining')).toBe('3');
    const finish = records.find(
      (r) =>
        r.sql.includes('UPDATE scrape_runs') &&
        (r.params as unknown[])[1] === 'ready',
    );
    expect(finish).toBeUndefined();
  });

  it('REQ-PIPE-008: last chunk enqueues exactly one SCRAPE_FINALIZE message after finishRun', async () => {
    const aiResponse = {
      response: JSON.stringify({ articles: [{ title: 'Article A — long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }], dedup_groups: [] }),
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
      response: JSON.stringify({ articles: [{ title: 'Article A — long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }], dedup_groups: [] }),
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
      response: JSON.stringify({ articles: [{ title: 'Article A — long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }], dedup_groups: [] }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db } = makeDb();
    const { kv, state } = makeKv();
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    // KV mirror has been zeroed; the finalize lock lives on the D1 row.
    expect(state.store.get('scrape_run:test-run:chunks_remaining')).toBe('0');
    await processOneChunk(env, makeChunk());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendMock = (env.SCRAPE_FINALIZE as any).send as ReturnType<typeof vi.fn>;
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('REQ-PIPE-006 AC 7: addChunkStats is gated by completion INSERT — no double-count under redelivery', async () => {
    // CF-002 hardening: addChunkStats issues an additive UPDATE
    // (`tokens_in = tokens_in + ?, ...`) so an unguarded second
    // invocation would double the per-chunk tokens, cost, and article
    // counters in scrape_runs. The fix is to gate the UPDATE on the
    // completion INSERT's meta.changes — only the first delivery for
    // a given (run_id, chunk_index) pair runs addChunkStats, the
    // redelivery sees changes === 0 and short-circuits.
    const aiResponse = {
      response: JSON.stringify({ articles: [{ title: 'Article A — long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }], dedup_groups: [] }),
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

  it('REQ-PIPE-008: send-failure rollback — clears finalize_enqueued so the queue retry can re-attempt', async () => {
    // CF-002 follow-up: the atomic UPDATE-then-send sequence has a
    // failure mode that the original KV gate didn't have — if send()
    // throws after the lock has been written, future redeliveries
    // would see finalize_enqueued = 1 and silently skip the send,
    // permanently dropping the finalize. The consumer must roll back
    // the lock on send failure so a retry can re-acquire it.
    const aiResponse = {
      response: JSON.stringify({ articles: [{ title: 'Article A — long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }], dedup_groups: [] }),
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
    // Rollback was issued — the lock-clearing UPDATE is in the SQL log.
    const rollback = records.find(
      (r) =>
        r.sql.includes('UPDATE scrape_runs') &&
        r.sql.includes('finalize_enqueued = 0') &&
        !r.sql.includes('finalize_enqueued = 1'),
    );
    expect(rollback).toBeDefined();
    // Second call (queue redelivery) succeeds — lock was cleared so the
    // race-acquire UPDATE bumps it back to 1, and send is re-attempted.
    await processOneChunk(env, makeChunk());
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('REQ-PIPE-008: rollback-failure path — emits finalize_lock_rollback_failed and surfaces sendErr', async () => {
    // CF-002 follow-up: when the rollback UPDATE itself throws (a
    // second transient D1 outage during the catch handler), the
    // consumer must still surface the original sendErr to the queue
    // retry path and emit a structured operator-visible log line so
    // the stranded lock is observable. Pins REQ-PIPE-008 AC 9 (the
    // "lock-clearing step itself fails" sub-case).
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const aiResponse = {
        response: JSON.stringify({ articles: [{ title: 'Article A — long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }], dedup_groups: [] }),
        usage: { input_tokens: 10, output_tokens: 10 },
      };
      const { db } = makeDb({ failNextRollback: true });
      const { kv } = makeKv();
      const env = makeEnv(db, kv, aiResponse);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sendMock = (env.SCRAPE_FINALIZE as any).send as ReturnType<typeof vi.fn>;
      sendMock.mockRejectedValueOnce(new Error('queue temporarily unavailable'));

      // The original sendErr — not the rollback error — must surface.
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
          { title: 'Article A — long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] },
          { title: 'Article B — long enough headline copy', details: LONG_BODY, tags: ['generative-ai'] },
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

    // Two `INSERT OR IGNORE INTO articles` statements in the batch —
    // each binds (id, canonical_url, title, details_json, tags_json?,
    // primary_source_*). We assert canonical_url ↔ title pairing.
    const articleInserts = records.filter(
      (r) =>
        r.via === 'batch' &&
        r.sql.startsWith('INSERT OR IGNORE INTO articles'),
    );
    expect(articleInserts.length).toBe(2);

    // Find the row whose canonical_url is candidate[0] — its title
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
    // And the Lambda canonical_url must NOT appear in any insert — the
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
          { index: 0, title: 'Article A — long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] },
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
    expect(articleInserts[0]!.params).toContain('A');
    expect(articleInserts[0]!.params).not.toContain('Hallucinated');
  });

  it('REQ-PIPE-002 / CF-056: KV.list failure on loadAllowedTags emits degraded log and falls back to DEFAULT_HASHTAGS', async () => {
    // The chunk consumer reads the tag allowlist from KV (`sources:*`)
    // unioned with DEFAULT_HASHTAGS. If KV.list throws (binding outage,
    // transient 500), the consumer must NOT block the chunk — it falls
    // back to the bundled defaults and emits a structured warn log so
    // operators can spot the silent degradation.
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const aiResponse = {
        response: JSON.stringify({
          // Tag is in DEFAULT_HASHTAGS — survives even with empty KV result.
          articles: [{ title: 'Article A — long enough headline copy', details: LONG_BODY, tags: ['cloudflare'] }],
          dedup_groups: [],
        }),
        usage: { input_tokens: 10, output_tokens: 10 },
      };
      const { db, records } = makeDb();
      const { kv } = makeKv();
      // Override list to throw — simulates a KV outage during the
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

      // The chunk still wrote the article — DEFAULT_HASHTAGS fallback
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

  it('REQ-PIPE-002 AC3 / CF-030: drops articles whose details word count falls under the 120-word floor', async () => {
    // The prompt itself flags responses under ~120 words as malformed.
    // Without a server-side guard a model that ignores the contract
    // can still ship a 30-word stub as a real article. A passing
    // sibling article in the same chunk proves only the malformed
    // entry is dropped, not the whole batch.
    const tooShort = 'Short body sentence one. Sentence two. Sentence three.';
    const longBody =
      'This is a long-enough article body that easily clears the 120-word floor. '
        .repeat(14) +
      'It crosses two paragraph boundaries with explicit periods between sentences.';
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { index: 0, title: 'Title A — long enough headline copy', details: longBody, tags: ['cloudflare'] },
          { index: 1, title: 'Title B — also long enough headline', details: tooShort, tags: ['generative-ai'] },
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
    expect(articleInserts[0]!.params).toContain('Title A — long enough headline copy');
    expect(articleInserts[0]!.params).not.toContain('Title B — also long enough headline');
  });

  it('REQ-PIPE-002 AC2 / CF-030: drops articles whose title length is outside the [20, 200] sanity range', async () => {
    // 45-80 chars is the spec target; 20 / 200 are sanity bounds for
    // genuinely broken cases (single-word labels, paragraph-as-title)
    // that no UI rendering would survive. Inside-the-bounds article
    // proves the guard isn't accidentally aggressive.
    const longBody =
      'This is a long-enough article body that easily clears the 120-word floor. '
        .repeat(14) +
      'It crosses two paragraph boundaries with explicit periods between sentences.';
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { index: 0, title: 'Headline OK — within sanity bounds', details: longBody, tags: ['cloudflare'] },
          { index: 1, title: 'Tiny', details: longBody, tags: ['generative-ai'] },
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
    expect(articleInserts[0]!.params).toContain('Headline OK — within sanity bounds');
    expect(articleInserts[0]!.params).not.toContain('Tiny');
  });
});
