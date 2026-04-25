// Tests for src/pages/api/auth/set-tz.ts — REQ-SET-007 (timezone change
// detection update endpoint) + REQ-AUTH-003 (Origin check).

import { describe, it, expect, vi } from 'vitest';
import { POST } from '~/pages/api/auth/set-tz';
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

function baseRow(): UserRow {
  return {
    id: '12345',
    email: 'alice@example.com',
    gh_login: 'alice',
    tz: 'Europe/Zurich',
    digest_hour: 8,
    digest_minute: 0,
    hashtags_json: '["#ai"]',
    model_id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    email_enabled: 1,
    session_version: 1,
  };
}

function makeDb(row: UserRow | null): {
  db: D1Database;
  runCalls: { sql: string; params: unknown[] }[];
} {
  const runCalls: { sql: string; params: unknown[] }[] = [];
  const prepareSpy = vi.fn().mockImplementation((sql: string) => ({
    bind: (...params: unknown[]) => ({
      first: vi.fn().mockResolvedValue(sql.startsWith('SELECT') ? row : null),
      run: vi.fn().mockImplementation(async () => {
        runCalls.push({ sql, params });
        return { success: true, meta: { changes: 1 } };
      }),
    }),
  }));
  const db = { prepare: prepareSpy } as unknown as D1Database;
  return { db, runCalls };
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

async function setTzRequest(
  options: {
    origin?: string | null;
    cookie?: string | null;
    body?: unknown;
    rawBody?: string;
  } = {},
): Promise<Request> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (options.origin !== null && options.origin !== undefined) {
    headers.set('Origin', options.origin);
  }
  if (options.cookie !== null && options.cookie !== undefined) {
    headers.set('Cookie', options.cookie);
  }
  const init: RequestInit = { method: 'POST', headers };
  if (options.rawBody !== undefined) {
    init.body = options.rawBody;
  } else if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  return new Request(`${APP_URL}/api/auth/set-tz`, init);
}

describe('POST /api/auth/set-tz', () => {
  it('REQ-AUTH-003: rejects POST with missing Origin header', async () => {
    const { db } = makeDb(baseRow());
    const req = await setTzRequest({ origin: null, body: { tz: 'UTC' } });
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(403);
  });

  it('REQ-SET-007: returns 401 when not authenticated', async () => {
    const { db } = makeDb(baseRow());
    const req = await setTzRequest({
      origin: APP_ORIGIN,
      body: { tz: 'UTC' },
    });
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(401);
  });

  it('REQ-SET-007: rejects invalid tz identifier with 400', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      JWT_SECRET,
    );
    const { db } = makeDb(baseRow());
    const req = await setTzRequest({
      origin: APP_ORIGIN,
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      body: { tz: 'Mars/Olympus_Mons' },
    });
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(400);
    expect((await res.json())).toMatchObject({ code: 'invalid_tz' });
  });

  it('REQ-SET-007: rejects non-string tz with 400', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      JWT_SECRET,
    );
    const { db } = makeDb(baseRow());
    const req = await setTzRequest({
      origin: APP_ORIGIN,
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      body: { tz: 42 },
    });
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(400);
  });

  it('REQ-SET-007: rejects empty-string tz with 400', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      JWT_SECRET,
    );
    const { db } = makeDb(baseRow());
    const req = await setTzRequest({
      origin: APP_ORIGIN,
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      body: { tz: '' },
    });
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(400);
  });

  it('REQ-SET-007: rejects non-JSON body with 400', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      JWT_SECRET,
    );
    const { db } = makeDb(baseRow());
    const req = await setTzRequest({
      origin: APP_ORIGIN,
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      rawBody: 'not-json',
    });
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(400);
    expect((await res.json())).toMatchObject({ code: 'bad_request' });
  });

  it('REQ-SET-007: persists a valid IANA timezone to users.tz', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      JWT_SECRET,
    );
    const { db, runCalls } = makeDb(baseRow());
    const req = await setTzRequest({
      origin: APP_ORIGIN,
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      body: { tz: 'America/New_York' },
    });
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tz: string };
    expect(body.ok).toBe(true);
    expect(body.tz).toBe('America/New_York');
    const update = runCalls.find((c) => c.sql.startsWith('UPDATE users SET tz'));
    expect(update).toBeDefined();
    expect(update!.params[0]).toBe('America/New_York');
    expect(update!.params[1]).toBe('12345');
  });

  it('REQ-SET-007: accepts UTC alias', async () => {
    const token = await signSession(
      { sub: '12345', email: 'a@b.c', ghl: 'a', sv: 1 },
      JWT_SECRET,
    );
    const { db } = makeDb(baseRow());
    const req = await setTzRequest({
      origin: APP_ORIGIN,
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      body: { tz: 'UTC' },
    });
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(200);
  });
});

describe('REQ-SET-007 silent tz auto-correct — Base.astro', () => {
  // Static source assertions — Base.astro cannot be rendered in
  // vitest without the Astro runtime, so we verify the contract via
  // ?raw import the same way the design-system tests do.
  it('REQ-SET-007: <body> carries data-user-tz for the authenticated session user', async () => {
    const src = await import('../../src/layouts/Base.astro?raw').then((m) => m.default);
    // The attribute is present and bound to Astro.locals.user.tz with
    // an empty-string fallback so anonymous pages render a harmless
    // empty attribute rather than `undefined`.
    expect(src).toMatch(/data-user-tz=\{Astro\.locals\.user\?\.tz\s*\?\?\s*''\}/);
  });

  it('REQ-SET-007: inline module compares Intl.DateTimeFormat().resolvedOptions().timeZone to data-user-tz and POSTs when they differ', async () => {
    const src = await import('../../src/layouts/Base.astro?raw').then((m) => m.default);
    // The browser tz is read via Intl.
    expect(src).toContain("Intl.DateTimeFormat().resolvedOptions().timeZone");
    // The stored tz is read from the body data attribute.
    expect(src).toContain("dataset['userTz']");
    // A silent POST goes to /api/auth/set-tz when the two differ.
    expect(src).toContain('/api/auth/set-tz');
    expect(src).toMatch(/method:\s*['"]POST['"]/);
  });

  it('REQ-SET-007: sync runs once per session (tzAutoBound flag on documentElement) and survives View Transitions via astro:page-load', async () => {
    const src = await import('../../src/layouts/Base.astro?raw').then((m) => m.default);
    // Guard flag prevents stacking across ClientRouter navigations.
    expect(src).toContain("dataset['tzAutoBound']");
    expect(src).toMatch(/dataset\['tzAutoBound'\]\s*=\s*'1'/);
    // astro:page-load listener re-runs the sync on every
    // View-Transition-based navigation.
    expect(src).toMatch(/astro:page-load[\s\S]*?syncBrowserTz/);
  });

  it('REQ-SET-007: early-return when the browser tz equals the stored tz (no redundant POST on matching page loads)', async () => {
    const src = await import('../../src/layouts/Base.astro?raw').then((m) => m.default);
    // A matching browser-vs-stored tz bails before POST.
    expect(src).toMatch(/browser\s*===\s*stored[\s\S]{0,80}return/);
  });

  it("REQ-SET-007: AC 6 — silent path fires only when stored tz is the empty seeded sentinel", async () => {
    const src = await import('../../src/layouts/Base.astro?raw').then((m) => m.default);
    // Any non-empty stored tz (manual save, including a deliberate
    // 'UTC' pick, or an earlier silent correction) is authoritative
    // and must not be overwritten. New users are seeded with tz=''
    // so the silent path can populate the browser-detected zone once.
    // Regression guard against the prior `stored === 'UTC'` gate which
    // overwrote users who genuinely wanted UTC.
    expect(src).toMatch(/stored\s*!==\s*['"]['"][\s\S]{0,80}return/);
  });

  it('REQ-SET-007: on successful POST, updates data-user-tz in place so the next page load skips the POST', async () => {
    const src = await import('../../src/layouts/Base.astro?raw').then((m) => m.default);
    // After res.ok, the dataset attribute is patched to the new tz.
    expect(src).toMatch(/res\.ok[\s\S]{0,120}dataset\['userTz'\]\s*=\s*browser/);
  });
});
