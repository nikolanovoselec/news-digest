// Tests for src/pages/api/auth/refresh.ts — REQ-AUTH-002 AC 5,
// REQ-AUTH-008 AC 4.
//
// The endpoint exists for two cases that the inline-refresh middleware
// path can't cover:
//   1. XHR-from-an-expired-page: a long-running tab whose access JWT
//      has lapsed wants to deterministically mint a fresh one before
//      issuing a state-changing POST.
//   2. Test surface: a stable, callable handler for end-to-end
//      verification of the refresh-token rotation contract.
//
// Coverage targets in this file:
//   - Force-rotate semantics (success path always rotates, regardless
//     of remaining access-JWT lifetime).
//   - Cookie-clearing on every 401 (both __Host- access AND refresh
//     cookies cleared via two distinct Set-Cookie headers, never
//     collapsed to one).
//   - Outside-window replay → reuse-detection revokes the user's
//     entire refresh family + bumps session_version.
//   - Origin-check (REQ-AUTH-003) — foreign Origin → 403.
//   - Tier-1 IP rate limit — exhausted bucket → 429 + Retry-After.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, applyD1Migrations } from '../fixtures/cloudflare-test';
import { POST } from '~/pages/api/auth/refresh';
import {
  REFRESH_TOKEN_COOKIE_NAME,
  ROTATION_GRACE_SECONDS,
  buildRefreshCookie,
  findRefreshToken,
  issueRefreshToken,
  revokeRefreshToken,
} from '~/lib/refresh-tokens';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';

const APP_URL = 'https://news-digest.example.com';
const APP_ORIGIN = 'https://news-digest.example.com';
const JWT_SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';
const USER_ID = 'rt-endpoint-user-001';

async function seedUser(): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO users (id, email, gh_login, tz, digest_hour, digest_minute,
                          email_enabled, session_version, created_at)
       VALUES (?1, ?2, ?3, 'UTC', 8, 0, 1, 7, 1700000000)
       ON CONFLICT(id) DO UPDATE SET session_version = 7, email = ?2, gh_login = ?3`,
    )
    .bind(USER_ID, 'rt-endpoint@example.com', 'rt-endpoint')
    .run();
}

/** Build a Request that carries the project-required headers
 *  (Origin, Cookie, optional CF-Connecting-IP). */
function refreshRequest(opts: {
  origin?: string | null;
  refresh?: string | null;
  ua?: string;
  country?: string;
  ip?: string;
} = {}): Request {
  const headers = new Headers();
  if (opts.origin !== null && opts.origin !== undefined) {
    headers.set('Origin', opts.origin);
  }
  if (opts.refresh !== null && opts.refresh !== undefined) {
    headers.set('Cookie', `${REFRESH_TOKEN_COOKIE_NAME}=${opts.refresh}`);
  }
  if (opts.ua !== undefined) headers.set('User-Agent', opts.ua);
  if (opts.country !== undefined) headers.set('Cf-IPCountry', opts.country);
  if (opts.ip !== undefined) headers.set('CF-Connecting-IP', opts.ip);
  return new Request(`${APP_URL}/api/auth/refresh`, {
    method: 'POST',
    headers,
  });
}

function makeContext(request: Request): unknown {
  return {
    request,
    locals: {
      runtime: {
        env: {
          ...env,
          APP_URL,
          OAUTH_JWT_SECRET: JWT_SECRET,
        } as unknown as Env,
      },
    },
    url: new URL(request.url),
  };
}

/** Collect every Set-Cookie value from a Response. */
function setCookiesOf(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const raw = h.get('Set-Cookie');
  return raw === null ? [] : [raw];
}

describe('POST /api/auth/refresh — REQ-AUTH-002 AC 5', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.DB_MIGRATIONS ?? []);
  });

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM refresh_tokens');
    await env.DB.exec(`DELETE FROM users WHERE id = '${USER_ID}'`);
    await seedUser();
    // Wipe rate-limit counters so successive tests don't trip the bucket.
    if (env.KV !== undefined) {
      const keys = await env.KV.list({ prefix: 'ratelimit:' });
      for (const k of keys.keys) {
        await env.KV.delete(k.name);
      }
    }
  });

  it('REQ-AUTH-002 AC 5: 401 + clears BOTH cookies when no refresh cookie is present', async () => {
    // No Cookie header at all — the most common 401 path. Both
    // __Host-news_digest_session AND __Host-news_digest_refresh must
    // be cleared via two SEPARATE Set-Cookie headers so a UA that
    // honours only the first never leaves a stale cookie behind.
    const req = refreshRequest({ origin: APP_ORIGIN, ua: 'Mozilla/5.0', country: 'CH', ip: '203.0.113.1' });
    const res = await POST(makeContext(req) as never);

    expect(res.status).toBe(401);
    const cookies = setCookiesOf(res);
    const sessionClear = cookies.find(
      (c) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && c.includes('Max-Age=0'),
    );
    const refreshClear = cookies.find(
      (c) => c.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`) && c.includes('Max-Age=0'),
    );
    expect(sessionClear).toBeDefined();
    expect(refreshClear).toBeDefined();
    // Two DISTINCT Set-Cookie headers, never collapsed to one comma-
    // joined value. RFC 6265 forbids comma-joined cookie values, but
    // older fetch shims have collapsed them historically — pin the
    // count so a regression is loud.
    expect(cookies.filter((c) => c.includes('Max-Age=0')).length).toBeGreaterThanOrEqual(2);
  });

  it('REQ-AUTH-002 AC 5: 401 + clears both cookies when the refresh cookie does not match any row', async () => {
    const req = refreshRequest({
      origin: APP_ORIGIN,
      refresh: 'not_a_real_refresh_value_for_any_row',
      ua: 'Mozilla/5.0',
      country: 'CH',
      ip: '203.0.113.2',
    });
    const res = await POST(makeContext(req) as never);

    expect(res.status).toBe(401);
    const cookies = setCookiesOf(res);
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))).toBe(true);
  });

  it('REQ-AUTH-002 AC 5: force-rotates on a valid refresh cookie — old row revoked, new row issued, fresh access cookie returned', async () => {
    const issueReq = new Request('https://example.com/', {
      headers: new Headers({ 'User-Agent': 'Mozilla/5.0', 'Cf-IPCountry': 'CH' }),
    });
    const { value: oldValue, id: oldId } = await issueRefreshToken(
      env.DB,
      USER_ID,
      issueReq,
    );

    const req = refreshRequest({
      origin: APP_ORIGIN,
      refresh: oldValue,
      ua: 'Mozilla/5.0',
      country: 'CH',
      ip: '203.0.113.3',
    });
    const res = await POST(makeContext(req) as never);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; rotated: boolean };
    expect(body).toMatchObject({ ok: true, rotated: true });

    const cookies = setCookiesOf(res);
    // Fresh access JWT cookie set.
    expect(
      cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && !c.includes('Max-Age=0')),
    ).toBeDefined();
    // New refresh cookie set, NOT a clear.
    const newRefresh = cookies.find(
      (c) => c.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`) && !c.includes('Max-Age=0'),
    );
    expect(newRefresh).toBeDefined();
    // The new value must differ from the old one — force-rotate
    // semantics, not a no-op refresh.
    expect(newRefresh).not.toContain(`${REFRESH_TOKEN_COOKIE_NAME}=${oldValue}`);

    // The old row is now revoked in the DB.
    const oldRow = await findRefreshToken(env.DB, oldValue);
    expect(oldRow).not.toBeNull();
    expect(oldRow!.revoked_at).not.toBeNull();
    expect(oldRow!.id).toBe(oldId);
  });

  it('REQ-AUTH-008 AC 4: outside-window replay of a revoked cookie triggers reuse-detection — 401 + cookies cleared + session_version bumped', async () => {
    const issueReq = new Request('https://example.com/', {
      headers: new Headers({ 'User-Agent': 'Mozilla/5.0', 'Cf-IPCountry': 'CH' }),
    });
    const { value, id } = await issueRefreshToken(env.DB, USER_ID, issueReq);

    // Pre-revoke the row well outside the 30-second grace window.
    const wayBefore = Math.floor(Date.now() / 1000) - (ROTATION_GRACE_SECONDS + 60);
    await revokeRefreshToken(env.DB, id, wayBefore);

    const beforeSv = await env.DB
      .prepare('SELECT session_version FROM users WHERE id = ?1')
      .bind(USER_ID)
      .first<{ session_version: number }>();
    expect(beforeSv?.session_version).toBe(7);

    const req = refreshRequest({
      origin: APP_ORIGIN,
      refresh: value,
      ua: 'Mozilla/5.0',
      country: 'CH',
      ip: '203.0.113.4',
    });
    const res = await POST(makeContext(req) as never);

    expect(res.status).toBe(401);
    const cookies = setCookiesOf(res);
    expect(
      cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && c.includes('Max-Age=0')),
    ).toBeDefined();
    expect(
      cookies.find((c) => c.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`) && c.includes('Max-Age=0')),
    ).toBeDefined();

    // Reuse-detection must have bumped session_version so any in-
    // flight access JWT minted before the theft is killed.
    const afterSv = await env.DB
      .prepare('SELECT session_version FROM users WHERE id = ?1')
      .bind(USER_ID)
      .first<{ session_version: number }>();
    expect(afterSv?.session_version).toBeGreaterThan(7);
  });

  it('REQ-AUTH-003: rejects POST with a foreign Origin header', async () => {
    const issueReq = new Request('https://example.com/', {
      headers: new Headers({ 'User-Agent': 'Mozilla/5.0', 'Cf-IPCountry': 'CH' }),
    });
    const { value } = await issueRefreshToken(env.DB, USER_ID, issueReq);

    const req = refreshRequest({
      origin: 'https://attacker.example.com',
      refresh: value,
      ua: 'Mozilla/5.0',
      country: 'CH',
      ip: '203.0.113.5',
    });
    const res = await POST(makeContext(req) as never);
    expect(res.status).toBe(403);

    // Critical: the foreign-origin path must NOT have rotated the row,
    // otherwise CSRF could burn rotations against the legitimate user.
    const stillValid = await findRefreshToken(env.DB, value);
    expect(stillValid).not.toBeNull();
    expect(stillValid!.revoked_at).toBeNull();
  });

  it('REQ-AUTH-001 AC 9 / REQ-AUTH-002 AC 5: returns 429 with Retry-After when the AUTH_REFRESH_IP bucket is exhausted', async () => {
    if (env.KV === undefined) {
      // The miniflare setup always provides KV; guard so the typecheck
      // doesn't trip over the optional binding.
      return;
    }
    // Pre-load the IP-keyed bucket to its 60/min ceiling so the first
    // call already trips the limiter — the limit fires BEFORE the DB
    // lookup, so we don't need a real refresh value to provoke the 429.
    const ip = '203.0.113.99';
    const nowSec = Math.floor(Date.now() / 1000);
    const windowSec = 60;
    const windowIndex = Math.floor(nowSec / windowSec);
    await env.KV.put(
      `ratelimit:auth_refresh_ip:ip:${ip}:${windowIndex}`,
      '60',
    );

    const req = refreshRequest({
      origin: APP_ORIGIN,
      refresh: 'irrelevant_we_short_circuit_before_db',
      ua: 'Mozilla/5.0',
      country: 'CH',
      ip,
    });
    const res = await POST(makeContext(req) as never);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).not.toBeNull();
  });
});
