// Tests for src/lib/generate.ts generateDigest — REQ-GEN-001 through -008.
//
// Uses hand-rolled mocks for env.AI, env.DB (D1), env.KV so we can assert
// the exact SQL shape and the atomicity of the final db.batch([...]) call.
// No network, no real D1 — the Cloudflare vitest pool still runs this in
// the Workers runtime so bindings types resolve.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateDigest } from '~/lib/generate';
import type { AuthenticatedUser, Headline } from '~/lib/types';

// --- Types for the mock surfaces -----------------------------------------

interface PreparedCall {
  sql: string;
  params: unknown[];
}

interface DbMock {
  db: D1Database;
  prepareCalls: PreparedCall[];
  runCalls: PreparedCall[];
  batches: PreparedCall[][];
  /** Rows returned by `.first()` for SELECTs, keyed by a substring of the sql. */
  selectResponses: Map<string, unknown>;
  /** changes count for each kind of statement */
  insertChanges: number;
  updateChanges: number;
  /** Force batch() to throw with this error on the next call. */
  batchShouldThrow: Error | null;
  /** Force prepared.run() for inserts to throw. */
  insertShouldThrow: Error | null;
}

interface KvMock {
  kv: KVNamespace;
  store: Map<string, string>;
  getCalls: string[];
}

interface AiMock {
  ai: Ai;
  run: ReturnType<typeof vi.fn>;
}

// --- Builders -------------------------------------------------------------

function makeDb(): DbMock {
  const prepareCalls: PreparedCall[] = [];
  const runCalls: PreparedCall[] = [];
  const batches: PreparedCall[][] = [];
  const selectResponses = new Map<string, unknown>();
  const mock: DbMock = {
    prepareCalls,
    runCalls,
    batches,
    selectResponses,
    insertChanges: 1,
    updateChanges: 1,
    batchShouldThrow: null,
    insertShouldThrow: null,
  } as DbMock;

  const prepareSpy = vi.fn().mockImplementation((sql: string) => {
    const call: PreparedCall = { sql, params: [] };
    prepareCalls.push(call);
    const bound: PreparedCall = call;
    return {
      bind: (...params: unknown[]) => {
        bound.params = params;
        return {
          first: vi.fn().mockImplementation(async () => {
            for (const [needle, value] of selectResponses) {
              if (sql.includes(needle)) return value;
            }
            return null;
          }),
          run: vi.fn().mockImplementation(async () => {
            if (mock.insertShouldThrow !== null && sql.trim().startsWith('INSERT')) {
              throw mock.insertShouldThrow;
            }
            runCalls.push({ sql, params });
            const changes = sql.trim().startsWith('INSERT')
              ? mock.insertChanges
              : sql.trim().startsWith('UPDATE')
                ? mock.updateChanges
                : 1;
            return { success: true, meta: { changes } };
          }),
          all: vi.fn().mockResolvedValue({ results: [] }),
        };
      },
    };
  });

  const batchSpy = vi.fn().mockImplementation(
    async (statements: Array<{ __call?: PreparedCall }>) => {
      if (mock.batchShouldThrow !== null) {
        throw mock.batchShouldThrow;
      }
      // Extract the recorded PreparedCall from each statement via the
      // most-recent prepareCalls entries — D1PreparedStatement does not
      // expose its bound params. We match up by pointer equality on the
      // bind-level wrapper object; since each bind() returns a fresh
      // object, statements[i] corresponds to prepareCalls[N-len+i].
      const snapshot: PreparedCall[] = prepareCalls
        .slice(prepareCalls.length - statements.length)
        .map((c) => ({ sql: c.sql, params: [...c.params] }));
      batches.push(snapshot);
      return statements.map(() => ({ success: true }));
    },
  );

  const exec = vi.fn().mockResolvedValue(undefined);
  mock.db = {
    prepare: prepareSpy,
    batch: batchSpy,
    exec,
  } as unknown as D1Database;
  return mock;
}

function makeKv(): KvMock {
  const store = new Map<string, string>();
  const getCalls: string[] = [];
  const kv = {
    get: vi.fn().mockImplementation(async (key: string) => {
      getCalls.push(key);
      return store.get(key) ?? null;
    }),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as KVNamespace;
  return { kv, store, getCalls };
}

function makeAi(responseJson: string | Error | null): AiMock {
  const run = vi.fn().mockImplementation(async () => {
    if (responseJson instanceof Error) throw responseJson;
    return {
      response: responseJson,
      usage: { input_tokens: 800, output_tokens: 400 },
    };
  });
  const ai = { run } as unknown as Ai;
  return { ai, run };
}

function makeEnv(opts: {
  db: DbMock;
  kv: KvMock;
  ai: AiMock;
}): Env {
  return {
    DB: opts.db.db,
    KV: opts.kv.kv,
    AI: opts.ai.ai,
    APP_URL: 'https://news-digest.example.com',
    RESEND_API_KEY: 're_test_key',
    RESEND_FROM: 'News Digest <digest@example.com>',
  } as unknown as Env;
}

function makeUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: '12345',
    email: 'alice@example.com',
    gh_login: 'alice',
    tz: 'UTC',
    digest_hour: 8,
    digest_minute: 0,
    hashtags_json: '["#ai", "#cloudflare"]',
    model_id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    email_enabled: 1,
    session_version: 1,
    ...overrides,
  };
}

/** Seed KV with a couple of headlines pre-cached so the fan-out succeeds
 * without touching network. */
function seedHeadlines(kv: KvMock): Headline[] {
  const headlines: Headline[] = [
    {
      title: 'Cloudflare launches Workers AI v2',
      url: 'https://blog.cloudflare.com/workers-ai-v2',
      source_name: 'hackernews',
    },
    {
      title: 'OpenAI announces new model',
      url: 'https://example.com/openai-news',
      source_name: 'googlenews',
    },
    {
      title: 'Reddit thread about AI regulation',
      url: 'https://reddit.com/r/technology/ai-regulation',
      source_name: 'reddit',
    },
  ];
  // Pre-cache all 3 generic sources × 2 tags, pointing to the same list so
  // fanOutForTags dedupes down to 3 unique.
  for (const tag of ['ai', 'cloudflare']) {
    for (const source of ['hackernews', 'googlenews', 'reddit']) {
      kv.store.set(
        `headlines:${source}:${tag}`,
        JSON.stringify(headlines),
      );
    }
  }
  return headlines;
}

/** Happy-path LLM response: 2 articles with all required fields. */
function happyLLMResponse(headlines: Headline[]): string {
  return JSON.stringify({
    articles: [
      {
        title: headlines[0]!.title,
        url: headlines[0]!.url,
        one_liner: 'Major Workers AI release with new models and pricing.',
        details: [
          'Several new models added to the catalog.',
          'Per-token pricing now published for most models.',
          'Automatic retry on transient failures.',
        ],
      },
      {
        title: headlines[1]!.title,
        url: headlines[1]!.url,
        one_liner: 'OpenAI releases a new flagship frontier model.',
        details: [
          'Larger context window.',
          'Improved reasoning benchmarks.',
          'Available via API with tiered pricing.',
        ],
      },
    ],
  });
}

// --- Assertions ---------------------------------------------------------

function findStatementMatching(
  calls: PreparedCall[],
  predicate: (sql: string) => boolean,
): PreparedCall | undefined {
  return calls.find((c) => predicate(c.sql));
}

// --- Tests --------------------------------------------------------------

describe('generateDigest — happy path', () => {
  let db: DbMock;
  let kv: KvMock;
  let ai: AiMock;
  let env: Env;
  let user: AuthenticatedUser;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    db = makeDb();
    kv = makeKv();
    const headlines = seedHeadlines(kv);
    ai = makeAi(happyLLMResponse(headlines));
    env = makeEnv({ db, kv, ai });
    user = makeUser();
    // Prevent the email POST from actually attempting a network call.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('REQ-GEN-001: scheduled trigger INSERTs a new digest row with local_date dedupe guard', async () => {
    const result = await generateDigest(env, user, 'scheduled');
    expect(result.status).toBe('ready');
    expect(result.digestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const insert = findStatementMatching(
      db.prepareCalls,
      (sql) => sql.includes('INSERT INTO digests'),
    );
    expect(insert).toBeDefined();
    // The INSERT must carry a NOT EXISTS dedupe guard — otherwise we could
    // create a second digest for the same user+local_date.
    expect(insert!.sql).toContain('NOT EXISTS');
    expect(insert!.sql).toContain('status');
    expect(insert!.params).toContain(user.id);
  });

  it("REQ-GEN-001/002: manual trigger UPDATEs the existing in_progress row instead of inserting", async () => {
    const existingId = '01JABCXYZ00000000000000000';
    const result = await generateDigest(env, user, 'manual', existingId);
    expect(result.status).toBe('ready');
    expect(result.digestId).toBe(existingId);

    const insert = findStatementMatching(
      db.prepareCalls,
      (sql) => sql.includes('INSERT INTO digests'),
    );
    expect(insert).toBeUndefined();
    const claimUpdate = findStatementMatching(
      db.prepareCalls,
      (sql) => sql.includes('UPDATE digests') && sql.includes('generated_at'),
    );
    expect(claimUpdate).toBeDefined();
    expect(claimUpdate!.params).toContain(existingId);
  });

  it('REQ-GEN-005: calls env.AI.run with DIGEST_SYSTEM + digestUserPrompt and LLM_PARAMS', async () => {
    await generateDigest(env, user, 'scheduled');
    expect(ai.run).toHaveBeenCalledTimes(1);
    const call = ai.run.mock.calls[0]!;
    expect(call[0]).toBe(user.model_id);
    const params = call[1] as {
      messages?: Array<{ role: string; content: string }>;
      temperature?: number;
      max_tokens?: number;
      response_format?: { type: string };
    };
    expect(Array.isArray(params.messages)).toBe(true);
    expect(params.messages).toHaveLength(2);
    expect(params.messages?.[0]?.role).toBe('system');
    // System prompt begins with the JSON-API contract (see DIGEST_SYSTEM).
    expect(params.messages?.[0]?.content).toContain('JSON API');
    expect(params.messages?.[1]?.role).toBe('user');
    expect(params.messages?.[1]?.content).toContain('User interests');
    // LLM_PARAMS pinned.
    expect(params.temperature).toBe(0.2);
    expect(params.max_tokens).toBe(8192);
    expect(params.response_format).toEqual({ type: 'json_object' });
  });

  it('REQ-GEN-003: fan-out reads sources:{tag} from KV for each user tag', async () => {
    await generateDigest(env, user, 'scheduled');
    // The loader tries to read sources:ai and sources:cloudflare (bare
    // hashtag form, stripped of leading `#`).
    expect(kv.getCalls).toContain('sources:ai');
    expect(kv.getCalls).toContain('sources:cloudflare');
  });

  it('REQ-GEN-006: commits articles, digest update, and user update in ONE atomic batch', async () => {
    await generateDigest(env, user, 'scheduled');
    expect(db.batches).toHaveLength(1);
    const batch = db.batches[0]!;
    // 2 articles + 1 digest UPDATE + 1 user UPDATE = 4 statements.
    expect(batch).toHaveLength(4);
    // First N should be article INSERTs.
    expect(batch[0]!.sql).toMatch(/INSERT INTO articles/);
    expect(batch[1]!.sql).toMatch(/INSERT INTO articles/);
    // Penultimate is the digest status update with the status='in_progress' guard.
    expect(batch[2]!.sql).toMatch(/UPDATE digests/);
    expect(batch[2]!.sql).toContain("status = 'ready'");
    expect(batch[2]!.sql).toContain("status = 'in_progress'");
    // Last is the user dedupe-key update.
    expect(batch[3]!.sql).toMatch(/UPDATE users/);
    expect(batch[3]!.sql).toContain('last_generated_local_date');
  });

  it('REQ-GEN-008: digest UPDATE carries execution_ms, tokens_in, tokens_out, estimated_cost_usd', async () => {
    await generateDigest(env, user, 'scheduled');
    const batch = db.batches[0]!;
    const digestUpdate = batch.find(
      (c) => c.sql.includes('UPDATE digests') && c.sql.includes('execution_ms'),
    );
    expect(digestUpdate).toBeDefined();
    // Params order: execution_ms, tokens_in, tokens_out, cost, id.
    const params = digestUpdate!.params;
    // tokens_in is 800 from our AI mock, tokens_out is 400.
    expect(params[1]).toBe(800);
    expect(params[2]).toBe(400);
    // Cost: 800 * 0.045/1e6 + 400 * 0.384/1e6 ≈ 0.0001896
    const cost = params[3] as number;
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01);
    // execution_ms is the elapsed time; must be non-negative.
    expect(params[0]).toBeTypeOf('number');
    expect(params[0] as number).toBeGreaterThanOrEqual(0);
  });

  it('REQ-GEN-006: articles have ULID ids, slugs, and sequential ranks', async () => {
    await generateDigest(env, user, 'scheduled');
    const batch = db.batches[0]!;
    const inserts = batch.filter((c) => c.sql.includes('INSERT INTO articles'));
    expect(inserts).toHaveLength(2);
    for (let i = 0; i < inserts.length; i++) {
      // Params: id, digest_id, slug, source_url, title, one_liner,
      // details_json, source_name, rank
      const params = inserts[i]!.params;
      expect(params[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(typeof params[2]).toBe('string');
      expect((params[2] as string).length).toBeGreaterThan(0);
      expect(params[8]).toBe(i + 1);
      // details_json is a string (JSON array).
      expect(typeof params[6]).toBe('string');
      JSON.parse(params[6] as string);
    }
  });

  it('REQ-GEN-006: INSERT binds source_name resolved from the dedupe headline map', async () => {
    await generateDigest(env, user, 'scheduled');
    const batch = db.batches[0]!;
    const inserts = batch.filter((c) => c.sql.includes('INSERT INTO articles'));
    expect(inserts).toHaveLength(2);
    // The INSERT column list must include source_name between details_json
    // and rank so the badge column is populated on every article row.
    for (const insert of inserts) {
      expect(insert.sql).toContain('source_name');
    }
    // First article URL maps to the hackernews headline; second to
    // googlenews. The resolution goes through canonicalize() so http→https
    // and trailing-slash variants all collapse onto the same key.
    expect(inserts[0]!.params[7]).toBe('hackernews');
    expect(inserts[1]!.params[7]).toBe('googlenews');
  });

  it('REQ-GEN-006: duplicate-title articles get deduplicated slugs within the batch', async () => {
    // Rewire the AI mock to return two articles with the same title.
    ai.run.mockResolvedValue({
      response: JSON.stringify({
        articles: [
          {
            title: 'Duplicate',
            url: 'https://e/1',
            one_liner: 'First.',
            details: ['a', 'b', 'c'],
          },
          {
            title: 'Duplicate',
            url: 'https://e/2',
            one_liner: 'Second.',
            details: ['a', 'b', 'c'],
          },
        ],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    await generateDigest(env, user, 'scheduled');
    const batch = db.batches[0]!;
    const slugs = batch
      .filter((c) => c.sql.includes('INSERT INTO articles'))
      .map((c) => c.params[2] as string);
    expect(slugs).toEqual(['duplicate', 'duplicate-2']);
  });

  it('REQ-GEN-006: user UPDATE uses local_date computed in user.tz', async () => {
    const userInZurich = makeUser({ tz: 'Europe/Zurich' });
    const envZurich = makeEnv({ db, kv, ai });
    await generateDigest(envZurich, userInZurich, 'scheduled');
    const batch = db.batches[0]!;
    const userUpdate = batch.find((c) => c.sql.includes('UPDATE users'));
    expect(userUpdate).toBeDefined();
    const localDate = userUpdate!.params[0] as string;
    // YYYY-MM-DD shape.
    expect(localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Params order: local_date, id.
    expect(userUpdate!.params[1]).toBe(userInZurich.id);
  });
});

describe('generateDigest — failure modes', () => {
  let db: DbMock;
  let kv: KvMock;
  let ai: AiMock;
  let env: Env;
  let user: AuthenticatedUser;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    db = makeDb();
    kv = makeKv();
    ai = makeAi(null);
    env = makeEnv({ db, kv, ai });
    user = makeUser();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('REQ-GEN-003: zero headlines yields status=failed, error_code=all_sources_failed', async () => {
    // KV is empty — sources:{tag} missing AND all generic caches empty.
    // Install a fetch stub that returns empty arrays for every live fetch
    // so the fan-out produces zero headlines.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ hits: [] }), { status: 200 }),
      ),
    );
    const result = await generateDigest(env, user, 'scheduled');
    expect(result.status).toBe('failed');
    expect(result.error_code).toBe('all_sources_failed');
    // A failure update should have been applied (not a batch write).
    const failUpdate = db.runCalls.find(
      (c) =>
        c.sql.includes('UPDATE digests') &&
        c.sql.includes("status = 'failed'"),
    );
    expect(failUpdate).toBeDefined();
    expect(failUpdate!.params).toContain('all_sources_failed');
    // No batch should have run.
    expect(db.batches).toHaveLength(0);
  });

  it('REQ-GEN-005: unparseable LLM response yields status=failed, error_code=llm_invalid_json', async () => {
    seedHeadlines(kv);
    ai.run.mockResolvedValue({
      response: 'not valid JSON {{{',
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const result = await generateDigest(env, user, 'scheduled');
    expect(result.status).toBe('failed');
    expect(result.error_code).toBe('llm_invalid_json');
    // Failure UPDATE fired.
    const failUpdate = db.runCalls.find(
      (c) =>
        c.sql.includes('UPDATE digests') &&
        c.sql.includes("status = 'failed'"),
    );
    expect(failUpdate).toBeDefined();
    expect(failUpdate!.params).toContain('llm_invalid_json');
  });

  it('REQ-GEN-005: LLM returns JSON but articles key missing → llm_invalid_json', async () => {
    seedHeadlines(kv);
    ai.run.mockResolvedValue({
      response: JSON.stringify({ something_else: [] }),
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const result = await generateDigest(env, user, 'scheduled');
    expect(result.status).toBe('failed');
    expect(result.error_code).toBe('llm_invalid_json');
  });

  it('REQ-GEN-005: LLM returns articles but every one is malformed → llm_invalid_json', async () => {
    seedHeadlines(kv);
    ai.run.mockResolvedValue({
      response: JSON.stringify({
        articles: [{ title: '<br/>', url: '', one_liner: '', details: [] }],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const result = await generateDigest(env, user, 'scheduled');
    expect(result.status).toBe('failed');
    expect(result.error_code).toBe('llm_invalid_json');
  });

  it('REQ-GEN-005: env.AI.run throwing yields status=failed, error_code=llm_failed', async () => {
    seedHeadlines(kv);
    ai.run.mockImplementation(async () => {
      throw new Error('Workers AI backend down');
    });
    const result = await generateDigest(env, user, 'scheduled');
    expect(result.status).toBe('failed');
    expect(result.error_code).toBe('llm_failed');
  });

  it('REQ-GEN-006: db.batch throwing yields status=failed, error_code=llm_failed', async () => {
    seedHeadlines(kv);
    const headlines = [
      {
        title: 'T',
        url: 'https://e/1',
        source_name: 'hackernews' as const,
      },
    ];
    ai.run.mockResolvedValue({
      response: JSON.stringify({
        articles: [
          {
            title: headlines[0]!.title,
            url: headlines[0]!.url,
            one_liner: 'hi',
            details: ['a', 'b', 'c'],
          },
        ],
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    db.batchShouldThrow = new Error('D1_ERROR: constraint failed');
    const result = await generateDigest(env, user, 'scheduled');
    expect(result.status).toBe('failed');
    expect(result.error_code).toBe('llm_failed');
  });
});

describe('generateDigest — email delivery', () => {
  let db: DbMock;
  let kv: KvMock;
  let ai: AiMock;
  let env: Env;
  let user: AuthenticatedUser;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    db = makeDb();
    kv = makeKv();
    const headlines = seedHeadlines(kv);
    ai = makeAi(happyLLMResponse(headlines));
    env = makeEnv({ db, kv, ai });
    user = makeUser();
    fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('REQ-MAIL-001: scheduled + email_enabled=1 → email POST fires', async () => {
    await generateDigest(env, user, 'scheduled');
    expect(fetchMock).toHaveBeenCalled();
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toContain('api.resend.com/emails');
  });

  it('REQ-MAIL-001: manual trigger never emails, even with email_enabled=1', async () => {
    const existingId = '01JXXXXXXXXXXXXXXXXXXXXXXX';
    await generateDigest(env, user, 'manual', existingId);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('REQ-MAIL-001: scheduled + email_enabled=0 → no email POST', async () => {
    const silentUser = makeUser({ email_enabled: 0 });
    await generateDigest(env, silentUser, 'scheduled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('REQ-MAIL-002: email POST failure does not fail the digest', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    const result = await generateDigest(env, user, 'scheduled');
    expect(result.status).toBe('ready');
  });

  it('REQ-MAIL-002: email fetch throwing does not fail the digest', async () => {
    fetchMock.mockRejectedValue(new Error('DNS failure'));
    const result = await generateDigest(env, user, 'scheduled');
    expect(result.status).toBe('ready');
  });
});

describe('generateDigest — empty tags', () => {
  let db: DbMock;
  let kv: KvMock;
  let ai: AiMock;
  let env: Env;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    db = makeDb();
    kv = makeKv();
    ai = makeAi(null);
    env = makeEnv({ db, kv, ai });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ hits: [] }), { status: 200 }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('REQ-GEN-003: user with zero hashtags yields all_sources_failed (no fan-out work)', async () => {
    const user = makeUser({ hashtags_json: '[]' });
    const result = await generateDigest(env, user, 'scheduled');
    expect(result.status).toBe('failed');
    expect(result.error_code).toBe('all_sources_failed');
  });

  it('REQ-GEN-003: user with null hashtags_json yields all_sources_failed', async () => {
    const user = makeUser({ hashtags_json: null });
    const result = await generateDigest(env, user, 'scheduled');
    expect(result.status).toBe('failed');
    expect(result.error_code).toBe('all_sources_failed');
  });
});

describe('generateDigest — model fallback', () => {
  let db: DbMock;
  let kv: KvMock;
  let ai: AiMock;
  let env: Env;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    db = makeDb();
    kv = makeKv();
    const headlines = seedHeadlines(kv);
    ai = makeAi(happyLLMResponse(headlines));
    env = makeEnv({ db, kv, ai });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('REQ-SET-004: null model_id falls back to DEFAULT_MODEL_ID', async () => {
    const user = makeUser({ model_id: null });
    await generateDigest(env, user, 'scheduled');
    expect(ai.run).toHaveBeenCalled();
    const modelUsed = ai.run.mock.calls[0]?.[0];
    expect(modelUsed).toBe('@cf/meta/llama-3.1-8b-instruct-fp8-fast');
  });
});
