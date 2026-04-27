// Tests for src/lib/rate-limit.ts — CF-028 (KV-backed application-layer
// rate limiter for /api/auth/* and mutation endpoints).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  enforceRateLimit,
  rateLimitResponse,
  clientIp,
  RATE_LIMIT_RULES,
} from '~/lib/rate-limit';

interface FakeKv {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
}

function makeKv(overrides: Partial<FakeKv> = {}): { KV: FakeKv } {
  const get = vi.fn().mockResolvedValue(null);
  const put = vi.fn().mockResolvedValue(undefined);
  const kv: FakeKv = { get, put, ...overrides };
  return { KV: kv };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('enforceRateLimit', () => {
  it('CF-028: allows the first request in a window', async () => {
    const env = makeKv();
    const result = await enforceRateLimit(
      env as unknown as { KV: KVNamespace },
      RATE_LIMIT_RULES.AUTH_LOGIN,
      'ip:1.2.3.4',
    );
    expect(result.ok).toBe(true);
    expect(env.KV.put).toHaveBeenCalledTimes(1);
  });

  it('CF-028: rejects when the existing counter is at the limit', async () => {
    const env = makeKv({
      get: vi.fn().mockResolvedValue(String(RATE_LIMIT_RULES.AUTH_LOGIN.limit)),
    });
    const result = await enforceRateLimit(
      env as unknown as { KV: KVNamespace },
      RATE_LIMIT_RULES.AUTH_LOGIN,
      'ip:1.2.3.4',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.retryAfter).toBeLessThanOrEqual(
        RATE_LIMIT_RULES.AUTH_LOGIN.windowSec,
      );
    }
  });

  it('CF-028: keys the counter by route_class + identity + window', async () => {
    const env = makeKv();
    await enforceRateLimit(
      env as unknown as { KV: KVNamespace },
      RATE_LIMIT_RULES.AUTH_LOGIN,
      'ip:1.2.3.4',
    );
    expect(env.KV.get).toHaveBeenCalledTimes(1);
    const key = env.KV.get.mock.calls[0]![0];
    expect(key).toMatch(/^ratelimit:auth_login:ip:1\.2\.3\.4:\d+$/);
  });

  it('CF-028: increments the counter by 1', async () => {
    const env = makeKv({ get: vi.fn().mockResolvedValue('3') });
    await enforceRateLimit(
      env as unknown as { KV: KVNamespace },
      RATE_LIMIT_RULES.AUTH_LOGIN,
      'ip:1.2.3.4',
    );
    expect(env.KV.put).toHaveBeenCalledWith(
      expect.stringMatching(/^ratelimit:auth_login:/),
      '4',
      expect.objectContaining({
        expirationTtl: RATE_LIMIT_RULES.AUTH_LOGIN.windowSec * 2,
      }),
    );
  });

  it('CF-028: fails open on KV.get error (broken counter must not lock users out)', async () => {
    const env = makeKv({ get: vi.fn().mockRejectedValue(new Error('kv down')) });
    const result = await enforceRateLimit(
      env as unknown as { KV: KVNamespace },
      RATE_LIMIT_RULES.AUTH_LOGIN,
      'ip:1.2.3.4',
    );
    expect(result.ok).toBe(true);
  });

  it('REQ-AUTH-001 AC 9: fails CLOSED on KV.get error for a failClosed:true rule', async () => {
    const env = makeKv({ get: vi.fn().mockRejectedValue(new Error('kv down')) });
    const result = await enforceRateLimit(
      env as unknown as { KV: KVNamespace },
      RATE_LIMIT_RULES.AUTH_REFRESH_IP,
      'ip:1.2.3.4',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Retry-After is the full window length so the client backs off
    // for at least one full window before retrying.
    expect(result.retryAfter).toBe(RATE_LIMIT_RULES.AUTH_REFRESH_IP.windowSec);
  });

  it('REQ-AUTH-001 AC 9: AUTH_REFRESH_USER also fails closed on KV outage', async () => {
    const env = makeKv({ get: vi.fn().mockRejectedValue(new Error('kv down')) });
    const result = await enforceRateLimit(
      env as unknown as { KV: KVNamespace },
      RATE_LIMIT_RULES.AUTH_REFRESH_USER,
      'user:abc-123',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryAfter).toBe(RATE_LIMIT_RULES.AUTH_REFRESH_USER.windowSec);
  });

  it('REQ-AUTH-001 AC 9: failClosed rule denies on KV.put error too (write outage cannot bypass the limit)', async () => {
    // KV.get succeeds (returns null = counter at 0), but KV.put rejects.
    // For a failClosed rule the helper must deny, otherwise a sustained
    // KV write outage means the counter never ticks up and the limit
    // is effectively gone.
    const env = makeKv({
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockRejectedValue(new Error('kv put down')),
    });
    const result = await enforceRateLimit(
      env as unknown as { KV: KVNamespace },
      RATE_LIMIT_RULES.AUTH_REFRESH_IP,
      'ip:1.2.3.4',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryAfter).toBe(RATE_LIMIT_RULES.AUTH_REFRESH_IP.windowSec);
  });

  it('REQ-AUTH-001 AC 9: KV.put error on a fail-open rule still permits the request (preserves prior behavior)', async () => {
    const env = makeKv({
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockRejectedValue(new Error('kv put down')),
    });
    const result = await enforceRateLimit(
      env as unknown as { KV: KVNamespace },
      RATE_LIMIT_RULES.AUTH_LOGIN,
      'ip:1.2.3.4',
    );
    expect(result.ok).toBe(true);
  });
});

describe('rateLimitResponse', () => {
  it('CF-028: returns 429 with Retry-After header', () => {
    const res = rateLimitResponse(42);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
  });

  it('CF-028: clamps Retry-After to >= 1', () => {
    const res = rateLimitResponse(0);
    expect(res.headers.get('Retry-After')).toBe('1');
  });
});

describe('clientIp', () => {
  it('CF-028: prefers the CF-Connecting-IP header', () => {
    const req = new Request('https://example.com', {
      headers: { 'CF-Connecting-IP': '203.0.113.1' },
    });
    expect(clientIp(req)).toBe('203.0.113.1');
  });

  it('CF-028: falls back to "unknown" when the header is missing', () => {
    const req = new Request('https://example.com');
    expect(clientIp(req)).toBe('unknown');
  });
});
