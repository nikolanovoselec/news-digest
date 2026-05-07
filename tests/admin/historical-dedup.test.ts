// Tests for /api/admin/historical-dedup — REQ-PIPE-003 AC 9.
//
// Coverage (one test per AC bullet):
//   1. empty corpus → done:true, scanned:0, merged:0
//   2. happy path → merge SQL + Vectorize.deleteByIds for matched duplicate
//   3. threshold filter — score < 0.85 is NOT merged; merged:0
//   4. newer match required — match with published_at <= self is skipped; merged:0
//   5. stale D1 row guard — match id in Vectorize but not in D1; merged:0, no delete
//   6. cursor pagination — second call with cursor skips processed rows
//   7. admin gate — no cookie → 401 or 403
//   8. Vectorize.deleteByIds failure — best-effort; merged count still reported

import { describe, it, expect, vi } from 'vitest';
import { POST } from '~/pages/api/admin/historical-dedup';
import { signSession } from '~/lib/session-jwt';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';

const APP_URL = 'https://test.example.com';
const SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_ID = 'admin-user-id';

/** Default threshold from embeddings.ts — 0.85 */
const DEFAULT_THRESHOLD = 0.85;

const ADMIN_USER_ROW = {
  id: ADMIN_ID,
  email: ADMIN_EMAIL,
  gh_login: 'admin',
  tz: 'UTC',
  digest_hour: null as number | null,
  digest_minute: 0,
  hashtags_json: null as string | null,
  model_id: null as string | null,
  email_enabled: 1,
  session_version: 1,
};

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
  /** Articles returned by the main paginated SELECT. */
  articles: ArticleRow[];
  /** Keyed by article id — controls the D1 existence guard response. */
  existenceGuardResults: Record<string, ExistenceGuardEntry | null>;
  /** Value returned by the remaining-count SELECT. */
  remainingCount: number;
  /** Captured batch() submissions. */
  batchCalls: Array<Array<{ sql: string; params: unknown[] }>>;
  /** Captured all() calls with their bound sql. */
  allCalls: Array<{ sql: string; params: unknown[] }>;
}

function makeDb(fixture: DbFixture): D1Database {
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const bound: unknown[] = [];

    const ops = {
      first: vi.fn().mockImplementation(async () => {
        // Admin user lookup
        if (sql.includes('FROM users')) return ADMIN_USER_ROW;

        // Remaining-count SELECT
        if (sql.includes('SELECT COUNT(*) AS c')) {
          return { c: fixture.remainingCount };
        }

        // Existence + rerank-data guard:
        // SELECT id, title, source_snippet FROM articles WHERE id = ?1
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
        // Main article page SELECT - only fires for the articles query.
        // SELECT shape: id, title, source_snippet, published_at,
        // primary_source_url FROM articles WHERE embedding_status =
        // 'embedded'.
        if (
          sql.includes('SELECT id, title, source_snippet, published_at') &&
          sql.includes("embedding_status = 'embedded'")
        ) {
          fixture.allCalls.push({ sql, params: [...bound] });
          return { results: fixture.articles };
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
        // Return a bound statement that carries `sql` + `params` as
        // direct properties so D1.batch() can capture them. The mock
        // batch() casts each entry to { sql, params } and reads those
        // fields; without these, captured SQL is the empty string and
        // SQL-shape assertions fail spuriously.
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
}): Vectorize {
  return {
    queryById: vi.fn().mockImplementation(async (id: string) => {
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

async function adminCookieJwt(): Promise<string> {
  return signSession(
    { sub: ADMIN_ID, email: ADMIN_EMAIL, ghl: 'admin', sv: 1 },
    SECRET,
  );
}

interface BuildContextOpts {
  articles: ArticleRow[];
  existenceGuardResults?: Record<string, ExistenceGuardEntry | null>;
  remainingCount?: number;
  queryByIdResults?: Record<string, VectorizeMatches>;
  deleteByIdsFails?: boolean;
  body?: object;
  /** Pass false to send the request without a session cookie. */
  authenticated?: boolean;
  /** AI binding for rerank tests. Defaults to a mock that always
   *  returns same_event:false so legacy tests stay exercised under
   *  the auto-merge path. */
  aiRun?: (model: string, params: Record<string, unknown>) => Promise<unknown>;
  rerankFloor?: string;
}

async function buildContextAndCall(opts: BuildContextOpts): Promise<{
  res: Response;
  fixture: DbFixture;
  vectorize: Vectorize;
  aiRun: ReturnType<typeof vi.fn> | ((model: string, params: Record<string, unknown>) => Promise<unknown>);
}> {
  const fixture: DbFixture = {
    articles: opts.articles,
    existenceGuardResults: opts.existenceGuardResults ?? {},
    remainingCount: opts.remainingCount ?? 0,
    batchCalls: [],
    allCalls: [],
  };

  const db = makeDb(fixture);
  const vectorize = makeVectorize({
    queryByIdResults: opts.queryByIdResults ?? {},
    deleteByIdsFails: opts.deleteByIdsFails ?? false,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (opts.authenticated !== false) {
    const cookie = await adminCookieJwt();
    headers['Cookie'] = `${SESSION_COOKIE_NAME}=${cookie}`;
  }

  const init: RequestInit = { method: 'POST', headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  const req = new Request(`${APP_URL}/api/admin/historical-dedup`, init);

  const aiRun =
    opts.aiRun ??
    vi.fn().mockResolvedValue({ response: '{"same_event":false}' });
  const env = {
    DB: db,
    VECTORIZE: vectorize,
    AI: { run: aiRun },
    OAUTH_JWT_SECRET: SECRET,
    ADMIN_EMAIL,
    APP_URL,
    DEDUP_RERANK_FLOOR: opts.rerankFloor,
    // DEDUP_COSINE_THRESHOLD intentionally absent — exercises the default 0.85
  } as unknown as Env;

  const context = {
    request: req,
    locals: { runtime: { env } },
    url: new URL(req.url),
    params: {},
  } as never;

  const res = await POST(context);
  return { res, fixture, vectorize, aiRun };
}

// Helper to build a VectorizeMatches object with a single match
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

describe('POST /api/admin/historical-dedup — REQ-PIPE-003', () => {
  // -----------------------------------------------------------------------
  // AC 1: Empty corpus
  // -----------------------------------------------------------------------
  it('REQ-PIPE-003: empty corpus returns done:true, scanned:0, merged:0', async () => {
    const { res } = await buildContextAndCall({ articles: [] });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      scanned: number;
      merged: number;
      remaining: number;
      done: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.scanned).toBe(0);
    expect(body.merged).toBe(0);
    expect(body.remaining).toBe(0);
    expect(body.done).toBe(true);
  });

  // -----------------------------------------------------------------------
  // AC 2: Happy path — merge SQL + Vectorize.deleteByIds called
  // -----------------------------------------------------------------------
  it('REQ-PIPE-003: happy path issues merge SQL and calls Vectorize.deleteByIds', async () => {
    const SELF_ID = 'article-older';
    const MATCH_ID = 'article-newer';
    const SELF_PUBLISHED_AT = 1_700_000_000;
    const MATCH_PUBLISHED_AT = 1_700_000_100;

    const { res, fixture, vectorize } = await buildContextAndCall({
      articles: [
        {
          id: SELF_ID,
          published_at: SELF_PUBLISHED_AT,
          primary_source_url: 'https://acme.example/self',
        },
      ],
      existenceGuardResults: {
        [MATCH_ID]: { present: 1 },
      },
      remainingCount: 0,
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: DEFAULT_THRESHOLD + 0.01,
          published_at: MATCH_PUBLISHED_AT,
        }),
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      scanned: number;
      merged: number;
      done: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.scanned).toBe(1);
    expect(body.merged).toBe(1);

    // The 6-statement merge batch must have been submitted
    expect(fixture.batchCalls.length).toBeGreaterThanOrEqual(1);
    const mergeStatements = fixture.batchCalls.flat();
    // Statement (a): INSERT ... article_sources ... FROM articles WHERE id = ?2
    const altSourceInsert = mergeStatements.find(
      (s) =>
        s.sql.includes('INSERT') &&
        s.sql.includes('article_sources') &&
        s.sql.includes('FROM articles'),
    );
    expect(altSourceInsert).toBeDefined();

    // Vectorize.deleteByIds must have been called with the merged article's id
    const deleteByIds = vectorize.deleteByIds as ReturnType<typeof vi.fn>;
    expect(deleteByIds).toHaveBeenCalled();
    const deletedIds: string[] = deleteByIds.mock.calls.flat().flat() as string[];
    expect(deletedIds).toContain(MATCH_ID);
  });

  // -----------------------------------------------------------------------
  // AC 3: Threshold filter — score below 0.85 is NOT merged
  // -----------------------------------------------------------------------
  it('REQ-PIPE-003: match with cosine 0.5 (below threshold) is not merged; merged:0', async () => {
    const SELF_ID = 'article-self';
    const MATCH_ID = 'article-low-score';

    const { res, fixture, vectorize } = await buildContextAndCall({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_000,
          primary_source_url: 'https://acme.example/self',
        },
      ],
      existenceGuardResults: {
        [MATCH_ID]: { present: 1 },
      },
      remainingCount: 0,
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.5,
          published_at: 1_700_000_100,
        }),
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: number };
    expect(body.merged).toBe(0);

    // No batch submitted — no merge SQL
    expect(fixture.batchCalls.length).toBe(0);
    // No delete call
    const deleteByIds = vectorize.deleteByIds as ReturnType<typeof vi.fn>;
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // AC 4: Newer match required — equal or older published_at is skipped
  // -----------------------------------------------------------------------
  it('REQ-PIPE-003: match with published_at <= self.published_at is skipped; merged:0', async () => {
    const SELF_ID = 'article-self';
    const MATCH_ID = 'article-same-age';
    const PUBLISHED_AT = 1_700_000_000;

    const { res, fixture, vectorize } = await buildContextAndCall({
      articles: [
        {
          id: SELF_ID,
          published_at: PUBLISHED_AT,
          primary_source_url: 'https://acme.example/self',
        },
      ],
      existenceGuardResults: {
        [MATCH_ID]: { present: 1 },
      },
      remainingCount: 0,
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.95,
          // same timestamp as self — the route requires strictly NEWER
          published_at: PUBLISHED_AT,
        }),
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: number };
    expect(body.merged).toBe(0);

    expect(fixture.batchCalls.length).toBe(0);
    const deleteByIds = vectorize.deleteByIds as ReturnType<typeof vi.fn>;
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // AC 5: Stale-D1-row guard — match in Vectorize but absent from D1
  // -----------------------------------------------------------------------
  it('REQ-PIPE-003: stale Vectorize match missing from D1 is skipped; merged:0, no delete', async () => {
    const SELF_ID = 'article-self';
    const STALE_MATCH_ID = 'article-stale';

    const { res, fixture, vectorize } = await buildContextAndCall({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_000,
          primary_source_url: 'https://acme.example/self',
        },
      ],
      // existenceGuard returns null — row was retention-deleted from D1
      existenceGuardResults: {
        [STALE_MATCH_ID]: null,
      },
      remainingCount: 0,
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: STALE_MATCH_ID,
          score: 0.95,
          published_at: 1_700_000_100,
        }),
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: number };
    expect(body.merged).toBe(0);

    expect(fixture.batchCalls.length).toBe(0);
    const deleteByIds = vectorize.deleteByIds as ReturnType<typeof vi.fn>;
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // AC 6: Cursor pagination — the SQL WHERE clause uses the cursor value
  // -----------------------------------------------------------------------
  it('REQ-PIPE-003: cursor is forwarded as the lower bound in the article SELECT', async () => {
    const CURSOR = 1_700_000_500;

    const { fixture } = await buildContextAndCall({
      articles: [],
      remainingCount: 0,
      body: { cursor: CURSOR },
    });

    // The main article SELECT must have been issued
    expect(fixture.allCalls.length).toBeGreaterThanOrEqual(1);
    const articleSelectCall = fixture.allCalls[0]!;
    // Cursor is bound as the first positional param (cursorBind = cursor ?? -1)
    expect(articleSelectCall.params[0]).toBe(CURSOR);
    // SQL shape: WHERE published_at > ?1 ORDER BY published_at ASC
    expect(articleSelectCall.sql).toContain('published_at > ?1');
    expect(articleSelectCall.sql).toContain('ORDER BY published_at ASC');
  });

  // -----------------------------------------------------------------------
  // AC 7: Admin gate — request without session cookie returns 401/403
  // -----------------------------------------------------------------------
  it('REQ-PIPE-003: request without session cookie is rejected with 401 or 403', async () => {
    const { res } = await buildContextAndCall({
      articles: [],
      authenticated: false,
    });

    expect([401, 403]).toContain(res.status);
    // Body must NOT be the normal dedup payload
    const text = await res.text();
    expect(text).not.toContain('"ok":true');
  });

  // -----------------------------------------------------------------------
  // AC 8: Vectorize.deleteByIds failure — best-effort; merged count still reported
  // -----------------------------------------------------------------------
  it('REQ-PIPE-003: Vectorize.deleteByIds failure does not suppress merged count', async () => {
    const SELF_ID = 'article-older';
    const MATCH_ID = 'article-newer';
    const SELF_PUBLISHED_AT = 1_700_000_000;
    const MATCH_PUBLISHED_AT = 1_700_000_100;

    const { res } = await buildContextAndCall({
      articles: [
        {
          id: SELF_ID,
          published_at: SELF_PUBLISHED_AT,
          primary_source_url: 'https://acme.example/self',
        },
      ],
      existenceGuardResults: {
        [MATCH_ID]: { present: 1 },
      },
      remainingCount: 0,
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: DEFAULT_THRESHOLD + 0.01,
          published_at: MATCH_PUBLISHED_AT,
        }),
      },
      deleteByIdsFails: true,
    });

    // Route should still return 200 and report the merged count
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      merged: number;
    };
    expect(body.ok).toBe(true);
    // The merge SQL was committed before the best-effort delete; merged must be 1
    expect(body.merged).toBe(1);
  });

  // Browser path — the /settings button posts a plain HTML form, so the
  // handler must 303-redirect with cumulative counts on the URL instead
  // of returning JSON. Mirrors the embed-backfill button shape.
  it('REQ-PIPE-003: browser form post redirects to /settings?dedup=done with counts', async () => {
    const SELF_ID = 'article-older';
    const MATCH_ID = 'article-newer';
    const SELF_PUBLISHED_AT = 1_700_000_000;
    const MATCH_PUBLISHED_AT = 1_700_000_100;

    // Build a request WITHOUT Accept: application/json — browser default.
    const fixture: DbFixture = {
      articles: [
        {
          id: SELF_ID,
          published_at: SELF_PUBLISHED_AT,
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
          score: DEFAULT_THRESHOLD + 0.01,
          published_at: MATCH_PUBLISHED_AT,
        }),
      },
      deleteByIdsFails: false,
    });
    const cookie = await adminCookieJwt();
    const req = new Request(`${APP_URL}/api/admin/historical-dedup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
      },
    });
    const env = {
      DB: db,
      VECTORIZE: vectorize,
      OAUTH_JWT_SECRET: SECRET,
      ADMIN_EMAIL,
      APP_URL,
    } as unknown as Env;
    const context = {
      request: req,
      locals: { runtime: { env } },
      url: new URL(req.url),
      params: {},
    } as never;

    const res = await POST(context);

    expect(res.status).toBe(303);
    const location = res.headers.get('Location') ?? '';
    expect(location).toContain('/settings?dedup=done');
    expect(location).toContain('scanned=1');
    expect(location).toContain('merged=1');
    expect(location).toContain('remaining=0');
  });

  // ---------------------------------------------------------------------
  // AC 11: Same-publisher stricter bar (cosine penalty for shared eTLD+1)
  // ---------------------------------------------------------------------
  it('REQ-PIPE-003 AC 11: same-vendor pair just above threshold falls below after penalty (no merge)', async () => {
    const SELF_ID = 'self-blog';
    const MATCH_ID = 'old-news';
    const { res, fixture, vectorize } = await buildContextAndCall({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_500,
          primary_source_url: 'https://blog.example.com/new-post',
        },
      ],
      existenceGuardResults: { [MATCH_ID]: { present: 1 } },
      remainingCount: 0,
      queryByIdResults: {
        // Raw cosine 0.87, same eTLD+1 example.com → adjusted 0.82 < 0.85
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.87,
          published_at: 1_700_001_000,
          primary_source_url: 'https://news.example.com/old-post',
        }),
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: number };
    expect(body.merged).toBe(0);
    expect(fixture.batchCalls.length).toBe(0);
    expect(vectorize.deleteByIds).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-003 AC 11: same-vendor pair well above threshold still merges after penalty', async () => {
    const SELF_ID = 'self-blog';
    const MATCH_ID = 'old-news';
    const { res, fixture, vectorize } = await buildContextAndCall({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_500,
          primary_source_url: 'https://blog.example.com/new-post',
        },
      ],
      existenceGuardResults: { [MATCH_ID]: { present: 1 } },
      remainingCount: 0,
      queryByIdResults: {
        // Raw cosine 0.95, same eTLD+1 → adjusted 0.90 still ≥ 0.85
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.95,
          published_at: 1_700_001_000,
          primary_source_url: 'https://news.example.com/old-post',
        }),
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: number };
    expect(body.merged).toBe(1);
    expect(fixture.batchCalls.length).toBeGreaterThan(0);
    const deleteByIds = vectorize.deleteByIds as ReturnType<typeof vi.fn>;
    expect(deleteByIds).toHaveBeenCalled();
  });

  it('REQ-PIPE-003 AC 11: cross-vendor pair just above threshold merges (penalty does not apply)', async () => {
    const SELF_ID = 'self-acme';
    const MATCH_ID = 'old-other';
    const { res, fixture } = await buildContextAndCall({
      articles: [
        {
          id: SELF_ID,
          published_at: 1_700_000_500,
          primary_source_url: 'https://acme.example/new',
        },
      ],
      existenceGuardResults: { [MATCH_ID]: { present: 1 } },
      remainingCount: 0,
      queryByIdResults: {
        // Raw cosine 0.87, cross-vendor → no penalty, ≥ 0.85
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.87,
          published_at: 1_700_001_000,
          primary_source_url: 'https://other-publisher.example/old',
        }),
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: number };
    expect(body.merged).toBe(1);
    expect(fixture.batchCalls.length).toBeGreaterThan(0);
  });

  it('REQ-PIPE-009: borderline cosine with LLM yes -> merges newer article', async () => {
    const SELF_ID = 'older';
    const MATCH_ID = 'newer';
    const aiRun = vi
      .fn()
      .mockResolvedValue({ response: '{"same_event":true}' });
    const { res, fixture, vectorize } = await buildContextAndCall({
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
          title: 'Romania PM Ousted in No-Confidence Vote',
          source_snippet: 'Bolojan removed after coalition collapse.',
        },
      },
      remainingCount: 0,
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.78,
          published_at: 1_700_001_000,
          primary_source_url: 'https://newsite.example/y',
        }),
      },
      aiRun,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: number };
    expect(body.merged).toBe(1);
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(fixture.batchCalls.length).toBeGreaterThan(0);
    const deleteByIds = vectorize.deleteByIds as ReturnType<typeof vi.fn>;
    expect(deleteByIds).toHaveBeenCalled();
  });

  it('REQ-PIPE-009: borderline cosine with LLM no -> stays distinct', async () => {
    const SELF_ID = 'older';
    const MATCH_ID = 'newer';
    const aiRun = vi
      .fn()
      .mockResolvedValue({ response: '{"same_event":false}' });
    const { res, fixture, vectorize } = await buildContextAndCall({
      articles: [
        {
          id: SELF_ID,
          title: 'OpenAI Releases GPT-7',
          source_snippet: 'Multimodal grounding model.',
          published_at: 1_700_000_500,
          primary_source_url: 'https://oldsite.example/x',
        },
      ],
      existenceGuardResults: {
        [MATCH_ID]: {
          present: 1,
          title: 'OpenAI Announces Sora 2',
          source_snippet: 'Improved video model.',
        },
      },
      remainingCount: 0,
      queryByIdResults: {
        [SELF_ID]: singleMatch({
          id: MATCH_ID,
          score: 0.78,
          published_at: 1_700_001_000,
          primary_source_url: 'https://newsite.example/y',
        }),
      },
      aiRun,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: number };
    expect(body.merged).toBe(0);
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(fixture.batchCalls.length).toBe(0);
    const deleteByIds = vectorize.deleteByIds as ReturnType<typeof vi.fn>;
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  it('REQ-PIPE-009 AC 5: rerank cap is per-invocation; 26th borderline pair stays distinct', async () => {
    // The cap is RERANK_BATCH_CAP=25. Build 26 articles each with one
    // newer borderline match. The 26th must NOT trigger an LLM call
    // and must NOT merge, proving the cap fires.
    const N = 26;
    const articles: ArticleRow[] = [];
    const guards: Record<string, ExistenceGuardEntry> = {};
    const queryByIdResults: Record<string, VectorizeMatches> = {};
    for (let i = 0; i < N; i++) {
      const selfId = `self-${i}`;
      const matchId = `match-${i}`;
      articles.push({
        id: selfId,
        title: `Article ${i}`,
        source_snippet: 'snippet',
        published_at: 1_700_000_000 + i,
        primary_source_url: `https://oldsite.example/${i}`,
      });
      guards[matchId] = {
        present: 1,
        title: `Other ${i}`,
        source_snippet: 'other',
      };
      queryByIdResults[selfId] = singleMatch({
        id: matchId,
        score: 0.78,
        published_at: 1_700_001_000 + i,
        primary_source_url: `https://newsite.example/${i}`,
      });
    }
    const aiRun = vi
      .fn()
      .mockResolvedValue({ response: '{"same_event":true}' });
    const { res, fixture } = await buildContextAndCall({
      articles,
      existenceGuardResults: guards,
      remainingCount: 0,
      queryByIdResults,
      aiRun,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: number };
    // Cap is 25; the 26th borderline pair never reached the merge step.
    expect(aiRun).toHaveBeenCalledTimes(25);
    expect(body.merged).toBe(25);
    expect(fixture.batchCalls.length).toBe(25);
  });

  it('REQ-PIPE-009: cosine below floor does not invoke LLM', async () => {
    const SELF_ID = 'older';
    const MATCH_ID = 'newer';
    const aiRun = vi.fn();
    const { res } = await buildContextAndCall({
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
      remainingCount: 0,
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: number };
    expect(body.merged).toBe(0);
    expect(aiRun).not.toHaveBeenCalled();
  });
});
