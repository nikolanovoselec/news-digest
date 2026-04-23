// Tests for src/pages/api/digest/today.ts — REQ-READ-001.
//
// Contract:
//   GET /api/digest/today (authenticated) returns
//   { articles: WireArticle[], last_scrape_run: ScrapeRunRow | null, next_scrape_at: number }.
//   articles is the 30 newest rows from the GLOBAL article pool whose
//   tag list intersects the user's hashtags, ORDER BY published_at DESC.

import { describe, it, expect, vi } from 'vitest';
import { GET } from '~/pages/api/digest/today';
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

interface RawArticle {
  id: string;
  canonical_url: string;
  primary_source_name: string | null;
  primary_source_url: string | null;
  title: string;
  details_json: string | null;
  published_at: number | null;
  ingested_at: number | null;
  /** Comma-less tag slugs that the mock DB will also use to decide
   * whether this article matches the user's filter. */
  tags: string[];
  alt_source_count?: number;
  starred?: number;
  read?: number;
}

interface ScrapeRunRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
}

function baseUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'user-1',
    email: 'a@b.c',
    gh_login: 'alice',
    tz: 'UTC',
    digest_hour: 8,
    digest_minute: 0,
    hashtags_json: JSON.stringify(['cloudflare']),
    model_id: null,
    email_enabled: 1,
    session_version: 1,
    ...overrides,
  };
}

interface MockOpts {
  user: UserRow | null;
  articles: RawArticle[];
  lastRun: ScrapeRunRow | null;
  /** Record of bound query parameters by query kind — used to verify the
   * user_id is bound on the pool query, which guarantees `starred`/
   * `read` subqueries are user-scoped (no cross-user leaks). */
  capture?: {
    poolParams?: unknown[];
  };
}

/** D1 mock that branches on SQL shape. Queries we stub:
 *  - SELECT id, email, gh_login ... FROM users ...  → user row
 *  - SELECT id, started_at, finished_at, status FROM scrape_runs ... → lastRun
 *  - SELECT a.id, a.canonical_url, ... FROM articles a ... → filtered pool
 */
function makeDb(opts: MockOpts): D1Database {
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const binds: unknown[] = [];
    // The scrape_runs lookup in today.ts calls .first() directly on
    // prepare() (no .bind() hop), so this factory mirrors both paths.
    const directFirst = vi.fn().mockImplementation(async () => {
      if (sql.startsWith('SELECT id, email, gh_login')) return opts.user;
      if (sql.includes('FROM scrape_runs')) return opts.lastRun ?? null;
      return null;
    });
    return {
      first: directFirst,
      bind: (...params: unknown[]) => {
        binds.push(...params);
        return {
          first: vi.fn().mockImplementation(async () => {
            if (sql.startsWith('SELECT id, email, gh_login')) return opts.user;
            if (sql.includes('FROM scrape_runs')) return opts.lastRun ?? null;
            return null;
          }),
          all: vi.fn().mockImplementation(async () => {
            if (sql.includes('FROM articles a')) {
              if (opts.capture) opts.capture.poolParams = [...binds];
              const userId = binds[0];
              const tagParams = binds.slice(1).filter(
                (v): v is string => typeof v === 'string',
              );
              const tagSet = new Set(tagParams);
              const matching = opts.articles.filter((a) =>
                a.tags.some((t) => tagSet.has(t)),
              );
              matching.sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0));
              const limited = matching.slice(0, 30);
              const results = limited.map((a) => ({
                id: a.id,
                canonical_url: a.canonical_url,
                primary_source_name: a.primary_source_name,
                primary_source_url: a.primary_source_url,
                title: a.title,
                details_json: a.details_json,
                published_at: a.published_at,
                ingested_at: a.ingested_at,
                tags_json: JSON.stringify(a.tags),
                alt_source_count: a.alt_source_count ?? 0,
                starred: a.starred ?? (userId === 'user-1' && a.id === 'starred-1' ? 1 : 0),
                read: a.read ?? 0,
              }));
              return { success: true, results };
            }
            return { success: true, results: [] };
          }),
          run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
        };
      },
    };
  });
  return { prepare } as unknown as D1Database;
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
  return new Request(`${APP_URL}/api/digest/today`, {
    method: 'GET',
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

function unauthedRequest(): Request {
  return new Request(`${APP_URL}/api/digest/today`, { method: 'GET' });
}

interface WireArticle {
  id: string;
  slug: string;
  title: string;
  details: string[];
  primary_source_name: string | null;
  primary_source_url: string | null;
  published_at: number | null;
  tags: string[];
  alt_source_count: number;
  starred: boolean;
  read: boolean;
}

interface WireResponse {
  articles: WireArticle[];
  last_scrape_run: ScrapeRunRow | null;
  next_scrape_at: number;
}

describe('GET /api/digest/today — REQ-READ-001', () => {
  it('REQ-READ-001: returns 401 when no session cookie is present', async () => {
    const db = makeDb({ user: null, articles: [], lastRun: null });
    const res = await GET(makeContext(unauthedRequest(), makeEnv(db)) as never);
    expect(res.status).toBe(401);
  });

  it('REQ-READ-001: returns 30 newest articles from the global pool filtered by user tags', async () => {
    const now = Math.floor(Date.now() / 1000);
    // 40 articles tagged `cloudflare`; each newer than the next by 60s.
    const articles: RawArticle[] = Array.from({ length: 40 }, (_, i) => ({
      id: `art-${String(i).padStart(3, '0')}`,
      canonical_url: `https://example.com/a/${i}`,
      primary_source_name: 'Cloudflare Blog',
      primary_source_url: `https://blog.cloudflare.com/post-${i}`,
      title: `Cloudflare post ${i}`,
      details_json: JSON.stringify([`summary ${i}`]),
      published_at: now - i * 60,
      ingested_at: now,
      tags: ['cloudflare'],
    }));
    const db = makeDb({
      user: baseUser(),
      articles,
      lastRun: {
        id: 'run-1',
        started_at: now - 300,
        finished_at: now - 200,
        status: 'ready',
      },
    });
    const res = await GET(makeContext(await authedRequest(), makeEnv(db)) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireResponse;
    expect(body.articles).toHaveLength(30);
    // Newest first — art-000 (published_at = now) must be the first row.
    expect(body.articles[0]?.id).toBe('art-000');
    expect(body.articles[29]?.id).toBe('art-029');
    for (let i = 0; i < body.articles.length - 1; i++) {
      const a = body.articles[i]!.published_at ?? 0;
      const b = body.articles[i + 1]!.published_at ?? 0;
      expect(a).toBeGreaterThanOrEqual(b);
    }
  });

  it('REQ-READ-001: returns last_scrape_run metadata and next_scrape_at on the next 4-hour UTC cron boundary', async () => {
    const now = Math.floor(Date.now() / 1000);
    const lastRun: ScrapeRunRow = {
      id: 'run-abc',
      started_at: now - 120,
      finished_at: now - 10,
      status: 'ready',
    };
    const db = makeDb({
      user: baseUser(),
      articles: [],
      lastRun,
    });
    const res = await GET(makeContext(await authedRequest(), makeEnv(db)) as never);
    const body = (await res.json()) as WireResponse;
    expect(body.last_scrape_run).not.toBeNull();
    expect(body.last_scrape_run?.id).toBe('run-abc');
    expect(body.last_scrape_run?.status).toBe('ready');
    expect(body.last_scrape_run?.started_at).toBe(lastRun.started_at);
    expect(body.next_scrape_at).not.toBeNull();
    expect(body.next_scrape_at).toBeGreaterThan(now);
    // next_scrape_at is always strictly in the future and lands on a
    // 0/4/8/12/16/20 UTC hour boundary (cron `0 */4 * * *`).
    const nextDate = new Date((body.next_scrape_at as number) * 1000);
    expect(nextDate.getUTCMinutes()).toBe(0);
    expect(nextDate.getUTCSeconds()).toBe(0);
    expect(nextDate.getUTCHours() % 4).toBe(0);
  });

  it('REQ-READ-001: excludes articles whose tags do not match any user tag (no cross-user leak via tag spoofing)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const articles: RawArticle[] = [
      {
        id: 'cf-1',
        canonical_url: 'https://blog.cloudflare.com/1',
        primary_source_name: 'Cloudflare Blog',
        primary_source_url: 'https://blog.cloudflare.com/1',
        title: 'Cloudflare post',
        details_json: JSON.stringify(['cf summary']),
        published_at: now - 60,
        ingested_at: now,
        tags: ['cloudflare'],
      },
      {
        id: 'kube-ghost-1',
        canonical_url: 'https://kubernetes.io/ghost',
        primary_source_name: 'Kubernetes Blog',
        primary_source_url: 'https://kubernetes.io/ghost',
        title: 'Kubernetes ghost article',
        details_json: JSON.stringify(['kube only']),
        published_at: now - 30, // newer than cf-1, to ensure ordering isn't the reason it's excluded
        ingested_at: now,
        tags: ['kubernetes'],
      },
    ];
    const db = makeDb({
      user: baseUser({ hashtags_json: JSON.stringify(['cloudflare']) }),
      articles,
      lastRun: null,
    });
    const res = await GET(makeContext(await authedRequest(), makeEnv(db)) as never);
    const body = (await res.json()) as WireResponse;
    const ids = body.articles.map((a) => a.id);
    expect(ids).toContain('cf-1');
    expect(ids).not.toContain('kube-ghost-1');
  });

  it('REQ-READ-001: returns empty articles + null last_scrape_run when user has zero tags', async () => {
    const db = makeDb({
      user: baseUser({ hashtags_json: JSON.stringify([]) }),
      articles: [
        {
          id: 'cf-1',
          canonical_url: 'https://blog.cloudflare.com/1',
          primary_source_name: 'Cloudflare Blog',
          primary_source_url: 'https://blog.cloudflare.com/1',
          title: 'Cloudflare post',
          details_json: JSON.stringify(['cf']),
          published_at: 100,
          ingested_at: 100,
          tags: ['cloudflare'],
        },
      ],
      lastRun: null,
    });
    const res = await GET(makeContext(await authedRequest(), makeEnv(db)) as never);
    const body = (await res.json()) as WireResponse;
    expect(body.articles).toEqual([]);
    expect(body.last_scrape_run).toBeNull();
    // next_scrape_at is derived from the cron schedule, not from
    // lastRun, so the header countdown still renders for users with no
    // tags.
    expect(body.next_scrape_at).not.toBeNull();
    const nowSec = Math.floor(Date.now() / 1000);
    expect(body.next_scrape_at).toBeGreaterThan(nowSec);
  });

  it('REQ-READ-001: emits starred + read flags from per-user join', async () => {
    const now = Math.floor(Date.now() / 1000);
    const articles: RawArticle[] = [
      {
        id: 'starred-1',
        canonical_url: 'https://example.com/s1',
        primary_source_name: 'Example',
        primary_source_url: 'https://example.com/s1',
        title: 'Starred article',
        details_json: JSON.stringify(['starred']),
        published_at: now - 30,
        ingested_at: now,
        tags: ['cloudflare'],
        starred: 1,
        read: 1,
      },
      {
        id: 'plain-1',
        canonical_url: 'https://example.com/p1',
        primary_source_name: 'Example',
        primary_source_url: 'https://example.com/p1',
        title: 'Plain article',
        details_json: JSON.stringify(['plain']),
        published_at: now - 60,
        ingested_at: now,
        tags: ['cloudflare'],
        starred: 0,
        read: 0,
      },
    ];
    const capture: MockOpts['capture'] = {};
    const db = makeDb({
      user: baseUser(),
      articles,
      lastRun: null,
      capture,
    });
    const res = await GET(makeContext(await authedRequest(), makeEnv(db)) as never);
    const body = (await res.json()) as WireResponse;
    const starred = body.articles.find((a) => a.id === 'starred-1');
    const plain = body.articles.find((a) => a.id === 'plain-1');
    expect(starred?.starred).toBe(true);
    expect(starred?.read).toBe(true);
    expect(plain?.starred).toBe(false);
    expect(plain?.read).toBe(false);
    // The user_id must be bound as the first positional parameter to
    // the pool query — that's what makes the starred / read subqueries
    // user-scoped (no cross-user leak).
    expect(capture.poolParams?.[0]).toBe('user-1');
  });
});
