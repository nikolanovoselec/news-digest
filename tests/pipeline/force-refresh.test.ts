// Tests for /api/admin/force-refresh — REQ-OPS-005 operator-only manual
// coordinator kick. Cross-cuts: REQ-PIPE-001 (same backend work as the
// every-4-hours cron), REQ-AUTH-001 AC 8 (three-layer admin gate).
//
// Coverage:
//   - REQ-AUTH-001 AC 8 admin gate: missing session → 401, non-admin
//     email → 403, missing Cf-Access-Jwt-Assertion → 401 only when
//     CF_ACCESS_AUD is configured (CF Access is opt-in additive
//     perimeter; AD29 captures the rationale).
//   - POST rejects missing/foreign Origin (REQ-AUTH-003 CSRF defence)
//   - REQ-OPS-005 AC 1+2: POST and GET both kick startRun + SCRAPE_COORDINATOR.send.
//   - REQ-OPS-005 AC 4: POST happy path returns 303, GET with Accept JSON returns 200 JSON.
//   - REQ-OPS-005 AC 3: REUSE_WINDOW_SECONDS guard — if a status='running'
//     row exists within 120s, both paths reuse it instead of kicking
//     a second coordinator message (prevents double-click storms
//     and preview-bot refetches from multiplying LLM cost).

import { describe, it, expect, vi } from 'vitest';
import { POST, GET } from '~/pages/api/admin/force-refresh';
import { signSession } from '~/lib/session-jwt';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';

const APP_URL = 'https://news-digest.example.com';
const APP_ORIGIN = 'https://news-digest.example.com';
const ADMIN_EMAIL = 'admin@example.com';
const SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';
const ACCESS_JWT = 'header.payload.signature';

interface AdminSessionFixture {
  /** Cookie JWT for the request. Null = no cookie sent. */
  cookieJwt?: string | null;
  /** Access JWT header value. Null = header omitted entirely. */
  accessJwt?: string | null;
  /** User row returned by loadSession's user lookup. Null = row not found. */
  userRow?: {
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
  } | null;
}

const ADMIN_USER_ROW = {
  id: 'admin-user-id',
  email: ADMIN_EMAIL,
  gh_login: 'admin',
  tz: 'UTC',
  digest_hour: 8,
  digest_minute: 0,
  hashtags_json: null,
  model_id: null,
  email_enabled: 1,
  session_version: 1,
};

async function adminCookieJwt(): Promise<string> {
  return signSession(
    { sub: ADMIN_USER_ROW.id, email: ADMIN_EMAIL, ghl: 'admin', sv: 1 },
    SECRET,
  );
}

interface PreparedStmt {
  sql: string;
  params: unknown[];
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

interface DbFixture {
  /** Rows returned by the "find recent running run" query. */
  recentRun?: { id: string; started_at: number } | null;
  /** Captured call log for assertions. */
  calls: Array<{ sql: string; params: unknown[]; verb: 'first' | 'run' }>;
}

function makeDb(fixture: DbFixture, userRow: AdminSessionFixture['userRow'] = ADMIN_USER_ROW): D1Database {
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const bound: unknown[] = [];
    const stmt: PreparedStmt = {
      sql,
      params: bound,
      first: vi.fn().mockImplementation(async () => {
        fixture.calls.push({ sql, params: [...bound], verb: 'first' });
        // findRecentRunningRun SELECT — distinct from the INSERT because
        // it starts with SELECT, not INSERT.
        if (sql.trimStart().startsWith('SELECT') && sql.includes('FROM scrape_runs')) {
          return fixture.recentRun ?? null;
        }
        if (sql.includes('FROM users')) {
          return userRow ?? null;
        }
        return null;
      }),
      run: vi.fn().mockImplementation(async () => {
        fixture.calls.push({ sql, params: [...bound], verb: 'run' });
        // tryClaimDispatch — INSERT INTO scrape_runs ... WHERE NOT EXISTS.
        // Simulate D1 atomics: if a recent running row exists, the WHERE
        // NOT EXISTS predicate is false → changes === 0 (claim lost).
        // Otherwise the INSERT lands → changes === 1 (claim won).
        if (sql.trimStart().startsWith('INSERT INTO scrape_runs')) {
          const changes = fixture.recentRun != null ? 0 : 1;
          return { success: true, meta: { changes } };
        }
        return { success: true, meta: { changes: 1 } };
      }),
    };
    return {
      bind: (...params: unknown[]) => {
        bound.push(...params);
        return stmt;
      },
      first: stmt.first,
      run: stmt.run,
    };
  });
  return { prepare } as unknown as D1Database;
}

interface QueueFixture {
  sent: unknown[];
}

function makeQueue(fixture: QueueFixture): Queue<unknown> {
  return {
    send: vi.fn().mockImplementation(async (msg: unknown) => {
      fixture.sent.push(msg);
    }),
    sendBatch: vi.fn(),
  } as unknown as Queue<unknown>;
}

function makeEnv(
  db: D1Database,
  queue: Queue<unknown>,
  options: { cfAccessAud?: string } = {},
): Partial<Env> {
  return {
    APP_URL,
    DB: db,
    SCRAPE_COORDINATOR: queue as unknown as Env['SCRAPE_COORDINATOR'],
    ADMIN_EMAIL,
    OAUTH_JWT_SECRET: SECRET,
    ...(options.cfAccessAud !== undefined ? { CF_ACCESS_AUD: options.cfAccessAud } : {}),
  };
}

function makeContext(request: Request, env: Partial<Env>): unknown {
  return {
    request,
    locals: { runtime: { env: env as Env } },
    url: new URL(request.url),
    params: {},
  };
}

async function refreshRequest(
  verb: 'POST' | 'GET',
  options: {
    origin?: string | null;
    accept?: string;
    /** Override the Cf-Access-Jwt-Assertion. null = no header. */
    accessJwt?: string | null;
    /** Override the session cookie. null = no cookie. */
    cookieJwt?: string | null;
    /** Sec-Fetch-Site header value (CF-011). undefined = header omitted. */
    secFetchSite?: string;
  } = {},
): Promise<Request> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (options.origin != null) {
    headers.set('Origin', options.origin);
  }
  if (options.secFetchSite !== undefined) {
    headers.set('Sec-Fetch-Site', options.secFetchSite);
  }
  headers.set('Accept', options.accept ?? 'application/json');
  // CF-001 — admin auth headers default to "valid admin" so existing
  // tests pass; explicit null in the option drops them.
  const access = options.accessJwt === undefined ? ACCESS_JWT : options.accessJwt;
  if (access !== null) {
    headers.set('Cf-Access-Jwt-Assertion', access);
  }
  const cookie =
    options.cookieJwt === undefined
      ? await adminCookieJwt()
      : options.cookieJwt;
  if (cookie !== null) {
    headers.set('Cookie', `${SESSION_COOKIE_NAME}=${cookie}`);
  }
  return new Request(`${APP_URL}/api/admin/force-refresh`, { method: verb, headers });
}

describe('admin-auth gate (CF-001)', () => {
  it('CF-001: returns 401 when CF_ACCESS_AUD is set and Cf-Access-Jwt-Assertion is missing', async () => {
    const fixture: DbFixture = { calls: [] };
    const db = makeDb(fixture);
    const queue = makeQueue({ sent: [] });
    const req = await refreshRequest('POST', {
      origin: APP_ORIGIN,
      accessJwt: null,
    });
    const res = await POST(
      makeContext(req, makeEnv(db, queue, { cfAccessAud: 'tenant-aud-tag' })) as never,
    );
    expect(res.status).toBe(401);
  });

  it('CF-001: succeeds when CF_ACCESS_AUD is unset and Cf-Access-Jwt-Assertion is missing (perimeter is opt-in)', async () => {
    // refreshRequest defaults to a valid admin session cookie (see line ~178);
    // we override only the access JWT to confirm Layer 0 is genuinely opt-in.
    // Layers A (session) + B (ADMIN_EMAIL) still apply — and pass — via the
    // default cookie. A 200 (JSON ok) or 303 (redirect) both mean the gate
    // accepted the request.
    const fixture: DbFixture = { calls: [] };
    const db = makeDb(fixture);
    const queue = makeQueue({ sent: [] });
    const req = await refreshRequest('POST', {
      origin: APP_ORIGIN,
      accessJwt: null,
    });
    const res = await POST(makeContext(req, makeEnv(db, queue)) as never);
    expect([200, 303]).toContain(res.status);
  });

  it('CF-001: returns 401 when the session cookie is missing', async () => {
    const fixture: DbFixture = { calls: [] };
    const db = makeDb(fixture);
    const queue = makeQueue({ sent: [] });
    const req = await refreshRequest('POST', {
      origin: APP_ORIGIN,
      cookieJwt: null,
    });
    const res = await POST(makeContext(req, makeEnv(db, queue)) as never);
    expect(res.status).toBe(401);
  });

  it('CF-001: returns 403 when the session email does NOT match ADMIN_EMAIL', async () => {
    const fixture: DbFixture = { calls: [] };
    // Inject a row with a different email — Layer 3 fails.
    const db = makeDb(fixture, { ...ADMIN_USER_ROW, email: 'not-admin@example.com' });
    const queue = makeQueue({ sent: [] });
    // Sign the JWT with the same non-admin email so verifySession succeeds.
    const jwt = await signSession(
      { sub: ADMIN_USER_ROW.id, email: 'not-admin@example.com', ghl: 'admin', sv: 1 },
      SECRET,
    );
    const req = await refreshRequest('POST', {
      origin: APP_ORIGIN,
      cookieJwt: jwt,
    });
    const res = await POST(makeContext(req, makeEnv(db, queue)) as never);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/force-refresh', () => {
  it('rejects POST with missing Origin (REQ-AUTH-003 CSRF defence)', async () => {
    const calls: DbFixture['calls'] = [];
    const db = makeDb({ calls });
    const queue = makeQueue({ sent: [] });
    const req = await refreshRequest('POST', { origin: null });
    const res = await POST(makeContext(req, makeEnv(db, queue)) as never);
    expect(res.status).toBe(403);
  });

  it('rejects POST with a foreign Origin', async () => {
    const calls: DbFixture['calls'] = [];
    const db = makeDb({ calls });
    const queue = makeQueue({ sent: [] });
    const req = await refreshRequest('POST', { origin: 'https://evil.example.com' });
    const res = await POST(makeContext(req, makeEnv(db, queue)) as never);
    expect(res.status).toBe(403);
  });

  it('POST happy path: inserts scrape_runs row, enqueues coordinator, 303 to /settings', async () => {
    const fixture: DbFixture = { calls: [] };
    const db = makeDb(fixture);
    const qsent: unknown[] = [];
    const queue = makeQueue({ sent: qsent });
    const req = await refreshRequest('POST', { origin: APP_ORIGIN });
    const res = await POST(makeContext(req, makeEnv(db, queue)) as never);

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toMatch(
      /\/settings\?force_refresh=ok&run_id=/,
    );
    // An INSERT INTO scrape_runs happened with chunk_count=0 (NOT NULL
    // schema — see src/lib/scrape-run.ts). Regression guard for the
    // NULL-binding bug that was fixed in dc65bf0.
    // CF-003: the INSERT is now an atomic INSERT … WHERE NOT EXISTS;
    // chunk_count 0 is still a literal in the SQL; params are
    // (id, model_id, started_at, cutoff) — 4 values.
    const insert = fixture.calls.find(
      (c) => c.sql.includes('INSERT INTO scrape_runs') && c.verb === 'run',
    );
    expect(insert).toBeDefined();
    // SQL contains literal 'running' and 0 values; the WHERE NOT EXISTS
    // clause follows so `0` is not immediately followed by `)`.
    expect(insert!.sql).toMatch(/'running',\s*0/);
    expect(insert!.sql).toMatch(/WHERE NOT EXISTS/);
    // 4 bound params: id, model_id, started_at, cutoff.
    expect(insert!.params).toHaveLength(4);
    // Queue received exactly one coordinator message with the run id.
    expect(qsent).toHaveLength(1);
    expect((qsent[0] as { scrape_run_id: string }).scrape_run_id).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{26}$/, // ULID alphabet
    );
  });

  it('POST reuses an existing running run within the 120s window instead of kicking a new one', async () => {
    // User double-clicks "Force refresh now" — second click MUST NOT
    // create a second scrape_runs row and MUST NOT enqueue a second
    // coordinator message. Both would double the LLM cost.
    const now = Math.floor(Date.now() / 1000);
    const fixture: DbFixture = {
      calls: [],
      recentRun: { id: 'already-running-id', started_at: now - 30 },
    };
    const db = makeDb(fixture);
    const qsent: unknown[] = [];
    const queue = makeQueue({ sent: qsent });
    const req = await refreshRequest('POST', { origin: APP_ORIGIN });
    const res = await POST(makeContext(req, makeEnv(db, queue)) as never);

    expect(res.status).toBe(303);
    // Redirect carries the REUSED marker + the existing run id.
    expect(res.headers.get('Location')).toMatch(
      /force_refresh=reused&run_id=already-running-id/,
    );
    // CF-003: the claim is an atomic INSERT … WHERE NOT EXISTS.
    // When a recent run exists, the INSERT returns changes === 0 (lost
    // the claim race) — it executed but wrote nothing. No second scrape
    // row is created and no coordinator message is enqueued.
    const claim = fixture.calls.find(
      (c) => c.sql.includes('INSERT INTO scrape_runs') && c.verb === 'run',
    );
    expect(claim).toBeDefined(); // INSERT attempted
    expect(qsent).toHaveLength(0); // but no message enqueued
  });
});

describe('GET /api/admin/force-refresh', () => {
  it('GET 200 JSON happy path: inserts scrape_runs, enqueues, returns { ok, scrape_run_id, reused: false }', async () => {
    const fixture: DbFixture = { calls: [] };
    const db = makeDb(fixture);
    const qsent: unknown[] = [];
    const queue = makeQueue({ sent: qsent });
    const req = await refreshRequest('GET');
    const res = await GET(makeContext(req, makeEnv(db, queue)) as never);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      scrape_run_id: string;
      reused: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.reused).toBe(false);
    expect(body.scrape_run_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(qsent).toHaveLength(1);
  });

  it('GET with a recent running run reuses instead of kicking (link-preview bot storm guard)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const fixture: DbFixture = {
      calls: [],
      recentRun: { id: 'reused-run-id', started_at: now - 60 },
    };
    const db = makeDb(fixture);
    const qsent: unknown[] = [];
    const queue = makeQueue({ sent: qsent });
    const req = await refreshRequest('GET');
    const res = await GET(makeContext(req, makeEnv(db, queue)) as never);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scrape_run_id: string;
      reused: boolean;
    };
    expect(body.reused).toBe(true);
    expect(body.scrape_run_id).toBe('reused-run-id');
    // CF-003: claim INSERT attempted but returned changes === 0 (claim lost).
    // No new scrape row written, no queue send.
    const claim = fixture.calls.find(
      (c) => c.sql.includes('INSERT INTO scrape_runs') && c.verb === 'run',
    );
    expect(claim).toBeDefined(); // INSERT attempted
    expect(qsent).toHaveLength(0); // but no message enqueued
  });

  it('GET browser deny: non-admin session is redirected to /settings?force_refresh=denied (no raw 403 body)', async () => {
    // CF-001 follow-up: when the admin gate denies a browser GET (i.e.,
    // no `Accept: application/json`), the operator should land on
    // /settings with an explicit deny marker — never on a bare 403
    // text body. Scripts that opted into JSON keep the raw status.
    const fixture: DbFixture = { calls: [] };
    const db = makeDb(fixture, { ...ADMIN_USER_ROW, email: 'not-admin@example.com' });
    const queue = makeQueue({ sent: [] });
    const jwt = await signSession(
      { sub: ADMIN_USER_ROW.id, email: 'not-admin@example.com', ghl: 'admin', sv: 1 },
      SECRET,
    );
    const req = await refreshRequest('GET', { accept: 'text/html', cookieJwt: jwt });
    const res = await GET(makeContext(req, makeEnv(db, queue)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toMatch(/\/settings\?force_refresh=denied$/);
  });

  it('GET JSON deny: non-admin session keeps the raw 403 (so scripts can detect)', async () => {
    const fixture: DbFixture = { calls: [] };
    const db = makeDb(fixture, { ...ADMIN_USER_ROW, email: 'not-admin@example.com' });
    const queue = makeQueue({ sent: [] });
    const jwt = await signSession(
      { sub: ADMIN_USER_ROW.id, email: 'not-admin@example.com', ghl: 'admin', sv: 1 },
      SECRET,
    );
    const req = await refreshRequest('GET', { accept: 'application/json', cookieJwt: jwt });
    const res = await GET(makeContext(req, makeEnv(db, queue)) as never);
    expect(res.status).toBe(403);
  });

  it('CF-011: GET rejects Sec-Fetch-Site=cross-site with 403 even when admin auth is valid', async () => {
    // Defense-in-depth against same-browser CSRF. Coordinator dispatch
    // is already auth-gated, but a cross-site fetch initiated by an
    // attacker page must not reach the rate limiter or coordinator.
    const fixture: DbFixture = { calls: [] };
    const db = makeDb(fixture);
    const qsent: unknown[] = [];
    const queue = makeQueue({ sent: qsent });
    const req = await refreshRequest('GET', { secFetchSite: 'cross-site' });
    const res = await GET(makeContext(req, makeEnv(db, queue)) as never);
    expect(res.status).toBe(403);
    // Coordinator was not dispatched.
    expect(qsent).toHaveLength(0);
  });

  it('CF-011: GET accepts Sec-Fetch-Site=same-origin (legitimate first-party fetch)', async () => {
    const fixture: DbFixture = { calls: [] };
    const db = makeDb(fixture);
    const qsent: unknown[] = [];
    const queue = makeQueue({ sent: qsent });
    const req = await refreshRequest('GET', { secFetchSite: 'same-origin' });
    const res = await GET(makeContext(req, makeEnv(db, queue)) as never);
    expect(res.status).toBe(200);
    expect(qsent).toHaveLength(1);
  });

  it('CF-011: GET accepts Sec-Fetch-Site=none (top-level nav / SSO callback per AD38)', async () => {
    // AD38 designates the GET path as the post-SSO callback target.
    // Cloudflare Access top-level navigation sets Sec-Fetch-Site: none.
    const fixture: DbFixture = { calls: [] };
    const db = makeDb(fixture);
    const qsent: unknown[] = [];
    const queue = makeQueue({ sent: qsent });
    const req = await refreshRequest('GET', { secFetchSite: 'none' });
    const res = await GET(makeContext(req, makeEnv(db, queue)) as never);
    expect(res.status).toBe(200);
    expect(qsent).toHaveLength(1);
  });

  it('GET does NOT run Origin check (deliberately — the endpoint is gated by Cloudflare Access, not by browser cookies)', async () => {
    // The absence of Origin headers MUST NOT block a GET — operators
    // trigger via bookmark/curl with no Origin. Only the Access
    // policy in front of the endpoint decides access.
    const fixture: DbFixture = { calls: [] };
    const db = makeDb(fixture);
    const queue = makeQueue({ sent: [] });
    const req = await refreshRequest('GET', { origin: null });
    const res = await GET(makeContext(req, makeEnv(db, queue)) as never);
    expect(res.status).toBe(200);
  });
});

describe('reuse-window SQL contract', () => {
  it('tryClaimDispatch INSERT embeds status=running and started_at cutoff within 120s of now', async () => {
    // CF-003: the reuse-window check is now an atomic INSERT ... WHERE
    // NOT EXISTS rather than a separate SELECT. The INSERT's WHERE NOT
    // EXISTS subquery carries the status + started_at guard; the bound
    // cutoff param is the fourth argument (index 3).
    const now = Math.floor(Date.now() / 1000);
    const fixture: DbFixture = { calls: [] };
    const db = makeDb(fixture);
    const queue = makeQueue({ sent: [] });
    const req = await refreshRequest('GET');
    await GET(makeContext(req, makeEnv(db, queue)) as never);

    const claim = fixture.calls.find(
      (c) => c.sql.includes('INSERT INTO scrape_runs') && c.verb === 'run',
    );
    expect(claim).toBeDefined();
    expect(claim!.sql).toMatch(/status\s*=\s*'running'/);
    expect(claim!.sql).toMatch(/started_at\s*>=\s*\?4/);
    // The fourth bound param is the cutoff: (now - 120) ± a few seconds.
    const cutoff = claim!.params[3] as number;
    expect(cutoff).toBeGreaterThanOrEqual(now - 125);
    expect(cutoff).toBeLessThanOrEqual(now - 115);
  });
});
