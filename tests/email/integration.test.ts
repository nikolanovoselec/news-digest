// Tests for src/lib/email.ts `sendEmail` payload shape AND
// src/lib/email-dispatch.ts `dispatchDailyEmails` once-per-day gating —
// REQ-MAIL-001.
//
// Two test groups:
//
// 1. sendEmail payload — verifies the Resend POST body carries the exact
//    `from`, `to`, `subject`, `html`, `text`, and `tags` fields plus the
//    bearer `Authorization` header.
//
// 2. dispatchDailyEmails gating — verifies that the dispatcher sends at
//    most one email per user per local day by keying on
//    `last_emailed_local_date`. The test drives a fake D1 whose row state
//    it toggles between runs: first with today's date stamped (no send),
//    then with yesterday's date stamped (one send), and asserts the
//    post-send stamp update.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendEmail, type SendEmailParams } from '~/lib/email';
import { dispatchDailyEmails } from '~/lib/email-dispatch';
import { localDateInTz, localHourMinuteInTz } from '~/lib/tz';

function makeParams(overrides: Partial<SendEmailParams> = {}): SendEmailParams {
  return {
    to: 'alice@example.com',
    subject: 'Your news digest is ready',
    text: 'Your news digest is ready.\n\nView it here: https://news-digest.example.com/digest',
    html: '<p>Your news digest is ready.</p>',
    ...overrides,
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    RESEND_API_KEY: 're_test_key_123',
    RESEND_FROM: 'News Digest <digest@example.com>',
    APP_URL: 'https://news-digest.example.com',
    ...overrides,
  } as unknown as Env;
}

/** Capture a single fetch call and return the parsed JSON body, URL,
 * and headers for assertion. */
interface CapturedCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function captureSingleFetch(): {
  fetchMock: ReturnType<typeof vi.fn>;
  get: () => CapturedCall;
} {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: 'msg-xyz' }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    get(): CapturedCall {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      const url = call?.[0] as string;
      const init = call?.[1] as RequestInit;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      return { url, init, body };
    },
  };
}

describe('sendEmail payload — REQ-MAIL-001', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('REQ-MAIL-001: POSTs to https://api.resend.com/emails', async () => {
    const cap = captureSingleFetch();
    await sendEmail(makeEnv(), makeParams());
    const call = cap.get();
    expect(call.url).toBe('https://api.resend.com/emails');
    expect(call.init.method).toBe('POST');
  });

  it('REQ-MAIL-001: sends bearer Authorization header with RESEND_API_KEY', async () => {
    const cap = captureSingleFetch();
    await sendEmail(makeEnv({ RESEND_API_KEY: 're_secret_xyz' }), makeParams());
    const call = cap.get();
    const headers = new Headers(call.init.headers);
    expect(headers.get('Authorization')).toBe('Bearer re_secret_xyz');
  });

  it('REQ-MAIL-001: sends Content-Type: application/json', async () => {
    const cap = captureSingleFetch();
    await sendEmail(makeEnv(), makeParams());
    const call = cap.get();
    const headers = new Headers(call.init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('REQ-MAIL-001 AC 9: payload.from passes through env.RESEND_FROM verbatim when it already carries a display name', async () => {
    const cap = captureSingleFetch();
    await sendEmail(
      makeEnv({ RESEND_FROM: 'News Digest <digest@example.com>' }),
      makeParams(),
    );
    const call = cap.get();
    expect(call.body.from).toBe('News Digest <digest@example.com>');
  });

  it('REQ-MAIL-001 AC 9: payload.from wraps a bare RESEND_FROM email with the brand display name', async () => {
    const cap = captureSingleFetch();
    await sendEmail(
      makeEnv({ RESEND_FROM: 'noreply@graymatter.ch' }),
      makeParams(),
    );
    const call = cap.get();
    expect(call.body.from).toBe('News Digest <noreply@graymatter.ch>');
  });

  it('REQ-MAIL-001: payload.to is an array containing the recipient', async () => {
    const cap = captureSingleFetch();
    await sendEmail(
      makeEnv(),
      makeParams({ to: 'recipient@example.com' }),
    );
    const call = cap.get();
    expect(Array.isArray(call.body.to)).toBe(true);
    expect(call.body.to).toEqual(['recipient@example.com']);
  });

  it('REQ-MAIL-001: payload.subject is forwarded verbatim from the caller', async () => {
    const cap = captureSingleFetch();
    await sendEmail(
      makeEnv(),
      makeParams({ subject: 'Your news digest is ready' }),
    );
    const call = cap.get();
    expect(call.body.subject).toBe('Your news digest is ready');
  });

  it('REQ-MAIL-001: payload.html is the caller-supplied HTML string', async () => {
    const cap = captureSingleFetch();
    await sendEmail(
      makeEnv(),
      makeParams({ html: '<p>ready</p>' }),
    );
    const call = cap.get();
    expect(call.body.html).toBe('<p>ready</p>');
  });

  it('REQ-MAIL-001: payload.text is the caller-supplied plaintext string', async () => {
    const cap = captureSingleFetch();
    await sendEmail(
      makeEnv(),
      makeParams({ text: 'ready' }),
    );
    const call = cap.get();
    expect(call.body.text).toBe('ready');
  });

  it('REQ-MAIL-001: payload.tags contains { name: "kind", value: "daily-digest" }', async () => {
    const cap = captureSingleFetch();
    await sendEmail(makeEnv(), makeParams());
    const call = cap.get();
    expect(call.body.tags).toEqual([{ name: 'kind', value: 'daily-digest' }]);
  });

  it('REQ-MAIL-001: payload body contains exactly the documented keys', async () => {
    const cap = captureSingleFetch();
    await sendEmail(makeEnv(), makeParams());
    const call = cap.get();
    expect(Object.keys(call.body).sort()).toEqual(
      ['from', 'html', 'subject', 'tags', 'text', 'to'].sort(),
    );
  });

  it('REQ-MAIL-001: request carries an AbortSignal (timeout)', async () => {
    const cap = captureSingleFetch();
    await sendEmail(makeEnv(), makeParams());
    const call = cap.get();
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });
});

/* --------------------------------------------------------------------- */
/* dispatchDailyEmails — REQ-MAIL-001 once-per-day gating                */
/* --------------------------------------------------------------------- */

interface DispatchUserRow {
  id: string;
  email: string;
  gh_login: string;
  tz: string;
  digest_hour: number;
  digest_minute: number;
  hashtags_json: string | null;
  last_emailed_local_date: string | null;
  /** Optional in fixtures — defaults to `1` (enabled) when omitted so
   *  pre-existing tests don't have to set it. AC 9 tests set `0` to
   *  exercise the opt-out path end-to-end. */
  email_enabled?: 0 | 1;
}

interface PreparedCall {
  sql: string;
  params: unknown[];
}

/** Minimal D1 stub tailored to the two queries `dispatchDailyEmails` issues.
 *  The row collection is mutable by reference so tests can mutate
 *  `last_emailed_local_date` between runs without rebuilding the stub. */
function makeDispatchDb(users: DispatchUserRow[]): {
  db: D1Database;
  runCalls: PreparedCall[];
} {
  const runCalls: PreparedCall[] = [];

  const prepareSpy = vi.fn().mockImplementation((sql: string) => {
    const stmt = {
      _sql: sql,
      _params: [] as unknown[],
      bind(...params: unknown[]) {
        stmt._params = params;
        return stmt;
      },
      all: vi.fn().mockImplementation(async () => {
        if (sql.includes('SELECT DISTINCT tz')) {
          // Simulate the SQL's WHERE email_enabled = 1 predicate so a
          // user with email_enabled = 0 never even contributes a tz to
          // the loop.
          const tzs = new Set(
            users.filter((u) => (u.email_enabled ?? 1) === 1).map((u) => u.tz),
          );
          return { results: [...tzs].map((tz) => ({ tz })) };
        }
        if (sql.startsWith('SELECT id, email, gh_login')) {
          const [, hour, bucketStart, bucketEnd, localDate] = stmt._params as [
            string,
            number,
            number,
            number,
            string,
          ];
          // Same predicate as the dispatcher's per-user SQL — including
          // email_enabled = 1 so the AC 9 opt-out test exercises the
          // exclusion behaviourally, not just by string-matching the
          // SQL.
          const filtered = users.filter(
            (u) =>
              (u.email_enabled ?? 1) === 1 &&
              u.digest_hour === hour &&
              u.digest_minute >= bucketStart &&
              u.digest_minute < bucketEnd &&
              (u.last_emailed_local_date === null ||
                u.last_emailed_local_date !== localDate),
          );
          return { results: filtered };
        }
        // Headlines query — return one fixture row so AC 11
        // (skip-on-empty) does not short-circuit these gating tests
        // before they reach the send path.
        if (sql.includes('AS source_name')) {
          return {
            results: [{
              id: 'art-fixture',
              title: 'Fixture article',
              source_name: 'Fixture source',
              primary_source_url: 'https://example.com/fixture',
            }],
          };
        }
        // Tally GROUP BY — empty is fine for the gating tests.
        return { results: [] };
      }),
      run: vi.fn().mockImplementation(async () => {
        runCalls.push({ sql, params: stmt._params });
        if (sql.startsWith('UPDATE users SET last_emailed_local_date')) {
          const [localDate, id] = stmt._params as [string, string];
          const user = users.find((u) => u.id === id);
          if (user !== undefined) {
            user.last_emailed_local_date = localDate;
          }
        }
        return { success: true, meta: { changes: 1 } };
      }),
      first: vi.fn().mockImplementation(async () => {
        // tagTallySinceMidnight totals query — fine to return zero.
        if (sql.includes('COUNT(DISTINCT a.id)')) return { total: 0 };
        return null;
      }),
    };
    return stmt;
  });

  const db = {
    prepare: prepareSpy,
    batch: vi.fn().mockResolvedValue([]),
  } as unknown as D1Database;

  return { db, runCalls };
}

describe('dispatchDailyEmails — REQ-MAIL-001 once-per-day gating', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('REQ-MAIL-001: does not send when last_emailed_local_date equals today-in-tz', async () => {
    const now = Math.floor(Date.now() / 1000);
    const today = localDateInTz(now, 'UTC');
    const { hour, minute } = localHourMinuteInTz(now, 'UTC');

    const users: DispatchUserRow[] = [
      {
        id: 'user-1',
        email: 'alice@example.com',
        gh_login: 'alice',
        tz: 'UTC',
        digest_hour: hour,
        digest_minute: minute - (minute % 5), // inside the current 5-min bucket
        hashtags_json: '["cloudflare"]',
        last_emailed_local_date: today,
      },
    ];
    const { db, runCalls } = makeDispatchDb(users);
    await dispatchDailyEmails(makeEnv({ DB: db }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      runCalls.filter((c) =>
        c.sql.startsWith('UPDATE users SET last_emailed_local_date'),
      ),
    ).toHaveLength(0);
  });

  it('REQ-MAIL-001: sends and stamps last_emailed_local_date when stamp is stale', async () => {
    const now = Math.floor(Date.now() / 1000);
    const today = localDateInTz(now, 'UTC');
    const { hour, minute } = localHourMinuteInTz(now, 'UTC');

    // A stale stamp from a previous day — any value !== today triggers
    // the send path. Using a clearly-old date avoids edge cases with
    // tests that run across midnight UTC.
    const stale = '1970-01-01';
    const users: DispatchUserRow[] = [
      {
        id: 'user-2',
        email: 'bob@example.com',
        gh_login: 'bob',
        tz: 'UTC',
        digest_hour: hour,
        digest_minute: minute - (minute % 5),
        hashtags_json: '["cloudflare"]',
        last_emailed_local_date: stale,
      },
    ];
    const { db, runCalls } = makeDispatchDb(users);
    await dispatchDailyEmails(makeEnv({ DB: db }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stampUpdates = runCalls.filter((c) =>
      c.sql.startsWith('UPDATE users SET last_emailed_local_date'),
    );
    expect(stampUpdates).toHaveLength(1);
    expect(stampUpdates[0]?.params[0]).toBe(today);
    expect(stampUpdates[0]?.params[1]).toBe('user-2');

    // Stamp was persisted: running again the same day is a no-op.
    fetchMock.mockClear();
    await dispatchDailyEmails(makeEnv({ DB: db }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('REQ-MAIL-001 AC 9: a user with email_enabled = 0 never receives an email even when their schedule matches', async () => {
    // Behavioural check (not SQL-string match): seed two users in the
    // same tz/hour/minute bucket, one opted-in and one opted-out, and
    // assert that exactly one fetch fires and it targets the opted-in
    // recipient. The stub's filter mirrors the dispatcher's SQL
    // predicate including `email_enabled = 1`.
    const now = Math.floor(Date.now() / 1000);
    const { hour, minute } = localHourMinuteInTz(now, 'UTC');
    const users: DispatchUserRow[] = [
      {
        id: 'user-optin',
        email: 'optin@example.com',
        gh_login: 'optin',
        tz: 'UTC',
        digest_hour: hour,
        digest_minute: minute - (minute % 5),
        hashtags_json: '["cloudflare"]',
        last_emailed_local_date: '1970-01-01',
        email_enabled: 1,
      },
      {
        id: 'user-optout',
        email: 'optout@example.com',
        gh_login: 'optout',
        tz: 'UTC',
        digest_hour: hour,
        digest_minute: minute - (minute % 5),
        hashtags_json: '["cloudflare"]',
        last_emailed_local_date: '1970-01-01',
        email_enabled: 0,
      },
    ];
    const { db } = makeDispatchDb(users);
    await dispatchDailyEmails(makeEnv({ DB: db }));

    const recipients = fetchMock.mock.calls
      .map((c) => JSON.parse((c[1] as RequestInit).body as string) as { to: string[] })
      .map((b) => b.to[0]);
    expect(recipients).toEqual(['optin@example.com']);
    expect(recipients).not.toContain('optout@example.com');
  });

  it('REQ-MAIL-001 AC 9: per-user SELECT carries the email_enabled = 1 predicate (opt-out filter)', async () => {
    // AC 9 — "Users who turn off email_enabled in settings receive
    // no email." The dispatcher enforces this at the SQL layer; the
    // test asserts the predicate's literal presence in BOTH the
    // distinct-tz probe and the per-user scan, since either path
    // omitting it would silently start emailing opt-out users.
    const now = Math.floor(Date.now() / 1000);
    const today = localDateInTz(now, 'UTC');
    const { hour, minute } = localHourMinuteInTz(now, 'UTC');
    const users: DispatchUserRow[] = [
      {
        id: 'user-ac9',
        email: 'ac9@example.com',
        gh_login: 'ac9',
        tz: 'UTC',
        digest_hour: hour,
        digest_minute: minute - (minute % 5),
        hashtags_json: '["cloudflare"]',
        last_emailed_local_date: today === '2099-01-01' ? null : '1970-01-01',
      },
    ];
    const { db } = makeDispatchDb(users);
    const prepareSpy = vi.spyOn(db, 'prepare');
    await dispatchDailyEmails(makeEnv({ DB: db }));

    const sqls = prepareSpy.mock.calls.map((c) => c[0] as string);
    const tzProbe = sqls.find((s) => s.includes('SELECT DISTINCT tz'));
    const userScan = sqls.find((s) => s.startsWith('SELECT id, email, gh_login'));
    expect(tzProbe).toBeDefined();
    expect(tzProbe).toContain('email_enabled = 1');
    expect(userScan).toBeDefined();
    expect(userScan).toContain('email_enabled = 1');
  });

  it('REQ-MAIL-001: dispatcher SELECTs hashtags_json and tz from users', async () => {
    // Regression guard for the rich-email design — the dispatcher must
    // pull `hashtags_json` (for headlines + tally) and `tz` (for the
    // local-time line + the local-midnight cutoff) on the per-user
    // SELECT. If a refactor drops either column, the renderer falls
    // through to the static fallback for everyone.
    const now = Math.floor(Date.now() / 1000);
    const today = localDateInTz(now, 'UTC');
    const { hour, minute } = localHourMinuteInTz(now, 'UTC');
    const users: DispatchUserRow[] = [
      {
        id: 'user-cols',
        email: 'cols@example.com',
        gh_login: 'cols',
        tz: 'UTC',
        digest_hour: hour,
        digest_minute: minute - (minute % 5),
        hashtags_json: '["mcp"]',
        last_emailed_local_date: today === '2099-01-01' ? null : '1970-01-01',
      },
    ];
    const { db } = makeDispatchDb(users);
    const prepareSpy = vi.spyOn(db, 'prepare');
    await dispatchDailyEmails(makeEnv({ DB: db }));

    const userSelectSql = prepareSpy.mock.calls
      .map((c) => c[0] as string)
      .find((s) => s.startsWith('SELECT id, email, gh_login'));
    expect(userSelectSql).toBeDefined();
    expect(userSelectSql).toContain('hashtags_json');
    expect(userSelectSql).toContain('tz');
  });

  it('REQ-MAIL-001: does not stamp last_emailed_local_date when the send fails', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { hour, minute } = localHourMinuteInTz(now, 'UTC');

    const users: DispatchUserRow[] = [
      {
        id: 'user-3',
        email: 'carol@example.com',
        gh_login: 'carol',
        tz: 'UTC',
        digest_hour: hour,
        digest_minute: minute - (minute % 5),
        hashtags_json: '["cloudflare"]',
        last_emailed_local_date: null,
      },
    ];
    const { db, runCalls } = makeDispatchDb(users);

    // Resend returns 500 — sendEmail resolves to { sent: false, ... }.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('server error', { status: 500 }));

    await dispatchDailyEmails(makeEnv({ DB: db }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // No stamp → the next cron tick retries within the same local day.
    expect(
      runCalls.filter((c) =>
        c.sql.startsWith('UPDATE users SET last_emailed_local_date'),
      ),
    ).toHaveLength(0);
  });
});
