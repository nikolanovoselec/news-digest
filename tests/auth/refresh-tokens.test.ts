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

  it('REQ-AUTH-008 AC 1: deviceFingerprint records UA + country as forensic metadata', async () => {
    // As of 2026-04-28 the fingerprint is metadata only — the
    // middleware no longer rejects a refresh on hash mismatch. We
    // still record UA + country so a future anomaly-detection layer
    // has the data to work with. Pin only that the function produces
    // distinct hashes for distinct inputs (so the recorded data is
    // actually distinguishable downstream) and that the persisted
    // value is a hex SHA-256, not a raw header.
    const a = await deviceFingerprint(fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' }));
    const b = await deviceFingerprint(fakeRequest({ ua: 'Mozilla/5.0', country: 'US' }));
    const c = await deviceFingerprint(fakeRequest({ ua: 'curl/8.0', country: 'CH' }));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('REQ-AUTH-008 AC 2: rotateRefreshToken marks old row revoked and links parent_id', async () => {
    const req = fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' });
    const { value: oldValue, id: oldId } = await issueRefreshToken(env.DB, USER_ID, req);
    const oldRow = await findRefreshToken(env.DB, oldValue);
    expect(oldRow).not.toBeNull();

    const rotated = await rotateRefreshToken(env.DB, oldRow!, req);
    expect(rotated).not.toBeNull();
    expect(rotated!.value).not.toBe(oldValue);
    // The row id is a separate random identifier, NOT the cookie value.
    expect(rotated!.id).not.toBe(rotated!.value);
    expect(rotated!.id).not.toBe(oldId);

    const reloadedOld = await findRefreshToken(env.DB, oldValue);
    expect(reloadedOld!.revoked_at).not.toBeNull();

    const newRow = await findRefreshToken(env.DB, rotated!.value);
    expect(newRow!.parent_id).toBe(oldId);
    expect(newRow!.rotation_count).toBe(1);
    expect(newRow!.revoked_at).toBeNull();
  });

  it('REQ-AUTH-008 AC 2: rotateRefreshToken returns null on concurrent rotation, no orphan child created', async () => {
    // Simulate two callers both holding the same refresh row in memory.
    const req = fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' });
    const { value, id: parentId } = await issueRefreshToken(env.DB, USER_ID, req);
    const rowA = await findRefreshToken(env.DB, value);
    const rowB = await findRefreshToken(env.DB, value);
    expect(rowA).not.toBeNull();
    expect(rowB).not.toBeNull();

    // Both rotations called with the SAME `now` so the same-second
    // collision case is exercised — the predicate must still produce
    // exactly one child.
    const sameNow = Math.floor(Date.now() / 1000);
    const winner = await rotateRefreshToken(env.DB, rowA!, req, sameNow);
    expect(winner).not.toBeNull();

    const loser = await rotateRefreshToken(env.DB, rowB!, req, sameNow);
    expect(loser).toBeNull();

    // Exactly one unrevoked child exists for the parent — no orphan row.
    const childCount = await env.DB
      .prepare(
        'SELECT COUNT(*) AS n FROM refresh_tokens WHERE parent_id = ?1 AND revoked_at IS NULL',
      )
      .bind(parentId)
      .first<{ n: number }>();
    expect(childCount!.n).toBe(1);
  });

  it('CodeQL js/sensitive-data-treatment: row id is not the cookie value', async () => {
    const req = fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' });
    const { value, id } = await issueRefreshToken(env.DB, USER_ID, req);
    expect(id).not.toBe(value);
    expect(id.length).toBeLessThan(value.length);
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

  it('REQ-AUTH-008 AC 4: revokeAllForUser does NOT bump session_version when no rows were revocable', async () => {
    // CF-029 — the conditional bump must fire only when the revoke
    // statement actually flipped at least one row. A dead-cookie
    // replay against revokeAllForUser otherwise re-bumps on every
    // call, churning every legitimate browser session that already
    // has a valid access JWT for this user.
    const before = await env.DB
      .prepare('SELECT session_version FROM users WHERE id = ?1')
      .bind(USER_ID)
      .first<{ session_version: number }>();

    // No tokens issued yet → no rows in `revoked_at IS NULL` state.
    await revokeAllForUser(env.DB, USER_ID);

    const after = await env.DB
      .prepare('SELECT session_version FROM users WHERE id = ?1')
      .bind(USER_ID)
      .first<{ session_version: number }>();

    expect(after!.session_version).toBe(before!.session_version);

    // Second call with NO new tokens issued → still no bump. Pin the
    // idempotency-on-replay claim from the doc-comment.
    await revokeAllForUser(env.DB, USER_ID);
    const afterReplay = await env.DB
      .prepare('SELECT session_version FROM users WHERE id = ?1')
      .bind(USER_ID)
      .first<{ session_version: number }>();
    expect(afterReplay!.session_version).toBe(before!.session_version);
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
    expect(result.user).not.toBeNull();
    expect(result.user!.id).toBe(USER_ID);
    expect(result.cookiesToSet.length).toBe(2);
    expect(result.cookiesToSet[0]).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(result.cookiesToSet[1]).toContain(`${REFRESH_TOKEN_COOKIE_NAME}=`);

    // The old refresh-token row must be revoked.
    const oldRow = await findRefreshToken(env.DB, value);
    expect(oldRow!.revoked_at).not.toBeNull();
  });

  it('REQ-AUTH-008 AC 1: steady-state refresh succeeds across UA drift, rotates row, returns both cookies', async () => {
    // The previous behavior rejected on fingerprint mismatch and locked
    // legitimate users out every time their browser auto-updated the
    // User-Agent string (RFC 9700 / OWASP / Auth0 / Okta all flag this
    // as an anti-pattern). On the steady-state path the fingerprint
    // is now metadata only. Pin the FULL new contract: user is
    // recognised, the original row is marked revoked + a child row
    // exists, and the response carries BOTH a fresh session cookie
    // and a rotated refresh cookie.
    const issueReq = fakeRequest({ ua: 'Mozilla/5.0 Chrome/130', country: 'CH' });
    const { value, id: oldId } = await issueRefreshToken(env.DB, USER_ID, issueReq);

    // Browser auto-updated to Chrome/131; user travelled to US.
    const req = fakeRequest({
      ua: 'Mozilla/5.0 Chrome/131',
      country: 'US',
      cookie: `${REFRESH_TOKEN_COOKIE_NAME}=${value}`,
    });
    const result = await loadSession(req, env.DB, SECRET);

    // User is recognised; no forced logout.
    expect(result.user).not.toBeNull();
    expect(result.user!.id).toBe(USER_ID);

    // Steady-state rotation: old row marked revoked, new child row
    // exists pointing back to the old one.
    const oldRow = await findRefreshToken(env.DB, value);
    expect(oldRow!.revoked_at).not.toBeNull();
    const childRow = await env.DB
      .prepare('SELECT id, parent_id FROM refresh_tokens WHERE parent_id = ?1')
      .bind(oldId)
      .first<{ id: string; parent_id: string }>();
    expect(childRow).not.toBeNull();
    expect(childRow!.parent_id).toBe(oldId);

    // Both cookies returned: a fresh session JWT and the rotated
    // refresh cookie. (The "lost concurrent race" branch returns ONLY
    // the session cookie — pinning two cookies here ensures we are
    // on the steady-state rotation path.)
    const cookies = result.cookiesToSet;
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`))).toBe(true);
  });

  it('REQ-AUTH-008 AC 1: grace-window fingerprint mismatch is treated as theft (gate retained)', async () => {
    // The hard fingerprint gate was retained on the 30 s grace branch
    // because real legitimate users do not change UA across two
    // parallel requests fired seconds apart — a mismatch in this
    // window is much more strongly correlated with theft. This test
    // pins that contract: replay within grace from a DIFFERENT
    // country fires the revokeAllForUser theft path.
    const issueReq = fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' });
    const { value } = await issueRefreshToken(env.DB, USER_ID, issueReq);
    const { value: otherValue } = await issueRefreshToken(env.DB, USER_ID, issueReq);

    // Rotate so the row is revoked within the grace window.
    const oldRow = await findRefreshToken(env.DB, value);
    await rotateRefreshToken(env.DB, oldRow!, issueReq);

    // Replay within grace from a different country → grace branch
    // fires the fingerprint gate → revokeAllForUser.
    const replayReq = fakeRequest({
      ua: 'Mozilla/5.0',
      country: 'US',
      cookie: `${REFRESH_TOKEN_COOKIE_NAME}=${value}`,
    });
    const result = await loadSession(replayReq, env.DB, SECRET);
    expect(result.user).toBeNull();

    // Theft response must clear BOTH cookies (Max-Age=0) so the
    // browser stops replaying the known-bad refresh value. A future
    // regression that returns `unauthenticated(false)` (no clear)
    // would still produce a null user but would silently let the
    // browser continue submitting the stolen cookie.
    expect(
      result.cookiesToSet.some(
        (c) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && c.includes('Max-Age=0'),
      ),
    ).toBe(true);
    expect(
      result.cookiesToSet.some(
        (c) => c.startsWith(`${REFRESH_TOKEN_COOKIE_NAME}=`) && c.includes('Max-Age=0'),
      ),
    ).toBe(true);

    // Other device's refresh row IS revoked (global wipe — theft path).
    const otherRow = await findRefreshToken(env.DB, otherValue);
    expect(otherRow!.revoked_at).not.toBeNull();
    const sv = await env.DB
      .prepare('SELECT session_version FROM users WHERE id = ?1')
      .bind(USER_ID)
      .first<{ session_version: number }>();
    expect(sv!.session_version).toBeGreaterThan(1);
  });

  it('REQ-AUTH-008: future revoked_at (clock skew) falls through to theft branch, never mints access JWT', async () => {
    const issueReq = fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' });
    const { value } = await issueRefreshToken(env.DB, USER_ID, issueReq);
    const { value: otherValue } = await issueRefreshToken(env.DB, USER_ID, issueReq);

    // Backdate-into-the-future: revoked_at >> now. Negative
    // `sinceRevoked` must NOT pass the grace check.
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    const row = await findRefreshToken(env.DB, value);
    await env.DB
      .prepare('UPDATE refresh_tokens SET revoked_at = ?2 WHERE id = ?1')
      .bind(row!.id, futureSec)
      .run();

    const replayReq = fakeRequest({
      ua: 'Mozilla/5.0',
      country: 'CH',
      cookie: `${REFRESH_TOKEN_COOKIE_NAME}=${value}`,
    });
    const result = await loadSession(replayReq, env.DB, SECRET);
    expect(result.user).toBeNull();

    // Theft branch fired — global wipe + session_version bump (both
    // halves of revokeAllForUser must run).
    const otherRow = await findRefreshToken(env.DB, otherValue);
    expect(otherRow!.revoked_at).not.toBeNull();
    const sv = await env.DB
      .prepare('SELECT session_version FROM users WHERE id = ?1')
      .bind(USER_ID)
      .first<{ session_version: number }>();
    expect(sv!.session_version).toBeGreaterThan(1);
  });

  it('REQ-AUTH-008: concurrent-rotation collision within grace window serves access JWT only, no theft fallout', async () => {
    const req1 = fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' });
    const { value: oldValue } = await issueRefreshToken(env.DB, USER_ID, req1);
    const { value: otherValue } = await issueRefreshToken(env.DB, USER_ID, req1);

    // Rotate the old row — winning concurrent rotation just happened.
    const oldRow = await findRefreshToken(env.DB, oldValue);
    await rotateRefreshToken(env.DB, oldRow!, req1);

    // Loser presents the old (now-revoked) cookie within the grace
    // window. Treat as benign concurrent rotation.
    const replayReq = fakeRequest({
      ua: 'Mozilla/5.0',
      country: 'CH',
      cookie: `${REFRESH_TOKEN_COOKIE_NAME}=${oldValue}`,
    });
    const result = await loadSession(replayReq, env.DB, SECRET);
    expect(result.user).not.toBeNull();
    expect(result.user!.id).toBe(USER_ID);
    // Just the access JWT — refresh row was already rotated by winner.
    expect(result.cookiesToSet.length).toBe(1);
    expect(result.cookiesToSet[0]).toContain(`${SESSION_COOKIE_NAME}=`);

    // Other device's row must NOT be revoked — concurrent collision
    // is benign, no global wipe.
    const otherRow = await findRefreshToken(env.DB, otherValue);
    expect(otherRow!.revoked_at).toBeNull();
  });

  it('REQ-AUTH-008 AC 4: reuse-detected token outside grace window revokes ALL refresh rows for the user', async () => {
    const req1 = fakeRequest({ ua: 'Mozilla/5.0', country: 'CH' });
    const { value: oldValue } = await issueRefreshToken(env.DB, USER_ID, req1);
    const { value: otherValue } = await issueRefreshToken(env.DB, USER_ID, req1);

    const oldRow = await findRefreshToken(env.DB, oldValue);
    await rotateRefreshToken(env.DB, oldRow!, req1);

    // Backdate revocation to OUTSIDE the grace window (current row was
    // just revoked at "now"; push it back so reuse detection treats
    // any replay as theft, not benign collision).
    await env.DB
      .prepare('UPDATE refresh_tokens SET revoked_at = 1 WHERE id = ?1')
      .bind(oldRow!.id)
      .run();

    const replayReq = fakeRequest({
      ua: 'Mozilla/5.0',
      country: 'CH',
      cookie: `${REFRESH_TOKEN_COOKIE_NAME}=${oldValue}`,
    });
    const result = await loadSession(replayReq, env.DB, SECRET);
    expect(result.user).toBeNull();

    // Every refresh row for the user is now revoked, including the
    // second device's row.
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
    expect(result.user).not.toBeNull();
    expect(result.cookiesToSet).toEqual([]);
  });

  it('REQ-AUTH-008 AC 3: revokeRefreshToken touches only the active row — sibling refresh-tokens for the same user stay live', async () => {
    // The multi-device invariant: logging out on one device must NOT
    // sign the user out of other devices they are intentionally still
    // using. The logout handler revokes only the active row (looked up
    // by token_hash); every other unrevoked row for the same user
    // keeps `revoked_at = NULL` and remains valid until its own
    // device-side logout, expiry, or theft-detection.
    const reqA = fakeRequest({ ua: 'Mozilla/5.0 (Mac)', country: 'CH' });
    const reqB = fakeRequest({ ua: 'Mozilla/5.0 (iPhone)', country: 'CH' });
    const { value: valueA, id: idA } = await issueRefreshToken(env.DB, USER_ID, reqA);
    const { value: valueB, id: idB } = await issueRefreshToken(env.DB, USER_ID, reqB);
    expect(idA).not.toBe(idB);

    // Simulate the logout handler's behaviour: look up the row that
    // matches the active cookie value, then revoke that single row.
    const activeRow = await findRefreshToken(env.DB, valueA);
    expect(activeRow).not.toBeNull();
    await revokeRefreshToken(env.DB, activeRow!.id);

    // Active row revoked.
    const reloadedA = await findRefreshToken(env.DB, valueA);
    expect(reloadedA!.revoked_at).not.toBeNull();
    // Sibling row from the user's other device is untouched.
    const reloadedB = await findRefreshToken(env.DB, valueB);
    expect(reloadedB).not.toBeNull();
    expect(reloadedB!.revoked_at).toBeNull();
    expect(reloadedB!.id).toBe(idB);

    // Defence-in-depth: the literal SQL behind revokeRefreshToken
    // must scope its UPDATE by row id, not by user_id — otherwise a
    // refactor that swapped the predicate would silently sign out
    // every device on every logout. Verify by counting unrevoked rows
    // for the user post-revoke.
    const unrevokedCount = await env.DB
      .prepare(
        'SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ?1 AND revoked_at IS NULL',
      )
      .bind(USER_ID)
      .first<{ n: number }>();
    expect(unrevokedCount!.n).toBe(1);
  });
});
