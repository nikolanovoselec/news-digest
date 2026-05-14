// Tests for /api/admin/dedup-diag — REQ-PIPE-003 diagnostic surface.
//
// Coverage:
//   - missing query params -> 400
//   - both ids same -> 400
//   - article(s) not in D1 -> 404
//   - vector(s) not in Vectorize -> 404
//   - happy path -> cosine + same_etld1 + above_threshold
//   - same-vendor pair (cloud.google.com vs news.google.com) -> same_etld1 true

import { describe, it, expect, vi } from 'vitest';
import { GET } from '~/pages/api/admin/dedup-diag';
import { signSession } from '~/lib/session-jwt';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';

const APP_URL = 'https://test.example.com';
const SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_ID = 'admin-user-id';

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
  title: string;
  primary_source_url: string;
  embedding_status: string | null;
}

interface DbFixture {
  articles: Record<string, ArticleRow>;
}

function makeDb(fixture: DbFixture): D1Database {
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const bound: unknown[] = [];
    const ops = {
      first: vi.fn().mockImplementation(async () => {
        if (sql.includes('FROM users')) return ADMIN_USER_ROW;
        if (sql.includes('FROM articles WHERE id')) {
          const id = bound[0] as string;
          return fixture.articles[id] ?? null;
        }
        return null;
      }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
    };
    const stmt = {
      ...ops,
      bind: (...params: unknown[]) => {
        bound.push(...params);
        return ops;
      },
    };
    return stmt as unknown as D1PreparedStatement;
  });
  return { prepare, batch: vi.fn() } as unknown as D1Database;
}

function makeVectorize(
  vectors: Record<string, number[] | undefined>,
): Vectorize {
  return {
    getByIds: vi.fn().mockImplementation(async (ids: string[]) => {
      return ids
        .filter((id) => vectors[id] !== undefined)
        .map((id) => ({
          id,
          values: vectors[id]!,
          metadata: {},
        }));
    }),
    upsert: vi.fn(),
    query: vi.fn(),
    queryById: vi.fn(),
    deleteByIds: vi.fn(),
  } as unknown as Vectorize;
}

async function adminCookieJwt(): Promise<string> {
  return signSession(
    { sub: ADMIN_ID, email: ADMIN_EMAIL, ghl: 'admin', sv: 1 },
    SECRET,
  );
}

interface CallOpts {
  a?: string | null;
  b?: string | null;
  fixture: DbFixture;
  vectors: Record<string, number[] | undefined>;
  threshold?: string;
  sameVendorPenalty?: string;
}

async function callGet(opts: CallOpts): Promise<Response> {
  const db = makeDb(opts.fixture);
  const vectorize = makeVectorize(opts.vectors);
  const cookie = await adminCookieJwt();
  const params = new URLSearchParams();
  if (opts.a !== null && opts.a !== undefined) params.set('a', opts.a);
  if (opts.b !== null && opts.b !== undefined) params.set('b', opts.b);
  const url = `${APP_URL}/api/admin/dedup-diag?${params.toString()}`;
  const req = new Request(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
    },
  });
  const env = {
    DB: db,
    VECTORIZE: vectorize,
    OAUTH_JWT_SECRET: SECRET,
    ADMIN_EMAIL,
    APP_URL,
    DEDUP_COSINE_THRESHOLD: opts.threshold,
    DEDUP_SAME_VENDOR_PENALTY: opts.sameVendorPenalty,
  } as unknown as Env;
  const context = {
    request: req,
    locals: { runtime: { env } },
    url: new URL(url),
    params: {},
  } as never;
  return GET(context);
}

const ONE_VEC: number[] = Array.from({ length: 8 }, () => 1 / Math.sqrt(8));
const TILTED_VEC: number[] = (() => {
  const v = Array.from({ length: 8 }, (_, i) => (i === 0 ? 0.95 : 0.05));
  const mag = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
  return v.map((x) => x / mag);
})();

describe('GET /api/admin/dedup-diag — REQ-PIPE-003 / REQ-PIPE-014 (pair similarity diagnostic)', () => {
  it('400 when a or b is missing', async () => {
    const res = await callGet({
      a: null,
      b: 'bbb',
      fixture: { articles: {} },
      vectors: {},
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('missing_a_or_b');
  });

  it('400 when a and b are identical', async () => {
    const res = await callGet({
      a: 'same',
      b: 'same',
      fixture: { articles: {} },
      vectors: {},
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('identical_ids');
  });

  it('404 when an article is missing from D1', async () => {
    const res = await callGet({
      a: 'aaa',
      b: 'bbb',
      fixture: {
        articles: {
          aaa: {
            id: 'aaa',
            title: 'A',
            primary_source_url: 'https://example.com/a',
            embedding_status: 'embedded',
          },
        },
      },
      vectors: { aaa: ONE_VEC, bbb: ONE_VEC },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('article_not_found');
  });

  it('404 when a vector is missing from Vectorize', async () => {
    const res = await callGet({
      a: 'aaa',
      b: 'bbb',
      fixture: {
        articles: {
          aaa: {
            id: 'aaa',
            title: 'A',
            primary_source_url: 'https://example.com/a',
            embedding_status: 'embedded',
          },
          bbb: {
            id: 'bbb',
            title: 'B',
            primary_source_url: 'https://example.org/b',
            embedding_status: 'embedded',
          },
        },
      },
      vectors: { aaa: ONE_VEC },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('vector_not_found');
  });

  it('200 happy path — same eTLD+1, cosine 1.0, above threshold even after penalty', async () => {
    const res = await callGet({
      a: 'aaa',
      b: 'bbb',
      fixture: {
        articles: {
          aaa: {
            id: 'aaa',
            title: 'WorkOS MCP server tutorial',
            primary_source_url: 'https://workos.com/blog/build-mcp',
            embedding_status: 'embedded',
          },
          bbb: {
            id: 'bbb',
            title: 'WorkOS MCP authentication providers',
            primary_source_url: 'https://blog.workos.com/auth-providers',
            embedding_status: 'embedded',
          },
        },
      },
      vectors: { aaa: ONE_VEC, bbb: ONE_VEC },
      threshold: '0.85',
      sameVendorPenalty: '0.05',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      cosine: number;
      same_etld1: boolean;
      adjusted_score: number;
      same_vendor_penalty: number;
      threshold: number;
      above_threshold: boolean;
      a: { etld1: string };
      b: { etld1: string };
    };
    expect(body.ok).toBe(true);
    expect(body.cosine).toBeCloseTo(1, 5);
    expect(body.same_etld1).toBe(true);
    expect(body.a.etld1).toBe('workos.com');
    expect(body.b.etld1).toBe('workos.com');
    expect(body.threshold).toBeCloseTo(0.85, 5);
    expect(body.same_vendor_penalty).toBeCloseTo(0.05, 5);
    expect(body.adjusted_score).toBeCloseTo(0.95, 5);
    expect(body.above_threshold).toBe(true);
  });

  it('200 same-vendor pair below adjusted threshold reports above_threshold=false', async () => {
    // Construct a TILTED vector pair whose raw cosine is in
    // (0.85, 0.85+penalty) so penalty pushes it below threshold.
    // Use unit vectors aligned along axis 0 with small lateral
    // shift so cosine is ~0.86.
    const cosineAtAngle = (theta: number): number[] => {
      const v = [Math.cos(theta), Math.sin(theta)];
      // Pad to 8-dim by appending zeros so length matches ONE_VEC.
      return [...v, 0, 0, 0, 0, 0, 0];
    };
    const vecA = [1, 0, 0, 0, 0, 0, 0, 0];
    const vecB = cosineAtAngle(Math.acos(0.86));
    const res = await callGet({
      a: 'aaa',
      b: 'bbb',
      fixture: {
        articles: {
          aaa: {
            id: 'aaa',
            title: 'WorkOS A',
            primary_source_url: 'https://workos.com/x',
            embedding_status: 'embedded',
          },
          bbb: {
            id: 'bbb',
            title: 'WorkOS B',
            primary_source_url: 'https://blog.workos.com/y',
            embedding_status: 'embedded',
          },
        },
      },
      vectors: { aaa: vecA, bbb: vecB },
      threshold: '0.85',
      sameVendorPenalty: '0.05',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cosine: number;
      same_etld1: boolean;
      adjusted_score: number;
      above_threshold: boolean;
    };
    expect(body.same_etld1).toBe(true);
    expect(body.cosine).toBeCloseTo(0.86, 2);
    expect(body.adjusted_score).toBeCloseTo(0.81, 2);
    expect(body.above_threshold).toBe(false);
  });

  it('200 different vendors — same_etld1 false, no penalty applied (cosine == adjusted_score)', async () => {
    const res = await callGet({
      a: 'aaa',
      b: 'bbb',
      fixture: {
        articles: {
          aaa: {
            id: 'aaa',
            title: 'CrowdStrike Gartner',
            primary_source_url: 'https://crowdstrike.com/blog/x',
            embedding_status: 'embedded',
          },
          bbb: {
            id: 'bbb',
            title: 'Google Cloud Gartner',
            primary_source_url: 'https://cloud.google.com/blog/y',
            embedding_status: 'embedded',
          },
        },
      },
      vectors: { aaa: ONE_VEC, bbb: TILTED_VEC },
      threshold: '0.85',
      sameVendorPenalty: '0.05',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cosine: number;
      same_etld1: boolean;
      adjusted_score: number;
      a: { etld1: string };
      b: { etld1: string };
    };
    expect(body.same_etld1).toBe(false);
    expect(body.a.etld1).toBe('crowdstrike.com');
    expect(body.b.etld1).toBe('google.com');
    // ONE_VEC and TILTED_VEC differ; cosine should be < 1
    expect(body.cosine).toBeLessThan(1);
    expect(body.cosine).toBeGreaterThan(0);
    // Penalty does NOT apply when same_etld1 is false.
    expect(body.adjusted_score).toBeCloseTo(body.cosine, 6);
  });
});
