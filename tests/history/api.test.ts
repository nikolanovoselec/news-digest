// Tests for src/pages/api/history.ts — REQ-HIST-001.
//
// The handler returns a day-grouped view of the last 7 days of articles
// whose tags intersect the user's active tags, plus the scrape_runs
// that happened in the same window (aggregated per local-date).

import { describe, it, expect, vi } from 'vitest';
import { GET } from '~/pages/api/history';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';
import { signSession } from '~/lib/session-jwt';

const JWT_SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';
const APP_URL = 'https://news-digest.example.com';
const MODEL_ID = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';

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

interface ArticleRow {
  id: string;
  title: string;
  primary_source_name: string | null;
  primary_source_url: string | null;
  published_at: number;
  ingested_at: number;
  details_json: string | null;
  tags_json: string | null;
}

interface ScrapeRunRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  articles_ingested: number;
  articles_deduped: number;
  tokens_in: number;
  tokens_out: number;
  estimated_cost_usd: number;
  status: string;
}

function baseRow(tz = 'UTC', hashtags: string[] = ['ai', 'cloudflare']): UserRow {
  return {
    id: '12345',
    email: 'alice@example.com',
    gh_login: 'alice',
    tz,
    digest_hour: 8,
    digest_minute: 0,
    hashtags_json: JSON.stringify(hashtags),
    model_id: MODEL_ID,
    email_enabled: 1,
    session_version: 1,
  };
}

function fakeArticle(id: string, publishedAt: number, tags: string[]): ArticleRow {
  return {
    id,
    title: `Article ${id}`,
    primary_source_name: 'HN',
    primary_source_url: `https://news.example.com/${id}`,
    published_at: publishedAt,
    // Tests default ingested_at = published_at; individual cases
    // can override to verify the grouping split after the shift
    // from published_at to ingested_at in the history API.
    ingested_at: publishedAt,
    details_json: JSON.stringify(['details']),
    tags_json: JSON.stringify(tags),
  };
}

function fakeRun(id: string, startedAt: number): ScrapeRunRow {
  return {
    id,
    started_at: startedAt,
    finished_at: startedAt + 60,
    articles_ingested: 10,
    articles_deduped: 4,
    tokens_in: 500,
    tokens_out: 800,
    estimated_cost_usd: 0.07,
    status: 'ready',
  };
}

/**
 * D1 stub that routes SQL prefixes to canned results.
 * - auth middleware: SELECT id, email, gh_login...
 * - articles:        SELECT a.id, a.title, a.primary_source_name...
 * - scrape_runs:     SELECT id, started_at, finished_at, articles_ingested...
 */
function makeDb(
  authRow: UserRow | null,
  articles: ArticleRow[],
  runs: ScrapeRunRow[],
): { db: D1Database; bindings: { sql: string; params: unknown[] }[] } {
  const bindings: { sql: string; params: unknown[] }[] = [];
  const prepareSpy = vi.fn().mockImplementation((sql: string) => {
    const stmt = {
      _sql: sql,
      _params: [] as unknown[],
      bind(...params: unknown[]) {
        stmt._params = params;
        bindings.push({ sql, params });
        return stmt;
      },
      first: vi.fn().mockImplementation(async () => {
        if (sql.startsWith('SELECT id, email, gh_login')) return authRow;
        return null;
      }),
      all: vi.fn().mockImplementation(async () => {
        if (sql.startsWith('SELECT a.id, a.title')) {
          return { results: articles };
        }
        if (sql.startsWith('SELECT id, started_at, finished_at, articles_ingested')) {
          return { results: runs };
        }
        return { results: [] };
      }),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
    };
    return stmt;
  });
  const db = { prepare: prepareSpy } as unknown as D1Database;
  return { db, bindings };
}

function env(db: D1Database): Partial<Env> {
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
  };
}

async function authedToken(): Promise<string> {
  return signSession(
    { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
    JWT_SECRET,
  );
}

async function historyRequest(token: string | null): Promise<Request> {
  const headers = new Headers();
  if (token !== null) {
    headers.set('Cookie', `${SESSION_COOKIE_NAME}=${token}`);
  }
  return new Request(`${APP_URL}/api/history`, {
    method: 'GET',
    headers,
  });
}

describe('GET /api/history — REQ-HIST-001', () => {
  it('REQ-HIST-001: returns 401 when no session cookie is present', async () => {
    const { db } = makeDb(null, [], []);
    const req = await historyRequest(null);
    const res = await GET(makeContext(req, env(db)) as never);
    expect(res.status).toBe(401);
  });

  it('REQ-HIST-001: returns up to 7 day-groups', async () => {
    const token = await authedToken();
    // Seed articles across 10 distinct UTC dates so the handler must
    // clamp to the 7-day window (via SQL) and to 7 groups (via slice).
    const now = Math.floor(Date.now() / 1000);
    const articles: ArticleRow[] = [];
    for (let i = 0; i < 10; i += 1) {
      articles.push(fakeArticle(`a${i}`, now - i * 86_400 - 3600, ['ai']));
    }
    const { db } = makeDb(baseRow('UTC'), articles, []);
    const req = await historyRequest(token);
    const res = await GET(makeContext(req, env(db)) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: { local_date: string; article_count: number }[];
    };
    expect(body.days.length).toBeLessThanOrEqual(7);
  });

  it('REQ-HIST-001: each day-group aggregates articles + ticks + token/cost sums', async () => {
    const token = await authedToken();
    // Anchor to a stable UTC day; tz=UTC so the local date == UTC date.
    const dayStartUtc = Math.floor(Date.UTC(2026, 3, 22, 0, 0, 0) / 1000);
    const articles = [
      fakeArticle('a1', dayStartUtc + 3600, ['ai']),
      fakeArticle('a2', dayStartUtc + 7200, ['ai', 'cloudflare']),
    ];
    const runs = [
      { ...fakeRun('r1', dayStartUtc + 0), tokens_in: 100, tokens_out: 200, estimated_cost_usd: 0.05, articles_ingested: 7 },
      { ...fakeRun('r2', dayStartUtc + 3600), tokens_in: 50, tokens_out: 150, estimated_cost_usd: 0.03, articles_ingested: 3 },
    ];
    const { db } = makeDb(baseRow('UTC'), articles, runs);
    const req = await historyRequest(token);
    const res = await GET(makeContext(req, env(db)) as never);
    const body = (await res.json()) as {
      days: Array<{
        local_date: string;
        article_count: number;
        articles: unknown[];
        ticks: unknown[];
        day_tokens_in: number;
        day_tokens_out: number;
        day_cost_usd: number;
        day_articles_ingested: number;
      }>;
    };
    const group = body.days.find((d) => d.local_date === '2026-04-22');
    expect(group).toBeDefined();
    expect(group!.article_count).toBe(2);
    expect(group!.articles.length).toBe(2);
    expect(group!.ticks.length).toBe(2);
    expect(group!.day_tokens_in).toBe(150);
    expect(group!.day_tokens_out).toBe(350);
    expect(group!.day_cost_usd).toBeCloseTo(0.08, 6);
    expect(group!.day_articles_ingested).toBe(10);
  });

  it('REQ-HIST-001: scrape_runs grouped by user tz, not by UTC date', async () => {
    const token = await authedToken();
    // A tick at 2026-04-22 23:30 UTC lands on 2026-04-23 local in
    // Pacific/Auckland (UTC+12) — the handler must group it on the
    // local date, not the UTC date.
    const runAtUtc = Math.floor(Date.UTC(2026, 3, 22, 23, 30, 0) / 1000);
    const runs = [fakeRun('r1', runAtUtc)];
    const { db } = makeDb(baseRow('Pacific/Auckland'), [], runs);
    const req = await historyRequest(token);
    const res = await GET(makeContext(req, env(db)) as never);
    const body = (await res.json()) as {
      days: Array<{ local_date: string; ticks: unknown[] }>;
    };
    // Exactly one day-group, keyed to the local date (2026-04-23), not
    // the UTC date (2026-04-22).
    expect(body.days.length).toBe(1);
    expect(body.days[0]!.local_date).toBe('2026-04-23');
    expect(body.days[0]!.ticks.length).toBe(1);
  });

  it("REQ-HIST-001: articles filtered to the user's active tags", async () => {
    const token = await authedToken();
    const { db, bindings } = makeDb(baseRow('UTC', ['ai', 'cloudflare']), [], []);
    const req = await historyRequest(token);
    await GET(makeContext(req, env(db)) as never);

    const articleBind = bindings.find((b) => b.sql.startsWith('SELECT a.id, a.title'));
    expect(articleBind).toBeDefined();
    // ?1 = window cutoff, ?2..?N = tags. Both tags must be bound.
    expect(articleBind!.sql).toContain('article_tags');
    expect(articleBind!.sql).toContain('tag IN');
    const params = articleBind!.params;
    expect(params.length).toBe(3); // cutoff + 2 tags
    expect(params.slice(1)).toEqual(['ai', 'cloudflare']);
  });

  it('REQ-HIST-001: empty pool returns { days: [] }', async () => {
    const token = await authedToken();
    const { db } = makeDb(baseRow('UTC'), [], []);
    const req = await historyRequest(token);
    const res = await GET(makeContext(req, env(db)) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: unknown[] };
    expect(body.days).toEqual([]);
  });
});
