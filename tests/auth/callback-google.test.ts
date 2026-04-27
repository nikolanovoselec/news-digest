// Tests for src/pages/api/auth/[provider]/callback.ts under the Google
// provider — REQ-AUTH-001 (OIDC id_token decoding, google: user-id
// prefix, verified-email gate, error redirects carry provider=google).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET } from '~/pages/api/auth/[provider]/callback';
import { oauthStateCookieName } from '~/pages/api/auth/[provider]/login';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';
import { verifySession } from '~/lib/session-jwt';

const GOOGLE_STATE_COOKIE = oauthStateCookieName('google');
const JWT_SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';
const APP_URL = 'https://news-digest.example.com';
const APP_ORIGIN = 'https://news-digest.example.com';

function setCookiesOf(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const raw = h.get('Set-Cookie');
  return raw === null ? [] : [raw];
}

function googleEnv(db: D1Database): Partial<Env> {
  return {
    GOOGLE_OAUTH_CLIENT_ID: 'google-client-789.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret-abc',
    OAUTH_JWT_SECRET: JWT_SECRET,
    APP_URL,
    DB: db,
  };
}

/** D1 stub for the OAuth callback flow. The callback now issues three
 *  SELECTs in sequence: (1) auth_links lookup by (provider, sub),
 *  (2) users lookup by email, (3) users-by-id lookup for the final
 *  user row. Each query needs its own response shape, so the stub
 *  inspects the SQL prefix instead of returning the same row everywhere.
 *
 *  - `auth_links` lookup: returns { user_id } when authLinkUserId is set
 *  - email lookup: returns { id } when userByEmailId is set
 *  - users-by-id lookup: returns existingRow when set
 *  Unmatched SELECTs return null. */
function makeDb(
  existingRow: Record<string, unknown> | null,
  options: {
    authLinkUserId?: string | null;
    userByEmailId?: string | null;
  } = {},
): {
  db: D1Database;
  runCalls: { sql: string; params: unknown[] }[];
} {
  const runCalls: { sql: string; params: unknown[] }[] = [];
  const prepareSpy = vi.fn().mockImplementation((sql: string) => ({
    bind: (...params: unknown[]) => ({
      first: vi.fn().mockImplementation(async () => {
        if (sql.includes('FROM auth_links')) {
          return options.authLinkUserId !== undefined && options.authLinkUserId !== null
            ? { user_id: options.authLinkUserId }
            : null;
        }
        if (sql.startsWith('SELECT id FROM users WHERE email')) {
          return options.userByEmailId !== undefined && options.userByEmailId !== null
            ? { id: options.userByEmailId }
            : null;
        }
        if (sql.startsWith('SELECT id, tz, session_version')) {
          return existingRow;
        }
        // Other SELECTs (e.g. session middleware lookups) — fall back
        // to the legacy shape so existing tests keep working.
        return sql.startsWith('SELECT') ? existingRow : null;
      }),
      run: vi.fn().mockImplementation(async () => {
        runCalls.push({ sql, params });
        return { success: true, meta: { changes: 1 } };
      }),
    }),
  }));
  const db = { prepare: prepareSpy } as unknown as D1Database;
  return { db, runCalls };
}

function callbackRequest(
  queryParams: Record<string, string>,
  cookieState: string | null,
): Request {
  const url = new URL(`${APP_URL}/api/auth/google/callback`);
  for (const [k, v] of Object.entries(queryParams)) {
    url.searchParams.set(k, v);
  }
  const headers = new Headers();
  if (cookieState !== null) {
    headers.set('Cookie', `${GOOGLE_STATE_COOKIE}=${cookieState}`);
  }
  return new Request(url.toString(), { method: 'GET', headers });
}

function makeContext(request: Request, env: Partial<Env>): unknown {
  return {
    request,
    locals: { runtime: { env: env as Env } },
    url: new URL(request.url),
    params: { provider: 'google' },
  };
}

/** Build a tiny unsigned JWT (header.payload.signature) for tests.
 *  The callback decodes the payload without verifying the signature
 *  (OIDC standard practice when the token is fetched directly from
 *  the issuing endpoint over TLS), so a placeholder signature is OK. */
function makeIdToken(claims: Record<string, unknown>): string {
  const b64u = (s: string): string =>
    btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify(claims));
  return `${header}.${payload}.signature-placeholder`;
}

/** Build the Google id_token claim shape the callback expects.
 *  Includes iss/aud/exp so the OIDC validation gate passes. */
function googleClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const oneHourFromNow = Math.floor(Date.now() / 1000) + 3600;
  return {
    iss: 'https://accounts.google.com',
    aud: 'google-client-789.apps.googleusercontent.com',
    exp: oneHourFromNow,
    sub: '987654321',
    email: 'alice@example.com',
    email_verified: true,
    name: 'Alice Example',
    ...overrides,
  };
}

/** Stub global fetch to return a Google token-exchange response.
 *  When `body` includes an id_token, the callback decodes it and
 *  skips the userinfo fallback. */
function mockGoogleFetch(options: {
  tokenResponse?: { ok?: boolean; body?: unknown };
  userinfoResponse?: { ok?: boolean; body?: unknown };
}): ReturnType<typeof vi.fn> {
  const tokenOk = options.tokenResponse?.ok ?? true;
  const userinfoOk = options.userinfoResponse?.ok ?? true;
  const fetchMock = vi.fn().mockImplementation(async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('oauth2.googleapis.com/token')) {
      return new Response(
        JSON.stringify(
          options.tokenResponse?.body ?? {
            access_token: 'g-access-token',
            id_token: makeIdToken(googleClaims()),
          },
        ),
        { status: tokenOk ? 200 : 500 },
      );
    }
    if (u.includes('openidconnect.googleapis.com/v1/userinfo')) {
      return new Response(
        JSON.stringify(
          options.userinfoResponse?.body ?? {
            sub: '987654321',
            email: 'alice@example.com',
            email_verified: true,
            name: 'Alice Example',
          },
        ),
        { status: userinfoOk ? 200 : 500 },
      );
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('GET /api/auth/google/callback — REQ-AUTH-001', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('REQ-AUTH-001: token-exchange uses x-www-form-urlencoded body (Google requires it)', async () => {
    const { db } = makeDb(null);
    const fetchMock = mockGoogleFetch({});
    const req = callbackRequest({ state: 'match', code: 'gcode' }, 'match');
    await GET(makeContext(req, googleEnv(db)) as never);

    const tokenCall = fetchMock.mock.calls.find((c) => {
      const url = c[0];
      const u = typeof url === 'string' ? url : (url as URL).toString();
      return u.includes('oauth2.googleapis.com/token');
    });
    expect(tokenCall).toBeDefined();
    const init = tokenCall![1] as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string> | Headers;
    const ctValue =
      headers instanceof Headers
        ? headers.get('Content-Type')
        : headers['Content-Type'];
    expect(ctValue).toContain('application/x-www-form-urlencoded');
  });

  it('REQ-AUTH-001: new Google user is keyed as google:<sub> (not bare numeric)', async () => {
    const { db, runCalls } = makeDb(null);
    mockGoogleFetch({});
    const req = callbackRequest({ state: 'match', code: 'gcode' }, 'match');
    await GET(makeContext(req, googleEnv(db)) as never);

    const insert = runCalls.find((c) => c.sql.startsWith('INSERT INTO users'));
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe('google:987654321');
    expect(insert!.params[1]).toBe('alice@example.com');
  });

  it('REQ-AUTH-001: minted JWT carries the namespaced sub and the Google display name in ghl', async () => {
    const { db } = makeDb(null);
    mockGoogleFetch({});
    const req = callbackRequest({ state: 'match', code: 'gcode' }, 'match');
    const res = await GET(makeContext(req, googleEnv(db)) as never);
    const sessionCookie = setCookiesOf(res).find((c) =>
      c.startsWith(`${SESSION_COOKIE_NAME}=`),
    );
    expect(sessionCookie).toBeDefined();
    const token = sessionCookie!.match(
      new RegExp(`^${SESSION_COOKIE_NAME}=([^;]+);`),
    )![1]!;
    const claims = await verifySession(token, JWT_SECRET);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('google:987654321');
    expect(claims!.email).toBe('alice@example.com');
    // `ghl` is reused for the provider's display name regardless of
    // provider — semantic re-use documented in the callback comment.
    expect(claims!.ghl).toBe('Alice Example');
    expect(claims!.sv).toBe(1);
  });

  it('REQ-AUTH-001: redirects to /digest after successful Google sign-in', async () => {
    const { db } = makeDb(null);
    mockGoogleFetch({});
    const req = callbackRequest({ state: 'match', code: 'gcode' }, 'match');
    const res = await GET(makeContext(req, googleEnv(db)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${APP_ORIGIN}/digest`);
  });

  it('REQ-AUTH-001: rejects unverified Google email with no_verified_email&provider=google', async () => {
    const { db } = makeDb(null);
    mockGoogleFetch({
      tokenResponse: {
        body: {
          access_token: 'g-access-token',
          id_token: makeIdToken(
            googleClaims({
              email: 'unverified@example.com',
              email_verified: false,
            }),
          ),
        },
      },
    });
    const req = callbackRequest({ state: 'match', code: 'gcode' }, 'match');
    const res = await GET(makeContext(req, googleEnv(db)) as never);
    expect(res.headers.get('Location')).toBe(
      `${APP_ORIGIN}/?error=no_verified_email&provider=google`,
    );
  });

  it('REQ-AUTH-001: id_token with mismatched aud is rejected as oauth_error (defense-in-depth)', async () => {
    const { db } = makeDb(null);
    mockGoogleFetch({
      tokenResponse: {
        body: {
          access_token: 'g-access-token',
          id_token: makeIdToken(
            googleClaims({ aud: 'someone-elses-client-id.apps.googleusercontent.com' }),
          ),
        },
      },
    });
    const req = callbackRequest({ state: 'match', code: 'gcode' }, 'match');
    const res = await GET(makeContext(req, googleEnv(db)) as never);
    expect(res.headers.get('Location')).toBe(
      `${APP_ORIGIN}/?error=oauth_error&provider=google`,
    );
  });

  it('REQ-AUTH-001: id_token with mismatched iss is rejected as oauth_error', async () => {
    const { db } = makeDb(null);
    mockGoogleFetch({
      tokenResponse: {
        body: {
          access_token: 'g-access-token',
          id_token: makeIdToken(googleClaims({ iss: 'https://evil.example.com' })),
        },
      },
    });
    const req = callbackRequest({ state: 'match', code: 'gcode' }, 'match');
    const res = await GET(makeContext(req, googleEnv(db)) as never);
    expect(res.headers.get('Location')).toBe(
      `${APP_ORIGIN}/?error=oauth_error&provider=google`,
    );
  });

  it('REQ-AUTH-001: expired id_token is rejected as oauth_error', async () => {
    const { db } = makeDb(null);
    mockGoogleFetch({
      tokenResponse: {
        body: {
          access_token: 'g-access-token',
          id_token: makeIdToken(
            googleClaims({ exp: Math.floor(Date.now() / 1000) - 60 }),
          ),
        },
      },
    });
    const req = callbackRequest({ state: 'match', code: 'gcode' }, 'match');
    const res = await GET(makeContext(req, googleEnv(db)) as never);
    expect(res.headers.get('Location')).toBe(
      `${APP_ORIGIN}/?error=oauth_error&provider=google`,
    );
  });

  it('REQ-AUTH-001: falls back to userinfo endpoint when id_token is missing', async () => {
    const { db, runCalls } = makeDb(null);
    mockGoogleFetch({
      tokenResponse: {
        body: { access_token: 'g-access-token' }, // no id_token
      },
    });
    const req = callbackRequest({ state: 'match', code: 'gcode' }, 'match');
    const res = await GET(makeContext(req, googleEnv(db)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`${APP_ORIGIN}/digest`);
    const insert = runCalls.find((c) => c.sql.startsWith('INSERT INTO users'));
    expect(insert!.params[0]).toBe('google:987654321');
  });

  it('REQ-AUTH-006: cross-provider dedup — Google sign-in with email matching a GitHub user reuses the existing account', async () => {
    // The user previously registered via GitHub; a `users` row exists
    // keyed `12345`. They now sign in via Google (sub=987654321) with
    // the same verified email. No (google, 987654321) auth_link exists
    // yet, but the email lookup matches the GitHub user — so we link
    // the new (google, 987654321) → 12345 instead of creating a fresh
    // users row.
    const { db, runCalls } = makeDb(
      { id: '12345', tz: 'UTC', session_version: 1, digest_hour: 8, hashtags_json: '[]' },
      { userByEmailId: '12345' },
    );
    mockGoogleFetch({});
    const req = callbackRequest({ state: 'match', code: 'gcode' }, 'match');
    const res = await GET(makeContext(req, googleEnv(db)) as never);
    expect(res.status).toBe(303);
    // No new users row inserted — the email match short-circuited
    // path C and we re-used the GitHub user.
    const inserts = runCalls.filter((c) => c.sql.startsWith('INSERT INTO users'));
    expect(inserts).toHaveLength(0);
    // A new auth_links row was inserted, mapping (google, 987654321) → 12345.
    const linkInsert = runCalls.find((c) => c.sql.includes('INSERT OR IGNORE INTO auth_links'));
    expect(linkInsert).toBeDefined();
    expect(linkInsert!.params).toEqual(['google', '987654321', '12345', expect.any(Number)]);
    // The session JWT subject is the existing GitHub user_id, not 'google:987654321'.
    const sessionCookie = setCookiesOf(res).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(sessionCookie).toBeDefined();
    const token = sessionCookie!.split(';')[0]!.split('=')[1]!;
    const payload = await verifySession(token, JWT_SECRET);
    expect(payload!.sub).toBe('12345');
  });

  it('REQ-AUTH-006: known auth_link short-circuits straight to the linked user_id (no email lookup, no INSERT)', async () => {
    // A subsequent Google login by an already-linked user.
    const { db, runCalls } = makeDb(
      { id: '12345', tz: 'UTC', session_version: 1, digest_hour: 8, hashtags_json: '["ai"]' },
      { authLinkUserId: '12345' },
    );
    mockGoogleFetch({});
    const req = callbackRequest({ state: 'match', code: 'gcode' }, 'match');
    const res = await GET(makeContext(req, googleEnv(db)) as never);
    expect(res.status).toBe(303);
    // No INSERT INTO users (existing row), no NEW auth_links INSERT
    // (the link already existed). Only an UPDATE users to refresh
    // email + display name.
    const userInserts = runCalls.filter((c) => c.sql.startsWith('INSERT INTO users'));
    const linkInserts = runCalls.filter((c) => c.sql.includes('INSERT OR IGNORE INTO auth_links'));
    expect(userInserts).toHaveLength(0);
    expect(linkInserts).toHaveLength(0);
  });

  it('REQ-AUTH-006: brand-new user (no link, no email match) creates users row AND auth_links row in tandem', async () => {
    // First-ever sign-in for this user via any provider.
    const { db, runCalls } = makeDb(null);
    mockGoogleFetch({});
    const req = callbackRequest({ state: 'match', code: 'gcode' }, 'match');
    const res = await GET(makeContext(req, googleEnv(db)) as never);
    expect(res.status).toBe(303);
    const userInsert = runCalls.find((c) => c.sql.startsWith('INSERT INTO users'));
    const linkInsert = runCalls.find((c) => c.sql.includes('INSERT OR IGNORE INTO auth_links'));
    expect(userInsert).toBeDefined();
    expect(linkInsert).toBeDefined();
    // Both rows reference the same user_id (the canonical google:<sub> form).
    expect(userInsert!.params[0]).toBe('google:987654321');
    expect(linkInsert!.params).toEqual(['google', '987654321', 'google:987654321', expect.any(Number)]);
  });

  it('REQ-AUTH-001: state cookie is the google-scoped one (cross-provider cookie does not satisfy the gate)', async () => {
    const { db } = makeDb(null);
    mockGoogleFetch({});
    // Setting only the github-scoped cookie should fail the google
    // callback's CSRF gate even though the value matches.
    const url = new URL(`${APP_URL}/api/auth/google/callback`);
    url.searchParams.set('state', 'match');
    url.searchParams.set('code', 'gcode');
    const req = new Request(url.toString(), {
      method: 'GET',
      headers: new Headers({
        Cookie: `${oauthStateCookieName('github')}=match`,
      }),
    });
    const res = await GET(makeContext(req, googleEnv(db)) as never);
    expect(res.status).toBe(403);
    expect(res.headers.get('Location')).toContain('invalid_state');
  });
});
