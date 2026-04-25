// Tests for src/pages/api/auth/[provider]/callback.ts — REQ-AUTH-001,
// REQ-AUTH-002, REQ-AUTH-004. The GitHub provider is the default
// fixture here; per-provider variants live in callback-google.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET } from '~/pages/api/auth/[provider]/callback';
import { oauthStateCookieName } from '~/pages/api/auth/[provider]/login';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';
import { verifySession } from '~/lib/session-jwt';
import { DEFAULT_HASHTAGS } from '~/lib/default-hashtags';

const GITHUB_STATE_COOKIE = oauthStateCookieName('github');

/** Collect every Set-Cookie value from a Response. Prefers the
 * `getSetCookie()` extension when the runtime exposes it. */
function setCookiesOf(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const raw = h.get('Set-Cookie');
  return raw === null ? [] : [raw];
}

const JWT_SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';
const APP_URL = 'https://news-digest.example.com';
const APP_ORIGIN = 'https://news-digest.example.com';

function fullEnv(db: D1Database): Partial<Env> {
  return {
    GITHUB_OAUTH_CLIENT_ID: 'client123',
    GITHUB_OAUTH_CLIENT_SECRET: 'secret456',
    OAUTH_JWT_SECRET: JWT_SECRET,
    APP_URL,
    DB: db,
  };
}

/**
 * Build a D1 stub whose `SELECT ... FROM users WHERE id = ?1` returns
 * {@link existingRow} (or null), and which records INSERT/UPDATE calls.
 */
function makeDb(existingRow: Record<string, unknown> | null): {
  db: D1Database;
  runCalls: { sql: string; params: unknown[] }[];
} {
  const runCalls: { sql: string; params: unknown[] }[] = [];
  const prepareSpy = vi.fn().mockImplementation((sql: string) => ({
    bind: (...params: unknown[]) => ({
      first: vi.fn().mockResolvedValue(sql.startsWith('SELECT') ? existingRow : null),
      run: vi.fn().mockImplementation(async () => {
        runCalls.push({ sql, params });
        return { success: true, meta: { changes: 1 } };
      }),
    }),
  }));
  const db = { prepare: prepareSpy } as unknown as D1Database;
  return { db, runCalls };
}

/**
 * Build a callback Request with the given query params and the
 * OAuth state cookie set to {@link cookieState}.
 */
function callbackRequest(
  queryParams: Record<string, string>,
  cookieState: string | null,
): Request {
  const url = new URL(`${APP_URL}/api/auth/github/callback`);
  for (const [k, v] of Object.entries(queryParams)) {
    url.searchParams.set(k, v);
  }
  const headers = new Headers();
  if (cookieState !== null) {
    headers.set('Cookie', `${GITHUB_STATE_COOKIE}=${cookieState}`);
  }
  return new Request(url.toString(), { method: 'GET', headers });
}

function makeContext(
  request: Request,
  env: Partial<Env>,
  provider = 'github',
): unknown {
  return {
    request,
    locals: { runtime: { env: env as Env } },
    url: new URL(request.url),
    params: { provider },
  };
}

/** Configure the global fetch mock with token-exchange and GitHub API
 * responses. Returns the vi mock function for assertion reuse. */
function mockGitHubFetch(options: {
  tokenResponse?: { ok?: boolean; body?: unknown };
  userResponse?: { ok?: boolean; body?: unknown };
  emailsResponse?: { ok?: boolean; body?: unknown };
}): ReturnType<typeof vi.fn> {
  const tokenOk = options.tokenResponse?.ok ?? true;
  const userOk = options.userResponse?.ok ?? true;
  const emailsOk = options.emailsResponse?.ok ?? true;
  const fetchMock = vi.fn().mockImplementation(async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('login/oauth/access_token')) {
      return new Response(
        JSON.stringify(options.tokenResponse?.body ?? { access_token: 'gh-access-token' }),
        { status: tokenOk ? 200 : 500 },
      );
    }
    if (u.endsWith('/user')) {
      return new Response(
        JSON.stringify(options.userResponse?.body ?? { id: 12345, login: 'alice' }),
        { status: userOk ? 200 : 500 },
      );
    }
    if (u.endsWith('/user/emails')) {
      return new Response(
        JSON.stringify(
          options.emailsResponse?.body ?? [
            { email: 'alice@example.com', primary: true, verified: true },
          ],
        ),
        { status: emailsOk ? 200 : 500 },
      );
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('GET /api/auth/github/callback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('REQ-AUTH-004: maps GitHub ?error=access_denied to /?error=access_denied', async () => {
    const { db } = makeDb(null);
    const req = callbackRequest({ error: 'access_denied' }, 'any-state');
    const res = await GET(makeContext(req, fullEnv(db)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${APP_ORIGIN}/?error=access_denied&provider=github`);
  });

  it('REQ-AUTH-004: maps unknown GitHub errors to /?error=oauth_error (no reflection)', async () => {
    const { db } = makeDb(null);
    const req = callbackRequest(
      { error: 'redirect_uri_mismatch', error_description: '<script>alert(1)</script>' },
      'any-state',
    );
    const res = await GET(makeContext(req, fullEnv(db)) as never);
    expect(res.headers.get('Location')).toBe(`${APP_ORIGIN}/?error=oauth_error&provider=github`);
    expect(res.headers.get('Location')).not.toContain('<script>');
    expect(res.headers.get('Location')).not.toContain('redirect_uri_mismatch');
  });

  it('REQ-AUTH-003/REQ-AUTH-004: rejects missing state cookie with 403 + invalid_state', async () => {
    const { db } = makeDb(null);
    const req = callbackRequest({ state: 'query-state', code: 'ghcode' }, null);
    const res = await GET(makeContext(req, fullEnv(db)) as never);
    expect(res.status).toBe(403);
    expect(res.headers.get('Location')).toContain('invalid_state');
  });

  it('REQ-AUTH-004: rejects state mismatch with 403 + invalid_state', async () => {
    const { db } = makeDb(null);
    const req = callbackRequest({ state: 'query-state', code: 'ghcode' }, 'cookie-state');
    const res = await GET(makeContext(req, fullEnv(db)) as never);
    expect(res.status).toBe(403);
    expect(res.headers.get('Location')).toContain('invalid_state');
  });

  it('REQ-AUTH-004: clears the state cookie on every completion path', async () => {
    const { db } = makeDb(null);
    const req = callbackRequest({ error: 'access_denied' }, 'abc');
    const res = await GET(makeContext(req, fullEnv(db)) as never);
    const cookies = setCookiesOf(res);
    expect(cookies.some((c) => c.startsWith(`${GITHUB_STATE_COOKIE}=`) && c.includes('Max-Age=0'))).toBe(true);
  });

  it('REQ-AUTH-001: redirects to /?error=no_verified_email when no primary+verified email', async () => {
    const { db } = makeDb(null);
    mockGitHubFetch({
      emailsResponse: {
        body: [{ email: 'a@b.c', primary: true, verified: false }],
      },
    });
    const req = callbackRequest({ state: 'match', code: 'ghcode' }, 'match');
    const res = await GET(makeContext(req, fullEnv(db)) as never);
    expect(res.headers.get('Location')).toBe(`${APP_ORIGIN}/?error=no_verified_email&provider=github`);
  });

  it('REQ-AUTH-001: upserts new user with GitHub numeric id as TEXT and issues session cookie', async () => {
    const { db, runCalls } = makeDb(null); // no existing row -> new user
    mockGitHubFetch({});
    const req = callbackRequest({ state: 'match', code: 'ghcode' }, 'match');
    const res = await GET(makeContext(req, fullEnv(db)) as never);

    expect(res.status).toBe(303);
    const insert = runCalls.find((c) => c.sql.startsWith('INSERT INTO users'));
    expect(insert).toBeDefined();
    // First param must be the numeric id coerced to TEXT.
    expect(insert!.params[0]).toBe('12345');
    expect(typeof insert!.params[0]).toBe('string');
    expect(insert!.params[1]).toBe('alice@example.com');
    expect(insert!.params[2]).toBe('alice');

    const cookies = setCookiesOf(res);
    const sessionCookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(sessionCookie).toBeDefined();
  });

  it('REQ-AUTH-001: signed JWT contains sub, email, ghl, sv=1 for new users', async () => {
    const { db } = makeDb(null);
    mockGitHubFetch({});
    const req = callbackRequest({ state: 'match', code: 'ghcode' }, 'match');
    const res = await GET(makeContext(req, fullEnv(db)) as never);
    const sessionCookie = setCookiesOf(res).find((c) =>
      c.startsWith(`${SESSION_COOKIE_NAME}=`),
    )!;
    const token = sessionCookie.match(new RegExp(`^${SESSION_COOKIE_NAME}=([^;]+);`))![1]!;
    const claims = await verifySession(token, JWT_SECRET);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('12345');
    expect(claims!.email).toBe('alice@example.com');
    expect(claims!.ghl).toBe('alice');
    expect(claims!.sv).toBe(1);
  });

  it('REQ-AUTH-001: redirects new user directly to /digest — no settings onboarding detour', async () => {
    // New accounts land with complete defaults (digest_hour=8, 20
    // seeded tags, tz auto-corrects client-side on first load), so
    // the prior /settings?first_run=1 detour is gone. The user sees
    // news immediately instead of a schedule picker.
    const { db } = makeDb(null);
    mockGitHubFetch({});
    const req = callbackRequest({ state: 'match', code: 'ghcode' }, 'match');
    const res = await GET(makeContext(req, fullEnv(db)) as never);
    expect(res.headers.get('Location')).toBe(`${APP_ORIGIN}/digest`);
  });

  it('REQ-AUTH-001: new-user INSERT sets digest_hour=8 + digest_minute=0 so the settings-gate does not trip', async () => {
    // Regression guard for the "why do I land on a schedule picker"
    // bug. The INSERT must include digest_hour=8 as a literal so
    // the next page load passes requireSettingsComplete without
    // routing to /settings.
    const { db, runCalls } = makeDb(null);
    mockGitHubFetch({});
    const req = callbackRequest({ state: 'match', code: 'ghcode' }, 'match');
    await GET(makeContext(req, fullEnv(db)) as never);
    const insert = runCalls.find((c) =>
      c.sql.startsWith('INSERT INTO users'),
    );
    expect(insert).toBeDefined();
    // digest_hour = 8, digest_minute = 0 must appear as literals
    // in the INSERT SQL — the bound params cover id/email/gh/tz/
    // created_at/hashtags_json, not schedule fields.
    expect(insert!.sql).toMatch(/digest_hour.*digest_minute/);
    expect(insert!.sql).toMatch(/\?4,\s*8,\s*0,/);
  });

  it('REQ-AUTH-001: redirects returning user (configured) to /digest', async () => {
    const { db } = makeDb({
      id: '12345',
      tz: 'Europe/Zurich',
      session_version: 3,
      digest_hour: 8,
      hashtags_json: '["#ai"]',
    });
    mockGitHubFetch({});
    const req = callbackRequest({ state: 'match', code: 'ghcode' }, 'match');
    const res = await GET(makeContext(req, fullEnv(db)) as never);
    expect(res.headers.get('Location')).toBe(`${APP_ORIGIN}/digest`);
  });

  it('REQ-AUTH-002: returning user JWT uses the row session_version (not resetting to 1)', async () => {
    const { db } = makeDb({
      id: '12345',
      tz: 'Europe/Zurich',
      session_version: 7, // previously logged out 6 times
      digest_hour: 8,
      hashtags_json: '["#ai"]',
    });
    mockGitHubFetch({});
    const req = callbackRequest({ state: 'match', code: 'ghcode' }, 'match');
    const res = await GET(makeContext(req, fullEnv(db)) as never);
    const sessionCookie = setCookiesOf(res).find((c) =>
      c.startsWith(`${SESSION_COOKIE_NAME}=`),
    )!;
    const token = sessionCookie.match(new RegExp(`^${SESSION_COOKIE_NAME}=([^;]+);`))![1]!;
    const claims = await verifySession(token, JWT_SECRET);
    expect(claims!.sv).toBe(7);
  });

  it('REQ-AUTH-004: collapses token-exchange HTTP 500 to oauth_error', async () => {
    const { db } = makeDb(null);
    mockGitHubFetch({ tokenResponse: { ok: false, body: {} } });
    const req = callbackRequest({ state: 'match', code: 'ghcode' }, 'match');
    const res = await GET(makeContext(req, fullEnv(db)) as never);
    expect(res.headers.get('Location')).toBe(`${APP_ORIGIN}/?error=oauth_error&provider=github`);
  });

  it('REQ-AUTH-004: collapses token-exchange error body to oauth_error without reflection', async () => {
    const { db } = makeDb(null);
    mockGitHubFetch({
      tokenResponse: {
        body: { error: 'bad_verification_code', error_description: '<b>ouch</b>' },
      },
    });
    const req = callbackRequest({ state: 'match', code: 'ghcode' }, 'match');
    const res = await GET(makeContext(req, fullEnv(db)) as never);
    expect(res.headers.get('Location')).toBe(`${APP_ORIGIN}/?error=oauth_error&provider=github`);
    expect(res.headers.get('Location')).not.toContain('<b>');
    expect(res.headers.get('Location')).not.toContain('bad_verification_code');
  });

  it('REQ-AUTH-001: missing authorization code returns oauth_error', async () => {
    const { db } = makeDb(null);
    const req = callbackRequest({ state: 'match' }, 'match');
    const res = await GET(makeContext(req, fullEnv(db)) as never);
    expect(res.headers.get('Location')).toContain('oauth_error');
  });

  it('REQ-AUTH-004: profile fetch failure collapses to oauth_error', async () => {
    const { db } = makeDb(null);
    mockGitHubFetch({ userResponse: { ok: false, body: {} } });
    const req = callbackRequest({ state: 'match', code: 'ghcode' }, 'match');
    const res = await GET(makeContext(req, fullEnv(db)) as never);
    expect(res.headers.get('Location')).toBe(`${APP_ORIGIN}/?error=oauth_error&provider=github`);
  });

  it('REQ-AUTH-001: returns 500 when OAuth env vars are missing', async () => {
    const { db } = makeDb(null);
    const req = callbackRequest({ state: 'match', code: 'ghcode' }, 'match');
    const res = await GET(
      makeContext(req, { APP_URL, DB: db }) as never,
    );
    expect(res.status).toBe(500);
  });

  it('REQ-AUTH-001: new account seeds hashtags_json with the 20-entry default set', async () => {
    const { db, runCalls } = makeDb(null); // no existing row -> new user
    mockGitHubFetch({});
    const req = callbackRequest({ state: 'match', code: 'ghcode' }, 'match');
    const res = await GET(makeContext(req, fullEnv(db)) as never);

    expect(res.status).toBe(303);
    const insert = runCalls.find((c) => c.sql.startsWith('INSERT INTO users'));
    expect(insert).toBeDefined();
    // The INSERT binds (userId, email, ghLogin, DEFAULT_TZ, nowSec, hashtags_json)
    // so the seeded hashtags JSON lives at params[5].
    const hashtagsJson = insert!.params[5];
    expect(typeof hashtagsJson).toBe('string');
    const parsed = JSON.parse(hashtagsJson as string) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as string[]).length).toBe(20);
    expect(parsed).toEqual([...DEFAULT_HASHTAGS]);
  });
});
