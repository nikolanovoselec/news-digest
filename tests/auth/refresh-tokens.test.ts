// Integration tests for src/lib/refresh-tokens.ts and the inline
// refresh flow in src/middleware/auth.ts — REQ-AUTH-002, REQ-AUTH-008.
//
// Uses @cloudflare/vitest-pool-workers + miniflare-backed D1 because
// the refresh path does INSERT/UPDATE on `refresh_tokens` and a unit
// mock of D1 cannot exercise the `WHERE token_hash = ?` lookup or the
// rotation batch.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, applyD1Migrations } from '../fixtures/cloudflare-test';
import {
  REFRESH_TOKEN_COOKIE_NAME,
  buildRefreshCookie,
  deviceFingerprint,
  findRefreshToken,
  issueRefreshToken,
  purgeOldRefreshTokens,
  revokeAllForUser,
  revokeRefreshToken,
  rotateRefreshToken,
} from '~/lib/refresh-tokens';
import { loadSession, SESSION_COOKIE_NAME } from '~/middleware/auth';
import { signSession } from '~/lib/session-jwt';

const SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';
const USER_ID = 'rt-user-001';

async function seedUser(): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO users (id, email, gh_login, tz, digest_hour, digest_minute, email_enabled, session_version, created_at)
       VALUES (?1, ?2, ?3, 'UTC', 8, 0, 1, 1, 1700000000)
       ON CONFLICT(id) DO UPDATE SET session_version = 1`,
    )
    .bind(USER_ID, 'rt@example.com', 'rt-login')
    .run();
}

function fakeRequest(opts: {
  ua?: string;
  country?: string;
  cookie?: string;
} = {}): Request {
  const headers = new Headers();
  if (opts.ua !== undefined) headers.set('User-Agent', opts.ua);
  if (opts.country !== undefined) headers.set('Cf-IPCountry', opts.country);
  if (opts.cookie !== undefined) headers.set('Cookie', opts.cookie);
  return new Request('https://example.com/', { headers });
}

describe('refresh-tokens — REQ-AUTH-008', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.DB_MIGRATIONS ?? []);
  });

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM refresh_tokens');
    await env.DB.exec("DELETE FROM users WHERE id = 'rt-user-001'");
    await seedUser();
  });

  it('REQ-AUTH-008 AC 1: issueRefreshToken stores fingerprint hash, not raw value', async () => {
    const req = fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' });
    const { value } = await issueRefreshToken(env.DB, USER_ID, req);
    expect(value.length).toBeGreaterThan(40);

    const row = await findRefreshToken(env.DB, value);
    expect(row).not.toBeNull();
    expect(row!.user_id).toBe(USER_ID);
    expect(row!.revoked_at).toBeNull();
    expect(row!.parent_id).toBeNull();
    // Fingerprint is a hash, not the raw header value.
    expect(row!.device_fingerprint_hash).not.toContain('Mozilla');
    expect(row!.device_fingerprint_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('REQ-AUTH-008 AC 1: deviceFingerprint differs across UA and country', async () => {
    const a = await deviceFingerprint(fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' }));
    const b = await deviceFingerprint(fakeRequest({ ua: 'Mozilla/5.0', country: 'US' }));
    const c = await deviceFingerprint(fakeRequest({ ua: 'curl/8.0', country: 'CH' }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it('REQ-AUTH-008 AC 2: rotateRefreshToken marks old row revoked and links parent_id', async () => {
    const req = fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' });
    const { value: oldValue, id: oldId } = await issueRefreshToken(env.DB, USER_ID, req);
    const oldRow = await findRefreshToken(env.DB, oldValue);
    expect(oldRow).not.toBeNull();

    const rotated = await rotateRefreshToken(env.DB, oldRow!, req);
    expect(rotated.value).not.toBe(oldValue);

    const reloadedOld = await findRefreshToken(env.DB, oldValue);
    expect(reloadedOld!.revoked_at).not.toBeNull();

    const newRow = await findRefreshToken(env.DB, rotated.value);
    expect(newRow!.parent_id).toBe(oldId);
    expect(newRow!.rotation_count).toBe(1);
    expect(newRow!.revoked_at).toBeNull();
  });

  it('REQ-AUTH-008 AC 4: revokeAllForUser bumps session_version', async () => {
    const req = fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' });
    const { value } = await issueRefreshToken(env.DB, USER_ID, req);

    const before = await env.DB
      .prepare('SELECT session_version FROM users WHERE id = ?1')
      .bind(USER_ID)
      .first<{ session_version: number }>();

    await revokeAllForUser(env.DB, USER_ID);

    const after = await env.DB
      .prepare('SELECT session_version FROM users WHERE id = ?1')
      .bind(USER_ID)
      .first<{ session_version: number }>();

    expect(after!.session_version).toBe(before!.session_version + 1);

    const row = await findRefreshToken(env.DB, value);
    expect(row!.revoked_at).not.toBeNull();
  });

  it('REQ-AUTH-008 AC 5: purgeOldRefreshTokens deletes expired rows', async () => {
    // Issue a token, then mark its expires_at to the past.
    const req = fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' });
    const { value } = await issueRefreshToken(env.DB, USER_ID, req);
    await env.DB
      .prepare('UPDATE refresh_tokens SET expires_at = 1 WHERE token_hash IN (SELECT token_hash FROM refresh_tokens WHERE user_id = ?1)')
      .bind(USER_ID)
      .run();

    const purged = await purgeOldRefreshTokens(env.DB);
    expect(purged).toBeGreaterThanOrEqual(1);

    const reloaded = await findRefreshToken(env.DB, value);
    expect(reloaded).toBeNull();
  });

  it('REQ-AUTH-008 AC 5: purgeOldRefreshTokens preserves recently revoked rows for the grace window', async () => {
    const req = fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' });
    const { value, id } = await issueRefreshToken(env.DB, USER_ID, req);
    await revokeRefreshToken(env.DB, id);
    // Fresh revocation, far-future expiry — must NOT be purged.
    await purgeOldRefreshTokens(env.DB);
    const reloaded = await findRefreshToken(env.DB, value);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.revoked_at).not.toBeNull();
  });
});

describe('loadSession — refresh-token flow — REQ-AUTH-002, REQ-AUTH-008', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.DB_MIGRATIONS ?? []);
  });

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM refresh_tokens');
    await env.DB.exec("DELETE FROM users WHERE id = 'rt-user-001'");
    await seedUser();
  });

  it('REQ-AUTH-002: rotates and returns user when access cookie is missing but refresh cookie is valid', async () => {
    const issueReq = fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' });
    const { value } = await issueRefreshToken(env.DB, USER_ID, issueReq);

    // Now request with NO access cookie, only the refresh cookie.
    const req = fakeRequest({
      ua: 'Mozilla/5.0',
      country: 'CH',
      cookie: `${REFRESH_TOKEN_COOKIE_NAME}=${value}`,
    });
    const result = await loadSession(req, env.DB, SECRET);
    expect(result).not.toBeNull();
    expect(result!.user.id).toBe(USER_ID);
    expect(result!.cookiesToSet.length).toBe(2);
    expect(result!.cookiesToSet[0]).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(result!.cookiesToSet[1]).toContain(`${REFRESH_TOKEN_COOKIE_NAME}=`);

    // The old refresh-token row must be revoked.
    const oldRow = await findRefreshToken(env.DB, value);
    expect(oldRow!.revoked_at).not.toBeNull();
  });

  it('REQ-AUTH-008 AC 1: rejects refresh when device fingerprint changed', async () => {
    const issueReq = fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' });
    const { value } = await issueRefreshToken(env.DB, USER_ID, issueReq);

    // Same cookie but different country — fingerprint mismatch.
    const req = fakeRequest({
      ua: 'Mozilla/5.0',
      country: 'US',
      cookie: `${REFRESH_TOKEN_COOKIE_NAME}=${value}`,
    });
    const result = await loadSession(req, env.DB, SECRET);
    expect(result).toBeNull();

    // Row must NOT be marked revoked (other devices can still use their
    // own refresh tokens — only THIS device-mismatched attempt is rejected).
    const row = await findRefreshToken(env.DB, value);
    expect(row!.revoked_at).toBeNull();
  });

  it('REQ-AUTH-008 AC 4: reuse-detected token revokes ALL refresh rows for the user', async () => {
    const req1 = fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' });
    const { value: oldValue } = await issueRefreshToken(env.DB, USER_ID, req1);
    // Issue a SECOND token (e.g., a different device the user owns).
    const { value: otherValue } = await issueRefreshToken(env.DB, USER_ID, req1);

    // Manually revoke the old row to simulate a successful rotation
    // having already happened.
    const oldRow = await findRefreshToken(env.DB, oldValue);
    await rotateRefreshToken(env.DB, oldRow!, req1);

    // Attacker (or replay) presents the now-revoked old cookie.
    const replayReq = fakeRequest({
      ua: 'Mozilla/5.0',
      country: 'CH',
      cookie: `${REFRESH_TOKEN_COOKIE_NAME}=${oldValue}`,
    });
    const result = await loadSession(replayReq, env.DB, SECRET);
    expect(result).toBeNull();

    // Reuse detection — every refresh row for the user is now revoked,
    // including the second device's row.
    const otherRow = await findRefreshToken(env.DB, otherValue);
    expect(otherRow!.revoked_at).not.toBeNull();

    const sv = await env.DB
      .prepare('SELECT session_version FROM users WHERE id = ?1')
      .bind(USER_ID)
      .first<{ session_version: number }>();
    expect(sv!.session_version).toBeGreaterThan(1);
  });

  it('REQ-AUTH-002: empty cookiesToSet on a valid access JWT (no refresh-token DB hit)', async () => {
    const access = await signSession(
      { sub: USER_ID, email: 'rt@example.com', ghl: 'rt-login', sv: 1 },
      SECRET,
      300,
    );
    const req = fakeRequest({
      ua: 'Mozilla/5.0',
      country: 'CH',
      cookie: `${SESSION_COOKIE_NAME}=${access}`,
    });
    const result = await loadSession(req, env.DB, SECRET);
    expect(result).not.toBeNull();
    expect(result!.cookiesToSet).toEqual([]);
  });
});
