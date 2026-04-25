// Tests for REQ-HIST-002 — user stats widget and its data contract.
//
// After the global-feed rework the /api/stats tiles split by ownership:
//
//   - digests_generated, tokens_consumed, cost_usd are GLOBAL metrics
//     derived from `scrape_runs` (the hourly pipeline runs once for
//     every user, so the totals are the same for everyone).
//   - articles_total is user-scoped via an `article_tags` JOIN so each
//     user sees the count of articles whose tags intersect their tag
//     set.
//   - articles_read is scoped to the SAME active-tag pool as
//     articles_total — reads on articles whose only tag has since been
//     deselected drop out of both numerator and denominator (the XX of
//     YY ratio always describes the visible pool).
//
// The widget-side format helpers are unchanged (still a verbatim copy
// of the helpers inside StatsWidget.astro) — a drift there surfaces as
// a visual regression first.

import { describe, it, expect, vi } from 'vitest';
import { GET } from '~/pages/api/stats';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';
import { signSession } from '~/lib/session-jwt';

const JWT_SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';
const APP_URL = 'https://news-digest.example.com';

interface UserRow {
  id: string;
  email: string;
  gh_login: string;
  tz: string;
  digest_hour: number | null;
  digest_minute: number;
  hashtags_json: string | null;
  model_id: string | null;
  email_enabled: number;
  session_version: number;
}

function baseUser(hashtags: string[] = ['ai', 'cloudflare']): UserRow {
  return {
    id: 'user-1',
    email: 'a@b.c',
    gh_login: 'alice',
    tz: 'UTC',
    digest_hour: 8,
    digest_minute: 0,
    hashtags_json: JSON.stringify(hashtags),
    model_id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    email_enabled: 1,
    session_version: 1,
  };
}

// --- Widget-side format helpers (copied verbatim from StatsWidget.astro) ---

function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Math.max(0, Math.round(n)).toLocaleString('en-US');
}

function formatCostUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0.00';
  const precise = Math.abs(value).toPrecision(value < 0.01 ? 2 : 3);
  const asNum = Number(precise);
  const fixed = asNum < 0.01 ? asNum.toFixed(4) : asNum.toFixed(2);
  return `$${fixed}`;
}

function formatReadOfTotal(read: number, total: number): string {
  return `${formatInt(read)} of ${formatInt(total)}`;
}

/** Mock responses for each query branch. */
interface Responses {
  digestsN?: number;
  articlesReadN?: number;
  articlesTotalN?: number;
  tokensN?: number;
  costN?: number;
}

interface Binding {
  sql: string;
  params: unknown[];
}

function makeDb(user: UserRow | null, resp: Responses = {}): {
  db: D1Database;
  bindings: Binding[];
  prepared: string[];
} {
  const bindings: Binding[] = [];
  const prepared: string[] = [];
  const prepare = vi.fn().mockImplementation((sql: string) => {
    prepared.push(sql);
    const stmt = {
      _sql: sql,
      _params: [] as unknown[],
      bind(...params: unknown[]) {
        stmt._params = params;
        bindings.push({ sql, params });
        return stmt;
      },
      first: vi.fn().mockImplementation(async () => {
        if (sql.startsWith('SELECT id, email, gh_login')) return user;
        // Route by query shape. Order matters — keep the more specific
        // substring checks first.
        if (sql.includes('FROM article_reads')) {
          return { n: resp.articlesReadN ?? 0 };
        }
        if (sql.includes('FROM articles a')) {
          return { n: resp.articlesTotalN ?? 0 };
        }
        if (sql.includes('FROM scrape_runs')) {
          if (sql.includes('COUNT(*)')) return { n: resp.digestsN ?? 0 };
          if (sql.includes('tokens_in')) return { n: resp.tokensN ?? 0 };
          if (sql.includes('estimated_cost_usd')) return { n: resp.costN ?? 0 };
        }
        return { n: 0 };
      }),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    return stmt;
  });
  const db = { prepare } as unknown as D1Database;
  return { db, bindings, prepared };
}

function makeEnv(db: D1Database): Partial<Env> {
  return {
    APP_URL,
    OAUTH_JWT_SECRET: JWT_SECRET,
    DB: db,
  };
}

function makeContext(request: Request, e: Partial<Env>): unknown {
  return {
    request,
    locals: { runtime: { env: e as Env } },
    url: new URL(request.url),
    params: {},
  };
}

async function authedRequest(): Promise<Request> {
  const token = await signSession(
    { sub: 'user-1', email: 'a@b.c', ghl: 'alice', sv: 1 },
    JWT_SECRET,
  );
  return new Request(`${APP_URL}/api/stats`, {
    method: 'GET',
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

// --- Widget-side formatting tests (unchanged — pure helpers still valid) ---

describe('StatsWidget — cost formatting (REQ-HIST-002 AC 4)', () => {
  it('REQ-HIST-002: renders $0.00 for zero cost', () => {
    expect(formatCostUsd(0)).toBe('$0.00');
  });

  it('REQ-HIST-002: renders $0.14 for 14 cents (3 sig figs collapse to 2dp)', () => {
    expect(formatCostUsd(0.14)).toBe('$0.14');
  });

  it('REQ-HIST-002: renders $2.37 for $2.37', () => {
    expect(formatCostUsd(2.37)).toBe('$2.37');
  });

  it('REQ-HIST-002: carries at least 4 sig figs for tiny sub-cent amounts', () => {
    expect(formatCostUsd(0.003)).toBe('$0.0030');
  });

  it('REQ-HIST-002: collapses to 2 decimal places for dollar-scale amounts', () => {
    expect(formatCostUsd(42.1)).toBe('$42.10');
    expect(formatCostUsd(1.234)).toBe('$1.23');
  });

  it('REQ-HIST-002: renders em-dash for null/undefined/NaN (graceful AC 5 fallback)', () => {
    expect(formatCostUsd(null)).toBe('—');
    expect(formatCostUsd(undefined)).toBe('—');
    expect(formatCostUsd(Number.NaN)).toBe('—');
  });

  it('REQ-HIST-002: rounds tiny negatives through the absolute-value path', () => {
    expect(formatCostUsd(-0.05)).toBe('$0.05');
  });
});

describe('StatsWidget — token count formatting (REQ-HIST-002 AC 1)', () => {
  it('REQ-HIST-002: comma-groups thousands', () => {
    expect(formatInt(1_234_567)).toBe('1,234,567');
  });

  it('REQ-HIST-002: renders 0 for zero tokens', () => {
    expect(formatInt(0)).toBe('0');
  });

  it('REQ-HIST-002: renders em-dash for null or non-finite tokens', () => {
    expect(formatInt(null)).toBe('—');
    expect(formatInt(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatInt(Number.NaN)).toBe('—');
  });

  it('REQ-HIST-002: clamps negative counts to 0 rather than leaking sign', () => {
    expect(formatInt(-5)).toBe('0');
  });
});

describe('StatsWidget — read-of-total formatting (REQ-HIST-002 AC 3)', () => {
  it('REQ-HIST-002: renders "{read} of {total}" with comma groups', () => {
    expect(formatReadOfTotal(12, 30)).toBe('12 of 30');
    expect(formatReadOfTotal(1_200, 3_000)).toBe('1,200 of 3,000');
  });

  it('REQ-HIST-002: handles zero-state cleanly', () => {
    expect(formatReadOfTotal(0, 0)).toBe('0 of 0');
  });

  it('REQ-HIST-002: read cannot exceed total in the UI format (displayed verbatim)', () => {
    expect(formatReadOfTotal(5, 3)).toBe('5 of 3');
  });
});

// --- API-side SQL contract tests (converted from it.todo placeholders) ---

describe('GET /api/stats — SQL contract (REQ-HIST-002 AC 2)', () => {
  it('REQ-HIST-002: digests_generated = COUNT(*) FROM scrape_runs WHERE status=ready (global)', async () => {
    const { db, prepared } = makeDb(baseUser(), { digestsN: 14 });
    const req = await authedRequest();
    const res = await GET(makeContext(req, makeEnv(db)) as never);
    expect(res.status).toBe(200);

    const digestSql = prepared.find(
      (s) =>
        s.includes('COUNT(*)') &&
        s.includes('FROM scrape_runs') &&
        s.includes("status = 'ready'"),
    );
    expect(digestSql).toBeDefined();

    const body = (await res.json()) as { digests_generated: number };
    expect(body.digests_generated).toBe(14);
  });

  it('REQ-HIST-002: tokens_consumed = SUM(tokens_in + tokens_out) FROM scrape_runs (global)', async () => {
    const { db, prepared } = makeDb(baseUser(), { tokensN: 125_000 });
    const req = await authedRequest();
    const res = await GET(makeContext(req, makeEnv(db)) as never);

    const tokensSql = prepared.find(
      (s) =>
        s.includes('SUM(') &&
        s.includes('tokens_in') &&
        s.includes('tokens_out') &&
        s.includes('FROM scrape_runs'),
    );
    expect(tokensSql).toBeDefined();

    const body = (await res.json()) as { tokens_consumed: number };
    expect(body.tokens_consumed).toBe(125_000);
  });

  it('REQ-HIST-002: cost_usd = SUM(estimated_cost_usd) FROM scrape_runs (global)', async () => {
    const { db, prepared } = makeDb(baseUser(), { costN: 0.42 });
    const req = await authedRequest();
    const res = await GET(makeContext(req, makeEnv(db)) as never);

    const costSql = prepared.find(
      (s) =>
        s.includes('SUM(estimated_cost_usd)') && s.includes('FROM scrape_runs'),
    );
    expect(costSql).toBeDefined();

    const body = (await res.json()) as { cost_usd: number };
    expect(body.cost_usd).toBe(0.42);
  });

  it('REQ-HIST-002: articles_total filtered by user tags via article_tags JOIN', async () => {
    const { db, bindings, prepared } = makeDb(
      baseUser(['ai', 'cloudflare']),
      { articlesTotalN: 140 },
    );
    const req = await authedRequest();
    const res = await GET(makeContext(req, makeEnv(db)) as never);

    const articlesTotalSql = prepared.find(
      (s) => s.includes('FROM articles a') && s.includes('article_tags'),
    );
    expect(articlesTotalSql).toBeDefined();
    expect(articlesTotalSql!).toContain('COUNT(DISTINCT');
    expect(articlesTotalSql!).toContain('tag IN');

    // Tags are bound as positional parameters, never string-interpolated.
    const articlesBind = bindings.find(
      (b) => b.sql.includes('FROM articles a') && b.sql.includes('article_tags'),
    );
    expect(articlesBind).toBeDefined();
    expect(articlesBind!.params).toEqual(['ai', 'cloudflare']);

    const body = (await res.json()) as { articles_total: number };
    expect(body.articles_total).toBe(140);
  });

  it('REQ-HIST-002: articles_read counts reads scoped to the active-tag pool, with the user_id bound first and the user tags bound after', async () => {
    const { db, bindings, prepared } = makeDb(baseUser(), { articlesReadN: 38 });
    const req = await authedRequest();
    const res = await GET(makeContext(req, makeEnv(db)) as never);

    // The reads SQL must filter by user_id AND restrict article_id to the
    // active-tag pool — same denominator as articles_total. Without the
    // article_tags join the XX-of-YY ratio drifts as the user changes
    // their tag selection.
    const readsSql = prepared.find(
      (s) =>
        s.includes('FROM article_reads') &&
        s.includes('user_id') &&
        s.includes('article_tags'),
    );
    expect(readsSql).toBeDefined();
    expect(readsSql!).toContain('COUNT(*)');

    const readsBind = bindings.find((b) => b.sql.includes('FROM article_reads'));
    expect(readsBind).toBeDefined();
    // Bind order: ?1 = session user_id, ?2..?N+1 = the user's tag list.
    expect(readsBind!.params[0]).toBe('user-1');
    expect(readsBind!.params.slice(1)).toEqual(['ai', 'cloudflare']);

    const body = (await res.json()) as { articles_read: number };
    expect(body.articles_read).toBe(38);
  });

  it('REQ-HIST-002: articles_read short-circuits to 0 when the user has no hashtags (no empty-IN-clause query)', async () => {
    // Mirrors the articles_total empty-tag-list short-circuit: SQLite
    // rejects an empty IN clause, so the handler must return 0 without
    // even preparing the read query in that case.
    const { db, bindings } = makeDb(baseUser([]), { articlesReadN: 38 });
    const req = await authedRequest();
    const res = await GET(makeContext(req, makeEnv(db)) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { articles_read: number };
    expect(body.articles_read).toBe(0);
    // No bind() against article_reads should have happened.
    const readsBind = bindings.find((b) => b.sql.includes('FROM article_reads'));
    expect(readsBind).toBeUndefined();
  });

  it('REQ-HIST-002: handler returns 401 when no session cookie is present', async () => {
    const { db } = makeDb(null);
    const req = new Request(`${APP_URL}/api/stats`, { method: 'GET' });
    const res = await GET(makeContext(req, makeEnv(db)) as never);
    expect(res.status).toBe(401);
  });

  it('REQ-HIST-002: response shape includes digests_generated, articles_read, articles_total, tokens_consumed, cost_usd', async () => {
    const { db } = makeDb(baseUser(), {
      digestsN: 14,
      articlesReadN: 38,
      articlesTotalN: 140,
      tokensN: 125_000,
      costN: 0.42,
    });
    const req = await authedRequest();
    const res = await GET(makeContext(req, makeEnv(db)) as never);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, number>;
    expect(body).toHaveProperty('digests_generated', 14);
    expect(body).toHaveProperty('articles_read', 38);
    expect(body).toHaveProperty('articles_total', 140);
    expect(body).toHaveProperty('tokens_consumed', 125_000);
    expect(body).toHaveProperty('cost_usd', 0.42);
  });

  it('REQ-HIST-002: zero rows → zero tiles, not null', async () => {
    const { db } = makeDb(baseUser()); // all defaults to 0
    const req = await authedRequest();
    const res = await GET(makeContext(req, makeEnv(db)) as never);
    const body = (await res.json()) as Record<string, number>;
    expect(body.digests_generated).toBe(0);
    expect(body.articles_read).toBe(0);
    expect(body.articles_total).toBe(0);
    expect(body.tokens_consumed).toBe(0);
    expect(body.cost_usd).toBe(0);
  });
});
