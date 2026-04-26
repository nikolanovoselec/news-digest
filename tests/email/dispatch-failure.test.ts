// Tests for REQ-MAIL-002 — non-blocking email failure.
//
// The dispatcher MUST:
//   AC 1: pass a request timeout to the transport (verified indirectly
//         via the transport contract — sendEmail owns the timeout; we
//         verify the dispatcher calls sendEmail).
//   AC 2: log structured `email.send.failed` events and never throw
//         back to the cron handler.
//   AC 3: one user's failed send never blocks a sibling user's send.
//   AC 4: reading surfaces stay fully usable regardless of email
//         outcome (no shared state; this is architectural, not
//         directly testable here — covered by the absence of any
//         cross-call side effects on D1).
//   AC 5: on send failure, `last_emailed_local_date` is NOT advanced
//         so the next cron tick retries the same user naturally.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchDailyEmails } from '~/lib/email-dispatch';

// ---------- test harness ----------

interface TzRow { tz: string; }
interface UserRow {
  id: string;
  email: string;
  gh_login: string;
  tz: string;
  digest_hour: number;
  digest_minute: number;
  hashtags_json: string | null;
  last_emailed_local_date: string | null;
}

interface SqlCall { sql: string; params: unknown[]; verb: 'all' | 'run' | 'first'; }

function makeDb(opts: {
  distinctTzs: TzRow[];
  usersByTz: Record<string, UserRow[]>;
  calls: SqlCall[];
}): D1Database {
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const bound: unknown[] = [];
    return {
      bind: (...params: unknown[]) => {
        bound.push(...params);
        return {
          all: vi.fn().mockImplementation(async () => {
            opts.calls.push({ sql, params: [...bound], verb: 'all' });
            if (sql.includes('SELECT id, email, gh_login')) {
              const tz = bound[0] as string;
              const pool = opts.usersByTz[tz] ?? [];
              const hour = bound[1] as number;
              const windowStart = bound[2] as number;
              const windowEnd = bound[3] as number;
              const localDate = bound[4] as string;
              const results = pool.filter(
                (u) =>
                  u.digest_hour === hour &&
                  u.digest_minute >= windowStart &&
                  u.digest_minute < windowEnd &&
                  (u.last_emailed_local_date === null ||
                    u.last_emailed_local_date !== localDate),
              );
              return { success: true, results };
            }
            // Headlines query (SELECT a.id, a.title, ...) and tally
            // grouping query both fire from email-data.ts and must
            // resolve cleanly; tests don't probe headline content here.
            return { success: true, results: [] };
          }),
          run: vi.fn().mockImplementation(async () => {
            opts.calls.push({ sql, params: [...bound], verb: 'run' });
            return { success: true, meta: { changes: 1 } };
          }),
          first: vi.fn().mockImplementation(async () => {
            opts.calls.push({ sql, params: [...bound], verb: 'first' });
            // Total-articles query returns { total: 0 } — empty digest
            // is the failure-test default.
            if (sql.includes('COUNT(DISTINCT a.id)')) {
              return { total: 0 };
            }
            return null;
          }),
        };
      },
      all: vi.fn().mockImplementation(async () => {
        opts.calls.push({ sql, params: [], verb: 'all' });
        if (sql.includes('SELECT DISTINCT tz')) {
          return { success: true, results: opts.distinctTzs };
        }
        return { success: true, results: [] };
      }),
    };
  });
  return { prepare } as unknown as D1Database;
}

/** Mock Resend transport: the fetch handler decides each call's fate
 *  by looking at the JSON body's `to` address against a scripted map.
 *  Captures the `init` argument on every call so assertions can probe
 *  `signal` (AC 1 — timeout) alongside body. */
function makeFetch(
  outcomeByRecipient: Record<
    string,
    { kind: 'ok' } | { kind: 'non-2xx'; status: number } | { kind: 'throw' }
  >,
): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ to: string; signal: AbortSignal | null | undefined }>;
} {
  const calls: Array<{ to: string; signal: AbortSignal | null | undefined }> = [];
  const fetch = vi
    .fn()
    .mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { to: string[] };
      const to = body.to[0] ?? '';
      calls.push({ to, signal: init.signal });
      const outcome = outcomeByRecipient[to] ?? { kind: 'ok' };
      if (outcome.kind === 'throw') throw new Error('network error');
      if (outcome.kind === 'non-2xx') {
        return new Response('{"error":"forced"}', { status: outcome.status });
      }
      return new Response('{"id":"sent"}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function makeEnv(db: D1Database, fetchImpl: typeof globalThis.fetch): Partial<Env> {
  vi.stubGlobal('fetch', fetchImpl);
  return {
    APP_URL: 'https://news.example.com',
    DB: db,
    RESEND_API_KEY: 'test_key',
    RESEND_FROM: 'Digest <noreply@example.com>',
  };
}

function logSpyFactory(): { logs: Array<{ event: string; fields: unknown }>; restore: () => void } {
  const logs: Array<{ event: string; fields: unknown }> = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    // src/lib/log.ts emits one JSON-stringified object per call.
    for (const a of args) {
      if (typeof a === 'string') {
        try {
          const parsed = JSON.parse(a);
          if (parsed && typeof parsed === 'object' && 'event' in parsed) {
            logs.push({
              event: String((parsed as { event: unknown }).event),
              fields: parsed,
            });
          }
        } catch {
          // Not JSON — ignore. Most project emits are structured.
        }
      }
    }
  };
  return { logs, restore: () => { console.log = orig; } };
}

// ---------- AC 3 + AC 5: one user's failure doesn't block sibling ----------

describe('dispatchDailyEmails — REQ-MAIL-002 non-blocking failure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Fix the clock to a known UTC minute that lands in the 5-minute
    // bucket [0, 5). The test users are scheduled with
    // digest_hour = that-UTC-hour, digest_minute = 0.
    vi.setSystemTime(new Date('2026-04-23T14:02:00Z'));
  });

  it('REQ-MAIL-002 AC 3: a non-2xx failure for user A does not block the send to user B', async () => {
    const calls: SqlCall[] = [];
    const db = makeDb({
      distinctTzs: [{ tz: 'UTC' }],
      usersByTz: {
        UTC: [
          { id: 'u-fail', email: 'fail@x.com', gh_login: 'fail',
            tz: 'UTC', digest_hour: 14, digest_minute: 0, hashtags_json: null, last_emailed_local_date: null},
          { id: 'u-ok', email: 'ok@x.com', gh_login: 'ok',
            tz: 'UTC', digest_hour: 14, digest_minute: 0, hashtags_json: null, last_emailed_local_date: null},
        ],
      },
      calls,
    });
    const { fetch, calls: fetchCalls } = makeFetch({
      'fail@x.com': { kind: 'non-2xx', status: 500 },
      'ok@x.com': { kind: 'ok' },
    });
    const env = makeEnv(db, fetch) as Env;

    const spy = logSpyFactory();
    try {
      await dispatchDailyEmails(env);
    } finally {
      spy.restore();
    }

    // BOTH users attempted — failure on #1 didn't abort #2.
    expect(fetchCalls.map((c) => c.to).sort()).toEqual(
      ['fail@x.com', 'ok@x.com'],
    );

    // AC 5: fail user's last_emailed_local_date NOT advanced.
    const stamps = calls.filter(
      (c) => c.sql.includes('UPDATE users SET last_emailed_local_date') && c.verb === 'run',
    );
    const stampedIds = stamps.map((s) => s.params[1]);
    expect(stampedIds).toContain('u-ok');
    expect(stampedIds).not.toContain('u-fail');

    // AC 2: one structured email.send.failed event for the failed user.
    const failureLogs = spy.logs.filter((l) => l.event === 'email.send.failed');
    expect(failureLogs.length).toBeGreaterThan(0);
  });

  it('REQ-MAIL-002 AC 2: a thrown fetch error is caught and does NOT bubble up from dispatchDailyEmails', async () => {
    const db = makeDb({
      distinctTzs: [{ tz: 'UTC' }],
      usersByTz: {
        UTC: [
          { id: 'u-throw', email: 'throw@x.com', gh_login: 'throw',
            tz: 'UTC', digest_hour: 14, digest_minute: 0, hashtags_json: null, last_emailed_local_date: null},
        ],
      },
      calls: [],
    });
    const { fetch } = makeFetch({
      'throw@x.com': { kind: 'throw' },
    });
    const env = makeEnv(db, fetch) as Env;

    // The critical assertion: no throw. If the dispatcher let the
    // fetch error bubble, the cron would retry the whole tick and
    // a persistent Resend failure would storm-dispatch on every 5m.
    await expect(dispatchDailyEmails(env)).resolves.toBeUndefined();
  });

  it('REQ-MAIL-002 AC 1: each Resend request carries an AbortSignal (request-level timeout)', async () => {
    // The AbortSignal is the mechanism that guarantees a stuck Resend
    // request doesn't hang the cron tick past the next invocation. If
    // a refactor drops the signal the dispatcher silently loses its
    // per-request deadline. sendEmail owns the timeout value; the
    // dispatcher's contract is that every call passes through the
    // transport that attaches one.
    const db = makeDb({
      distinctTzs: [{ tz: 'UTC' }],
      usersByTz: {
        UTC: [
          { id: 'u-timeout-check', email: 'timeout@x.com', gh_login: 't',
            tz: 'UTC', digest_hour: 14, digest_minute: 0, hashtags_json: null, last_emailed_local_date: null},
        ],
      },
      calls: [],
    });
    const { fetch, calls } = makeFetch({ 'timeout@x.com': { kind: 'ok' } });
    await dispatchDailyEmails(makeEnv(db, fetch) as Env);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('REQ-MAIL-002 AC 4: dispatcher never INSERTS/UPDATES/DELETES reading-surface tables (read-only joins are allowed)', async () => {
    // AC 4 — "reading surfaces stay fully usable regardless of email
    // outcome". Updated invariant for the rich-email design: the
    // dispatcher legitimately READS from articles + article_tags +
    // article_reads to compose the digest body, so the test no longer
    // forbids those tables outright. What it MUST NOT do is mutate
    // them — any INSERT/UPDATE/DELETE on a reading-surface table
    // would couple email-cron failures to article/read state and
    // break the REQ-MAIL-002 / REQ-READ-001 isolation.
    const calls: SqlCall[] = [];
    const db = makeDb({
      distinctTzs: [{ tz: 'UTC' }],
      usersByTz: {
        UTC: [
          { id: 'u-success', email: 'ok@x.com', gh_login: 'ok',
            tz: 'UTC', digest_hour: 14, digest_minute: 0, hashtags_json: null, last_emailed_local_date: null},
          { id: 'u-failure', email: 'fail@x.com', gh_login: 'f',
            tz: 'UTC', digest_hour: 14, digest_minute: 0, hashtags_json: null, last_emailed_local_date: null},
        ],
      },
      calls,
    });
    const { fetch } = makeFetch({
      'ok@x.com': { kind: 'ok' },
      'fail@x.com': { kind: 'non-2xx', status: 500 },
    });
    await dispatchDailyEmails(makeEnv(db, fetch) as Env);

    const READING_TABLES = [
      'articles',
      'article_tags',
      'article_sources',
      'article_stars',
      'article_reads',
      'scrape_runs',
    ];
    for (const call of calls) {
      for (const table of READING_TABLES) {
        // Forbid only mutations on reading-surface tables; SELECT joins
        // for composing the email body are now legitimate.
        const re = new RegExp(`(INSERT\\s+(OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM)\\s+[^;]*\\b${table}\\b`, 'i');
        expect(
          re.test(call.sql),
          `dispatcher must not mutate ${table} (SQL was: ${call.sql.slice(0, 160)})`,
        ).toBe(false);
      }
    }
  });

  it('REQ-MAIL-002 AC 2 (dispatcher lane): a D1 UPDATE throw is caught by the dispatcher\'s own try/catch', async () => {
    // The prior AC 2/3 tests verify `sendEmail`'s non-throw contract.
    // This test exercises the dispatcher's OWN outer catch (lines
    // 138-147 of email-dispatch.ts): if D1 throws on the
    // last_emailed_local_date UPDATE, the dispatcher must log +
    // continue, not bubble the error up to the cron.
    const throwingPrepare = vi.fn().mockImplementation((sql: string) => {
      const bound: unknown[] = [];
      return {
        bind: (...params: unknown[]) => {
          bound.push(...params);
          return {
            all: vi.fn().mockImplementation(async () => {
              if (sql.includes('SELECT id, email, gh_login')) {
                return {
                  success: true,
                  results: [{
                    id: 'u-d1-throws',
                    email: 'd1throws@x.com',
                    gh_login: 'd',
                    tz: 'UTC',
                    digest_hour: 14,
                    digest_minute: 0,
                    hashtags_json: null,
                    last_emailed_local_date: null,
                  }],
                };
              }
              return { success: true, results: [] };
            }),
            run: vi.fn().mockImplementation(async () => {
              if (sql.includes('UPDATE users SET last_emailed_local_date')) {
                throw new Error('D1: database is locked');
              }
              return { success: true, meta: { changes: 1 } };
            }),
            first: vi.fn().mockImplementation(async () => {
              // tagTallySinceMidnight totals query — empty result is fine.
              if (sql.includes('COUNT(DISTINCT a.id)')) return { total: 0 };
              return null;
            }),
          };
        },
        all: vi.fn().mockImplementation(async () => {
          if (sql.includes('SELECT DISTINCT tz')) {
            return { success: true, results: [{ tz: 'UTC' }] };
          }
          return { success: true, results: [] };
        }),
      };
    });
    const db = { prepare: throwingPrepare } as unknown as D1Database;
    const { fetch } = makeFetch({ 'd1throws@x.com': { kind: 'ok' } });

    // The critical assertion: dispatchDailyEmails resolves, does not
    // reject — even though the D1 UPDATE inside its loop threw.
    await expect(
      dispatchDailyEmails(makeEnv(db, fetch) as Env),
    ).resolves.toBeUndefined();
  });

  it('REQ-MAIL-002 AC 5: a successful follow-up tick after a prior failure DOES advance the stamp', async () => {
    // First tick: Resend throws. Second tick (same user still matching
    // the window, last_emailed_local_date still null): Resend OK.
    // The second tick MUST stamp the date so a third tick no-ops.
    const calls1: SqlCall[] = [];
    const db1 = makeDb({
      distinctTzs: [{ tz: 'UTC' }],
      usersByTz: {
        UTC: [
          { id: 'u-retry', email: 'retry@x.com', gh_login: 'retry',
            tz: 'UTC', digest_hour: 14, digest_minute: 0, hashtags_json: null, last_emailed_local_date: null},
        ],
      },
      calls: calls1,
    });
    const fetch1 = makeFetch({ 'retry@x.com': { kind: 'throw' } });
    await dispatchDailyEmails(makeEnv(db1, fetch1.fetch) as Env);
    const stamped1 = calls1.filter(
      (c) => c.sql.includes('UPDATE users SET last_emailed_local_date'),
    );
    expect(stamped1).toHaveLength(0);  // First tick failed → no stamp.

    // Second tick, success.
    const calls2: SqlCall[] = [];
    const db2 = makeDb({
      distinctTzs: [{ tz: 'UTC' }],
      usersByTz: {
        UTC: [
          { id: 'u-retry', email: 'retry@x.com', gh_login: 'retry',
            tz: 'UTC', digest_hour: 14, digest_minute: 0, hashtags_json: null, last_emailed_local_date: null},
        ],
      },
      calls: calls2,
    });
    const fetch2 = makeFetch({ 'retry@x.com': { kind: 'ok' } });
    await dispatchDailyEmails(makeEnv(db2, fetch2.fetch) as Env);
    const stamped2 = calls2.filter(
      (c) => c.sql.includes('UPDATE users SET last_emailed_local_date') && c.verb === 'run',
    );
    expect(stamped2).toHaveLength(1);
    expect(stamped2[0]!.params[1]).toBe('u-retry');
  });
});
