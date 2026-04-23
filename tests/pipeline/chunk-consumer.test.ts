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
} = {}): { db: D1Database; records: SqlRecord[] } {
  const records = opts.records ?? [];
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const binder = (...params: unknown[]) => ({
      __sql: sql,
      __params: params,
      run: vi.fn().mockImplementation(async () => {
        records.push({ sql, params, via: 'run' });
        return { success: true, meta: { changes: 1 } };
      }),
      all: vi.fn().mockImplementation(async () => {
        records.push({ sql, params, via: 'all' });
        return { success: true, results: [] };
      }),
      first: vi.fn().mockImplementation(async () => {
        records.push({ sql, params, via: 'first' });
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
    DIGEST_JOBS: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue<unknown>,
    ASSETS: {} as Fetcher,
    OAUTH_CLIENT_ID: 'x',
    OAUTH_CLIENT_SECRET: 'x',
    OAUTH_JWT_SECRET: 'x',
    RESEND_API_KEY: 'x',
    RESEND_FROM: 'x',
    APP_URL: 'https://test.example.com',
  } as unknown as Env;
}

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
          { title: 'NYT-A', details: 'para.', tags: ['cloudflare'] },
          { title: 'NYT-B', details: 'para.', tags: ['ai'] },
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
                { title: 'Title-A', details: 'body A', tags: ['cloudflare'] },
                { title: 'Title-B', details: 'body B', tags: ['ai'] },
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
          { title: 'Merged Story', details: 'body.', tags: ['cloudflare'] },
          { title: 'Ignored', details: 'body.', tags: ['cloudflare'] },
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
        r.via === 'batch' && r.sql.includes('INSERT INTO article_sources'),
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
          { title: 'Bad tags only', details: 'body', tags: ['not-a-real-tag', 'another-bogus-tag'] },
          { title: 'Good tags', details: 'body', tags: ['cloudflare'] },
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

  it('REQ-PIPE-002: writes articles + article_sources + article_tags in a single D1 batch', async () => {
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { title: 'A', details: 'a.', tags: ['cloudflare', 'ai'] },
          { title: 'B', details: 'b.', tags: ['ai'] },
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
          title: 'A',
          published_at: 100,
          alternatives: [
            { source_url: 'https://mirror.example.com/a', source_name: 'Mirror' },
          ],
        },
        {
          canonical_url: 'https://example.com/b',
          source_url: 'https://example.com/b',
          source_name: 'B',
          title: 'B',
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
      batched.some((r) => r.sql.includes('INSERT INTO article_sources')),
    ).toBe(true);
    expect(
      batched.some((r) => r.sql.startsWith('INSERT INTO article_tags')),
    ).toBe(true);
    // 2 articles + 1 alt + 3 tags (2 for A + 1 for B) = 6 batch statements.
    expect(batched.length).toBe(6);
  });

  it('REQ-PIPE-002: decrements KV chunks_remaining; last chunk calls finishRun(ready)', async () => {
    const aiResponse = {
      response: JSON.stringify({ articles: [{ title: 'A', details: 'a.', tags: ['cloudflare'] }, { title: 'B', details: 'b.', tags: ['ai'] }], dedup_groups: [] }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv, state } = makeKv({ chunksRemaining: '1' });
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    // Counter went from 1 → 0.
    expect(state.store.get('scrape_run:test-run:chunks_remaining')).toBe('0');
    // finishRun emitted its UPDATE.
    const finish = records.find(
      (r) =>
        r.sql.includes('UPDATE scrape_runs') &&
        (r.params as unknown[])[1] === 'ready',
    );
    expect(finish).toBeDefined();
  });

  it('REQ-PIPE-002: non-last chunk leaves the counter above zero and does NOT call finishRun', async () => {
    const aiResponse = {
      response: JSON.stringify({ articles: [{ title: 'A', details: 'a.', tags: ['cloudflare'] }, { title: 'B', details: 'b.', tags: ['ai'] }], dedup_groups: [] }),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    const { db, records } = makeDb();
    const { kv, state } = makeKv({ chunksRemaining: '3' });
    const env = makeEnv(db, kv, aiResponse);
    await processOneChunk(env, makeChunk());
    expect(state.store.get('scrape_run:test-run:chunks_remaining')).toBe('2');
    const finish = records.find(
      (r) =>
        r.sql.includes('UPDATE scrape_runs') &&
        (r.params as unknown[])[1] === 'ready',
    );
    expect(finish).toBeUndefined();
  });

  it('REQ-PIPE-002: updates scrape_runs stats (tokens, cost, ingested, deduped)', async () => {
    const aiResponse = {
      response: JSON.stringify({
        articles: [
          { title: 'A', details: 'a.', tags: ['cloudflare'] },
          { title: 'B', details: 'b.', tags: ['ai'] },
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
});
