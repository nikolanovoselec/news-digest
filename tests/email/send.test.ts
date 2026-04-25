// Tests for src/lib/email.ts `sendEmail` — REQ-MAIL-001 transport contract.
//
// Verifies that non-2xx responses, thrown fetch errors, and timeouts all
// resolve to a structured result and NEVER re-throw, and that every failure
// path emits a `email.send.failed` structured log.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendEmail, type SendEmailParams } from '~/lib/email';

function makeParams(overrides: Partial<SendEmailParams> = {}): SendEmailParams {
  return {
    to: 'alice@example.com',
    subject: 'Your news digest is ready',
    text: 'Your news digest is ready.\n\nView it here: https://news-digest.example.com/digest',
    html: '<p>Your news digest is ready.</p>',
    ...overrides,
  };
}

function makeEnv(): Env {
  return {
    RESEND_API_KEY: 're_test_key_123',
    RESEND_FROM: 'News Digest <digest@example.com>',
    APP_URL: 'https://news-digest.example.com',
  } as unknown as Env;
}

/** Parse the single most-recent console.log call that emitted JSON matching
 * the given `event`. Returns null if no such record exists. */
function findLogRecord(
  spy: ReturnType<typeof vi.spyOn>,
  event: string,
): Record<string, unknown> | null {
  for (const call of spy.mock.calls) {
    const raw = call[0];
    if (typeof raw !== 'string') continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.event === event) return parsed;
    } catch {
      // ignore non-JSON stdout
    }
  }
  return null;
}

describe('sendEmail — REQ-MAIL-001', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    consoleSpy.mockRestore();
  });

  it('REQ-MAIL-001: returns { sent: true } on 2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'resend-msg-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendEmail(makeEnv(), makeParams());
    expect(result).toEqual({ sent: true });
  });

  it('REQ-MAIL-001: accepts any 2xx status code (201, 202, 204)', async () => {
    for (const status of [200, 201, 202, 204]) {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(status === 204 ? null : '{}', { status }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const result = await sendEmail(makeEnv(), makeParams());
      expect(result.sent).toBe(true);
    }
  });

  it('REQ-MAIL-001: non-2xx response returns { sent: false, error_code: "resend_non_2xx" }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":"invalid"}', { status: 400 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendEmail(makeEnv(), makeParams());
    expect(result).toEqual({ sent: false, error_code: 'resend_non_2xx' });
  });

  it('REQ-MAIL-001: non-2xx response logs email.send.failed with status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('nope', { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await sendEmail(makeEnv(), makeParams({ to: 'a@b.com' }));

    const record = findLogRecord(consoleSpy, 'email.send.failed');
    expect(record).not.toBeNull();
    expect(record?.level).toBe('error');
    expect(record?.status).toBe(403);
    expect(record?.to).toBe('a@b.com');
  });

  it('REQ-MAIL-001: 5xx response returns error result and does not throw', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('server error', { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendEmail(makeEnv(), makeParams());
    expect(result).toEqual({ sent: false, error_code: 'resend_non_2xx' });
  });

  it('REQ-MAIL-001: thrown fetch error returns { sent: false, error_code: "resend_error" }', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendEmail(makeEnv(), makeParams());
    expect(result).toEqual({ sent: false, error_code: 'resend_error' });
  });

  it('REQ-MAIL-001: thrown fetch error logs email.send.failed', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
    vi.stubGlobal('fetch', fetchMock);

    await sendEmail(makeEnv(), makeParams({ to: 'x@y.com' }));

    const record = findLogRecord(consoleSpy, 'email.send.failed');
    expect(record).not.toBeNull();
    expect(record?.level).toBe('error');
    expect(record?.to).toBe('x@y.com');
  });

  it('REQ-MAIL-001: AbortError (timeout) returns error result without throwing', async () => {
    const abortError = new DOMException(
      'The operation was aborted.',
      'AbortError',
    );
    const fetchMock = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendEmail(makeEnv(), makeParams());
    expect(result).toEqual({ sent: false, error_code: 'resend_error' });
  });

  it('REQ-MAIL-001: never re-throws on any error path', async () => {
    const scenarios: Array<() => ReturnType<typeof vi.fn>> = [
      () => vi.fn().mockRejectedValue(new Error('net')),
      () => vi.fn().mockRejectedValue('string error'),
      () => vi.fn().mockRejectedValue(null),
      () => vi.fn().mockResolvedValue(new Response('x', { status: 500 })),
      () => vi.fn().mockResolvedValue(new Response('x', { status: 400 })),
    ];
    for (const build of scenarios) {
      vi.stubGlobal('fetch', build());
      await expect(sendEmail(makeEnv(), makeParams())).resolves.toBeDefined();
    }
  });

  it('REQ-MAIL-001: configures an AbortSignal on the request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await sendEmail(makeEnv(), makeParams());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init).toBeDefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  // Fork-friendliness: when Resend isn't configured (a fork that wants
  // the in-app digest only), sendEmail must short-circuit cleanly with
  // `resend_not_configured`, log once for operator visibility, and
  // never issue an HTTP request that would 401 against an empty
  // Bearer token.
  describe('REQ-MAIL-001: resend_not_configured short-circuit', () => {
    function envWith(overrides: Partial<Env>): Env {
      return {
        APP_URL: 'https://news-digest.example.com',
        ...overrides,
      } as unknown as Env;
    }

    const cases: Array<{
      name: string;
      env: Env;
    }> = [
      {
        name: 'both keys missing',
        env: envWith({}),
      },
      {
        name: 'RESEND_API_KEY missing, RESEND_FROM set',
        env: envWith({
          RESEND_FROM: 'News Digest <digest@example.com>',
        } as unknown as Partial<Env>),
      },
      {
        name: 'RESEND_API_KEY set, RESEND_FROM missing',
        env: envWith({
          RESEND_API_KEY: 're_test_key_123',
        } as unknown as Partial<Env>),
      },
      {
        name: 'both keys empty strings',
        env: envWith({
          RESEND_API_KEY: '',
          RESEND_FROM: '',
        } as unknown as Partial<Env>),
      },
    ];

    for (const tc of cases) {
      it(`REQ-MAIL-001: ${tc.name} → no fetch + clean result + log breadcrumb`, async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const result = await sendEmail(tc.env, makeParams());

        expect(result).toEqual({
          sent: false,
          error_code: 'resend_not_configured',
        });
        expect(fetchMock).not.toHaveBeenCalled();

        // Operator-visible breadcrumb: a fork operator who forgot to
        // set the secrets sees this in `wrangler tail` instead of
        // silent no-ops.
        const logged = findLogRecord(consoleSpy, 'email.send.failed');
        expect(logged).not.toBeNull();
        expect(logged?.error).toBe('resend_not_configured');
      });
    }
  });
});
