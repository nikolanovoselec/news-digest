// Tests for src/pages/api/articles/[id]/star.ts — REQ-STAR-001.
//
// Contract:
//   POST /api/articles/:id/star inserts into article_stars (user_id,
//   article_id, starred_at) and is idempotent via the (user_id,
//   article_id) primary key.
//   DELETE /api/articles/:id/star removes the row idempotently.
//   Both verbs require:
//     - matching Origin header (REQ-AUTH-003) — 403 otherwise
//     - an authenticated session — 401 otherwise
//     - the article id bound parameter matches the path parameter so
//       stars are user-scoped (user A's POST never surfaces in user B's
//       DB rows under user B's id)

import { describe, it, expect, vi } from 'vitest';
import { POST, DELETE } from '~/pages/api/articles/[id]/star';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';
import { signSession } from '~/lib/session-jwt';

const JWT_SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';
const APP_URL = 'https://news-digest.example.com';
const APP_ORIGIN = 'https://news-digest.example.com';

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

function userRow(overrides: Partial<UserRow> = {}): UserRow {
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

/** In-memory D1 mock backed by a Map keyed by `${user_id}:${article_id}`.
 *  Captures each run() call so tests can inspect bound parameters and
 *  assert user-scoping of writes. */
function makeDb(user: UserRow | null): {
  db: D1Database;
  stars: Map<string, { user_id: string; article_id: string; starred_at: number }>;
  runCalls: { sql: string; params: unknown[] }[];
} {
  const stars = new Map<
    string,
    { user_id: string; article_id: string; starred_at: number }
  >();
  const runCalls: { sql: string; params: unknown[] }[] = [];
  const prepare = vi.fn().mockImplementation((sql: string) => {
    return {
      bind: (...params: unknown[]) => ({
        first: vi.fn().mockImplementation(async () => {
          if (sql.startsWith('SELECT id, email, gh_login')) return user;
          return null;
        }),
        run: vi.fn().mockImplementation(async () => {
          runCalls.push({ sql, params });
          if (sql.startsWith('INSERT OR IGNORE INTO article_stars')) {
            const [uid, aid, at] = params as [string, string, number];
            const key = `${uid}:${aid}`;
            if (!stars.has(key)) {
              stars.set(key, { user_id: uid, article_id: aid, starred_at: at });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.startsWith('DELETE FROM article_stars')) {
            const [uid, aid] = params as [string, string];
            const key = `${uid}:${aid}`;
            const existed = stars.delete(key);
            return { success: true, meta: { changes: existed ? 1 : 0 } };
          }
          return { success: true, meta: { changes: 0 } };
        }),
        all: vi.fn().mockResolvedValue({ success: true, results: [] }),
      }),
    };
  });
  const db = { prepare } as unknown as D1Database;
  return { db, stars, runCalls };
}

function makeEnv(db: D1Database): Partial<Env> {
  // Minimal in-memory KV for the rate-limit helper. Real values are
  // never asserted against in this file — the helper only needs `get`
  // and `put` to succeed.
  const kvStore = new Map<string, string>();
  const kv = {
    get: vi.fn().mockImplementation(async (key: string) => kvStore.get(key) ?? null),
    put: vi
      .fn()
      .mockImplementation(async (key: string, value: string) => {
        kvStore.set(key, value);
      }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      kvStore.delete(key);
    }),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
  } as unknown as KVNamespace;
  return {
    APP_URL,
    OAUTH_JWT_SECRET: JWT_SECRET,
    DB: db,
    KV: kv,
  };
}

function makeContext(
  request: Request,
  e: Partial<Env>,
  articleId: string,
): unknown {
  return {
    request,
    locals: { runtime: { env: e as Env } },
    url: new URL(request.url),
    params: { id: articleId },
  };
}

async function starRequest(
  method: 'POST' | 'DELETE',
  options: {
    articleId?: string;
    origin?: string | null;
    cookie?: string | null;
  } = {},
): Promise<Request> {
  const articleId = options.articleId ?? 'art-1';
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (options.origin !== null && options.origin !== undefined) {
    headers.set('Origin', options.origin);
  }
  if (options.cookie !== null && options.cookie !== undefined) {
    headers.set('Cookie', options.cookie);
  }
  return new Request(`${APP_URL}/api/articles/${articleId}/star`, {
    method,
    headers,
  });
}

async function sessionCookieFor(userId: string, sv = 1): Promise<string> {
  const token = await signSession(
    { sub: userId, email: `${userId}@b.c`, ghl: userId, sv },
    JWT_SECRET,
  );
  return `${SESSION_COOKIE_NAME}=${token}`;
}

describe('POST/DELETE /api/articles/:id/star — REQ-STAR-001', () => {
  it('REQ-STAR-001: POST /api/articles/:id/star inserts a row into article_stars (idempotent)', async () => {
    const { db, stars, runCalls } = makeDb(userRow());
    const cookie = await sessionCookieFor('user-1');

    // First POST — should insert.
    const req1 = await starRequest('POST', {
      articleId: 'art-42',
      origin: APP_ORIGIN,
      cookie,
    });
    const res1 = await POST(
      makeContext(req1, makeEnv(db), 'art-42') as never,
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { starred: boolean };
    expect(body1.starred).toBe(true);
    expect(stars.has('user-1:art-42')).toBe(true);

    // Second POST — idempotent, still 200, still one row.
    const req2 = await starRequest('POST', {
      articleId: 'art-42',
      origin: APP_ORIGIN,
      cookie,
    });
    const res2 = await POST(
      makeContext(req2, makeEnv(db), 'art-42') as never,
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { starred: boolean };
    expect(body2.starred).toBe(true);
    expect(stars.size).toBe(1);

    // Both calls hit the INSERT OR IGNORE path — verifies the SQL is
    // the idempotent upsert, not a plain INSERT that would error on
    // duplicate primary key.
    const inserts = runCalls.filter((c) =>
      c.sql.startsWith('INSERT OR IGNORE INTO article_stars'),
    );
    expect(inserts).toHaveLength(2);
  });

  it('REQ-STAR-001: DELETE removes the star idempotently (no error when already absent)', async () => {
    const { db, stars } = makeDb(userRow());
    const cookie = await sessionCookieFor('user-1');

    // Seed a star row.
    const postReq = await starRequest('POST', {
      articleId: 'art-7',
      origin: APP_ORIGIN,
      cookie,
    });
    await POST(makeContext(postReq, makeEnv(db), 'art-7') as never);
    expect(stars.has('user-1:art-7')).toBe(true);

    // First DELETE removes it.
    const del1 = await starRequest('DELETE', {
      articleId: 'art-7',
      origin: APP_ORIGIN,
      cookie,
    });
    const res1 = await DELETE(
      makeContext(del1, makeEnv(db), 'art-7') as never,
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { starred: boolean };
    expect(body1.starred).toBe(false);
    expect(stars.has('user-1:art-7')).toBe(false);

    // Second DELETE is a no-op — still 200, no throw.
    const del2 = await starRequest('DELETE', {
      articleId: 'art-7',
      origin: APP_ORIGIN,
      cookie,
    });
    const res2 = await DELETE(
      makeContext(del2, makeEnv(db), 'art-7') as never,
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { starred: boolean };
    expect(body2.starred).toBe(false);
  });

  it('REQ-STAR-001: rejects state-changing requests without matching Origin header (REQ-AUTH-003)', async () => {
    const { db, stars } = makeDb(userRow());
    const cookie = await sessionCookieFor('user-1');

    // Missing Origin header → 403.
    const reqMissing = await starRequest('POST', {
      articleId: 'art-1',
      origin: null,
      cookie,
    });
    const resMissing = await POST(
      makeContext(reqMissing, makeEnv(db), 'art-1') as never,
    );
    expect(resMissing.status).toBe(403);

    // Wrong Origin header → 403.
    const reqWrong = await starRequest('POST', {
      articleId: 'art-1',
      origin: 'https://attacker.example.com',
      cookie,
    });
    const resWrong = await POST(
      makeContext(reqWrong, makeEnv(db), 'art-1') as never,
    );
    expect(resWrong.status).toBe(403);

    // DELETE is equally guarded.
    const reqDel = await starRequest('DELETE', {
      articleId: 'art-1',
      origin: 'https://attacker.example.com',
      cookie,
    });
    const resDel = await DELETE(
      makeContext(reqDel, makeEnv(db), 'art-1') as never,
    );
    expect(resDel.status).toBe(403);

    // No rows written on any of the rejected requests.
    expect(stars.size).toBe(0);
  });

  it('REQ-STAR-001: returns 401 when no session cookie is present', async () => {
    const { db, stars } = makeDb(userRow());

    const reqPost = await starRequest('POST', {
      articleId: 'art-1',
      origin: APP_ORIGIN,
      cookie: null,
    });
    const resPost = await POST(
      makeContext(reqPost, makeEnv(db), 'art-1') as never,
    );
    expect(resPost.status).toBe(401);

    const reqDel = await starRequest('DELETE', {
      articleId: 'art-1',
      origin: APP_ORIGIN,
      cookie: null,
    });
    const resDel = await DELETE(
      makeContext(reqDel, makeEnv(db), 'art-1') as never,
    );
    expect(resDel.status).toBe(401);

    expect(stars.size).toBe(0);
  });

  it('REQ-STAR-001: user-scoped — starring user A never creates a row for user B', async () => {
    // User A stars art-99. Then user B's DELETE on art-99 must not
    // remove user A's star (different user_id scope), and user B's
    // own row store remains empty.
    const userA = userRow({ id: 'user-A', email: 'a@b.c', gh_login: 'alice' });
    const userB = userRow({ id: 'user-B', email: 'b@b.c', gh_login: 'bob' });

    // Single DB; the auth middleware returns whichever user matches the
    // sub claim on the current session. We patch the first() return by
    // branching on the bound user_id.
    const stars = new Map<
      string,
      { user_id: string; article_id: string; starred_at: number }
    >();
    const runCalls: { sql: string; params: unknown[] }[] = [];
    const prepare = vi.fn().mockImplementation((sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: vi.fn().mockImplementation(async () => {
          if (sql.startsWith('SELECT id, email, gh_login')) {
            const boundId = params[0];
            if (boundId === 'user-A') return userA;
            if (boundId === 'user-B') return userB;
            return null;
          }
          return null;
        }),
        run: vi.fn().mockImplementation(async () => {
          runCalls.push({ sql, params });
          if (sql.startsWith('INSERT OR IGNORE INTO article_stars')) {
            const [uid, aid, at] = params as [string, string, number];
            const key = `${uid}:${aid}`;
            if (!stars.has(key)) {
              stars.set(key, { user_id: uid, article_id: aid, starred_at: at });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.startsWith('DELETE FROM article_stars')) {
            const [uid, aid] = params as [string, string];
            const key = `${uid}:${aid}`;
            const existed = stars.delete(key);
            return { success: true, meta: { changes: existed ? 1 : 0 } };
          }
          return { success: true, meta: { changes: 0 } };
        }),
        all: vi.fn().mockResolvedValue({ success: true, results: [] }),
      }),
    }));
    const db = { prepare } as unknown as D1Database;

    // User A stars art-99.
    const cookieA = await sessionCookieFor('user-A');
    const postA = await starRequest('POST', {
      articleId: 'art-99',
      origin: APP_ORIGIN,
      cookie: cookieA,
    });
    const resA = await POST(makeContext(postA, makeEnv(db), 'art-99') as never);
    expect(resA.status).toBe(200);
    expect(stars.has('user-A:art-99')).toBe(true);
    expect(stars.has('user-B:art-99')).toBe(false);

    // User B DELETEs art-99 — this targets user B's own star row
    // (none exists), so user A's row must still be intact.
    const cookieB = await sessionCookieFor('user-B');
    const delB = await starRequest('DELETE', {
      articleId: 'art-99',
      origin: APP_ORIGIN,
      cookie: cookieB,
    });
    const resB = await DELETE(
      makeContext(delB, makeEnv(db), 'art-99') as never,
    );
    expect(resB.status).toBe(200);
    expect(stars.has('user-A:art-99')).toBe(true);
    expect(stars.has('user-B:art-99')).toBe(false);

    // Also verify the DELETE bound user-B (not user-A) — the handler
    // must never let a user DELETE another user's star row via path
    // parameter manipulation.
    const deletes = runCalls.filter((c) =>
      c.sql.startsWith('DELETE FROM article_stars'),
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.params[0]).toBe('user-B');
    expect(deletes[0]?.params[1]).toBe('art-99');
  });

  it('REQ-AUTH-001 AC 9 / CF-028: returns 429 when the per-user star bucket is exhausted', async () => {
    // Pre-load the rate-limit window's KV counter to the rule's limit
    // so the next call observes a full bucket and short-circuits with
    // a Retry-After header.
    const { db } = makeDb(userRow());
    const env = makeEnv(db);
    const nowSec = Math.floor(Date.now() / 1000);
    const windowSec = 60;
    const windowIndex = Math.floor(nowSec / windowSec);
    await env.KV!.put(
      `ratelimit:article_star:user:user-1:${windowIndex}`,
      '60',
    );

    const cookie = await sessionCookieFor('user-1');
    const req = await starRequest('POST', {
      articleId: 'art-1',
      origin: APP_ORIGIN,
      cookie,
    });
    const res = await POST(makeContext(req, env, 'art-1') as never);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).not.toBeNull();
  });
});
