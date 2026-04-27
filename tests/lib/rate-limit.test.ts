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
