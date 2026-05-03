// Implements REQ-AUTH-002, REQ-AUTH-008
//
// Refresh-token storage, rotation, and reuse-detection.
//
// Cookie value vs. row id: the value the client holds is a 32-byte
// random hex string. We store SHA-256(value) as `token_hash` and look
// up by that hash. The `id` column is a SEPARATE random 16-byte hex
// identifier — never the cookie value — so a leaked DB dump cannot
// expose live tokens. (CodeQL js/sensitive-data-treatment.)
//
// Rotation: every successful refresh marks the old row revoked,
// inserts a new row with `parent_id` pointing back, and increments
// `rotation_count` on the new row. Reuse of a revoked token is
// treated as theft — see `revokeAllForUser` — UNLESS the revocation
// happened within `ROTATION_GRACE_SECONDS`, in which case we treat
// it as a benign concurrent-rotation collision (browser tab firing
// two parallel requests against the same expired access token at the
// moment of refresh) and serve a fresh access JWT without rotating
// again.
//
// Device fingerprint: SHA-256(UA || NUL || Cf-IPCountry). Captured
// at issuance and recorded on every refresh-token row. As of
// 2026-04-28 the fingerprint is forensic metadata on the steady-state
// refresh path (UA drift across browser auto-updates was forcing
// legitimate users back through OAuth on every refresh — anti-pattern
// per RFC 9700 / OWASP / Auth0 / Okta). The hard gate is preserved
// only on the 30-second concurrent-rotation grace branch, where the
// UA cannot legitimately drift across two parallel requests fired
// seconds apart.

import { hexEncode } from '~/lib/crypto';

export const REFRESH_TOKEN_COOKIE_NAME = '__Host-news_digest_refresh';
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const REFRESH_TOKEN_BYTES = 32;
export const REFRESH_ROW_ID_BYTES = 16;

/** Tolerance window for concurrent-refresh race. When a refresh token
 *  whose `revoked_at` was set within this many seconds is presented,
 *  we treat the request as a legitimate concurrent rotation rather
 *  than theft (see header). 30 seconds is enough for any realistic
 *  parallel-request scenario (browser tab + XHR firing simultaneously
 *  on access-JWT expiry) without giving a stolen cookie a meaningful
 *  exploitation window. */
export const ROTATION_GRACE_SECONDS = 30;

/** Path scope for the refresh cookie. `Path=/` so middleware can do
 *  inline silent-refresh on any request — server-side only the refresh
 *  + logout endpoints look the cookie up, everywhere else ignores it.
 *  Cookie is HttpOnly so JS can't read it, and `__Host-` prefix forces
 *  Secure + Path=/ at the browser level. */
export const REFRESH_TOKEN_COOKIE_PATH = '/';

const REFRESH_COOKIE_ATTRS =
  `HttpOnly; Secure; SameSite=Lax; Path=${REFRESH_TOKEN_COOKIE_PATH}; Max-Age=${REFRESH_TOKEN_TTL_SECONDS}`;

export interface RefreshTokenRow {
  id: string;
  token_hash: string;
  user_id: string;
  device_fingerprint_hash: string;
  issued_at: number;
  last_used_at: number;
  expires_at: number;
  revoked_at: number | null;
  parent_id: string | null;
  rotation_count: number;
}

/** Generate a fresh 32-byte random cookie value (the value the client
 *  holds). Hex-encoded so it's cookie-safe and printable. */
export function generateRefreshTokenValue(): string {
  const bytes = new Uint8Array(REFRESH_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return hexEncode(bytes);
}

/** Generate a fresh 16-byte random row id (the value used as PRIMARY
 *  KEY internally, NEVER the cookie value). Distinct from the cookie
 *  value so a DB leak doesn't expose live tokens. */
export function generateRowId(): string {
  const bytes = new Uint8Array(REFRESH_ROW_ID_BYTES);
  crypto.getRandomValues(bytes);
  return hexEncode(bytes);
}

/** SHA-256 hex of any string. Used for token_hash and device
 *  fingerprint. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return hexEncode(new Uint8Array(digest));
}

/** Build the device fingerprint hash from request headers.
 *  UA || NUL || Country, then SHA-256.
 *
 *  This hash is captured for FORENSIC METADATA only. The middleware
 *  does not reject steady-state requests on fingerprint mismatch
 *  (see `src/middleware/auth.ts`). RFC 9700 / OWASP / Auth0 / Okta
 *  guidance flags a UA-based hard gate as an anti-pattern: browser
 *  auto-updates flip the UA string deterministically, so a persisted
 *  hash would diverge on every minor version bump and lock legitimate
 *  users out every time their 5-min access JWT expires.
 *
 *  Keeping UA + country in the recorded hash preserves the value of
 *  the column for future anomaly detection (e.g. soft-prompt for
 *  re-auth when a new IP/UA pair appears) without making the cookie
 *  fragile. The cookie's HttpOnly + Secure + __Host- prefix +
 *  rotation + reuse-detection are the actual defenses that matter.
 */
export async function deviceFingerprint(request: Request): Promise<string> {
  const ua = request.headers.get('User-Agent') ?? '';
  const country = request.headers.get('Cf-IPCountry') ?? '';
  return sha256Hex(`${ua}\x00${country}`);
}

/** Cookie-string for setting the refresh token. */
export function buildRefreshCookie(value: string): string {
  return `${REFRESH_TOKEN_COOKIE_NAME}=${value}; ${REFRESH_COOKIE_ATTRS}`;
}

/** Cookie-string for clearing the refresh token. */
export function buildClearRefreshCookie(): string {
  return `${REFRESH_TOKEN_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=${REFRESH_TOKEN_COOKIE_PATH}; Max-Age=0`;
}

/**
 * Issue a brand-new refresh token row (no parent — used at OAuth
 * callback, not rotation). Returns the cookie value plus the row id.
 */
export async function issueRefreshToken(
  db: D1Database,
  userId: string,
  request: Request,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ value: string; id: string }> {
  const value = generateRefreshTokenValue();
  const id = generateRowId();
  const tokenHash = await sha256Hex(value);
  const fingerprint = await deviceFingerprint(request);
  const expiresAt = now + REFRESH_TOKEN_TTL_SECONDS;

  await db
    .prepare(
      `INSERT INTO refresh_tokens
         (id, token_hash, user_id, device_fingerprint_hash, issued_at, last_used_at, expires_at, revoked_at, parent_id, rotation_count)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, NULL, NULL, 0)`,
    )
    .bind(id, tokenHash, userId, fingerprint, now, expiresAt)
    .run();

  return { value, id };
}

/**
 * Look up a refresh token row by the cookie value.
 *
 * Returns the row when found, regardless of revoked/expired state — the
 * caller decides what to do (reuse-detection wants to see revoked rows).
 */
export async function findRefreshToken(
  db: D1Database,
  cookieValue: string,
): Promise<RefreshTokenRow | null> {
  const tokenHash = await sha256Hex(cookieValue);
  const row = await db
    .prepare(
      `SELECT id, token_hash, user_id, device_fingerprint_hash, issued_at,
              last_used_at, expires_at, revoked_at, parent_id, rotation_count
         FROM refresh_tokens
        WHERE token_hash = ?1`,
    )
    .bind(tokenHash)
    .first<RefreshTokenRow>();
  return row;
}

/**
 * Look up the unrevoked CHILD of a given refresh-token row id, if any.
 * Used by the concurrent-refresh tolerance branch: when a revoked
 * token is presented within the grace window, we want to know whether
 * a successor row exists (i.e., the legitimate concurrent winner).
 */
export async function findUnrevokedChild(
  db: D1Database,
  parentId: string,
): Promise<RefreshTokenRow | null> {
  return db
    .prepare(
      `SELECT id, token_hash, user_id, device_fingerprint_hash, issued_at,
              last_used_at, expires_at, revoked_at, parent_id, rotation_count
         FROM refresh_tokens
        WHERE parent_id = ?1 AND revoked_at IS NULL
        ORDER BY issued_at DESC
        LIMIT 1`,
    )
    .bind(parentId)
    .first<RefreshTokenRow>();
}

/**
 * Rotate a refresh token: mark the existing row revoked, insert a new
 * row with `parent_id` pointing back, and return the new cookie value.
 *
 * Atomic via D1 batch + a `WHERE revoked_at IS NULL` predicate on the
 * UPDATE. Returns null when the predicate matches zero rows — meaning
 * a concurrent caller already rotated this row. The caller should then
 * fall back to {@link findUnrevokedChild} and apply the
 * concurrent-refresh tolerance branch.
 *
 * Caller MUST have already confirmed:
 *   - the existing row is not expired
 *   - the device fingerprint matches
 */
export async function rotateRefreshToken(
  db: D1Database,
  existing: RefreshTokenRow,
  request: Request,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ value: string; id: string } | null> {
  const value = generateRefreshTokenValue();
  const id = generateRowId();
  const tokenHash = await sha256Hex(value);
  const fingerprint = await deviceFingerprint(request);
  const expiresAt = now + REFRESH_TOKEN_TTL_SECONDS;

  // The UPDATE returns affected-row count via D1's `meta.changes`; if
  // it's 0, a concurrent rotation already happened. We DO NOT insert
  // the new row in that case — let the winner's row be the surviving
  // child, and the caller decides what to serve.
  //
  // Conditional INSERT predicate guards on "no unrevoked child exists
  // for this parent yet". This is tighter than the more obvious
  // `revoked_at = ?5` predicate, which fails when two rotations land
  // in the same Math.floor second — both the winner and loser would
  // see `parent.revoked_at = N` (their shared `now`), and both
  // INSERTs would fire, leaving an orphan unrevoked child. The
  // "no-existing-unrevoked-child" predicate makes the INSERT
  // contention-free regardless of timestamp granularity.
  const batch = await db.batch([
    db
      .prepare(
        `UPDATE refresh_tokens
            SET revoked_at = ?2, last_used_at = ?2
          WHERE id = ?1 AND revoked_at IS NULL`,
      )
      .bind(existing.id, now),
    db
      .prepare(
        `INSERT INTO refresh_tokens
           (id, token_hash, user_id, device_fingerprint_hash, issued_at, last_used_at, expires_at, revoked_at, parent_id, rotation_count)
         SELECT ?1, ?2, ?3, ?4, ?5, ?5, ?6, NULL, ?7, ?8
          WHERE NOT EXISTS (
             SELECT 1 FROM refresh_tokens
              WHERE parent_id = ?7 AND revoked_at IS NULL
          )`,
      )
      .bind(
        id,
        tokenHash,
        existing.user_id,
        fingerprint,
        now,
        expiresAt,
        existing.id,
        existing.rotation_count + 1,
      ),
  ]);

  // batch[0].meta.changes — 1 if we won the race, 0 if a concurrent
  // refresh got there first.
  const updateResult = batch[0] as unknown as { meta?: { changes?: number } };
  const updateChanges = updateResult.meta?.changes ?? 0;
  if (updateChanges === 0) {
    // We lost the race. The conditional INSERT (gated by `WHERE NOT
    // EXISTS` on an unrevoked child of this parent) also did NOT
    // insert because the winner's child row already exists. No new
    // row was created with our id. Return null.
    return null;
  }

  return { value, id };
}

/**
 * Mark a single refresh token row revoked. Used at logout when we
 * know which row corresponds to the active session.
 */
export async function revokeRefreshToken(
  db: D1Database,
  id: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  await db
    .prepare(
      `UPDATE refresh_tokens SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL`,
    )
    .bind(id, now)
    .run();
}

/**
 * Reuse-detection: revoke EVERY refresh token row for a user AND
 * bump `users.session_version` so any in-flight access JWT is killed.
 *
 * Triggered when a token with `revoked_at` set is presented OUTSIDE
 * the grace window — within the window, see ROTATION_GRACE_SECONDS.
 * REQ-AUTH-008 AC 4.
 *
 * **Idempotent under retry**: a second call when no unrevoked rows
 * exist is a no-op (no `session_version` bump). Without this short-
 * circuit a browser replaying a dead refresh cookie against the
 * inline-refresh path would re-bump on every request, causing ongoing
 * session churn for the legitimate user.
 *
 * **Soundness:** skipping the bump when all rows are already revoked
 * is safe because every prior path that revoked those rows ALSO
 * bumped `session_version` (this function bundles both writes; logout
 * does the same; account deletion drops the user entirely). So at the
 * moment we observe "no unrevoked rows", every access JWT older than
 * the last legitimate bump is already invalid. Future callers that
 * revoke rows without a parallel `session_version` bump (none today)
 * MUST update this contract.
 *
 * **Race:** the prior SELECT-then-batch-UPDATE shape had a TOCTOU
 * window where another isolate could revoke all rows between SELECT
 * and UPDATE. We now gate the bump on `EXISTS` against rows whose
 * `revoked_at` matches the value this call just wrote — and run
 * BOTH statements inside a single `db.batch()` so the runtime can't
 * preempt between revoke and bump (which would leave outstanding
 * access JWTs valid for up to their 5-min lifetime even though all
 * refresh tokens were revoked). The batch is atomic relative to D1.
 *
 * Two concurrent first-time callers can both observe unrevoked rows
 * under the conditional UPDATE itself (one wins the row flip, the
 * other observes zero changes and skips); bounded over-bump is
 * acceptable because `session_version` is monotonically increasing.
 */
export async function revokeAllForUser(
  db: D1Database,
  userId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE refresh_tokens SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL`,
      )
      .bind(userId, now),
    // EXISTS sees the rows the previous statement just flipped (since
    // the batch executes statements in order against the same logical
    // snapshot). The bump fires only when the revoke actually had
    // work to do — no spurious session_version churn on dead-cookie
    // replays, no preempt-window where tokens revoked but JWTs valid.
    db
      .prepare(
        `UPDATE users SET session_version = session_version + 1
          WHERE id = ?1
            AND EXISTS (
              SELECT 1 FROM refresh_tokens
               WHERE user_id = ?1 AND revoked_at = ?2
            )`,
      )
      .bind(userId, now),
  ]);
}

/**
 * Sweep expired and old-revoked rows. Called from the cron cleanup.
 * 7-day grace on revoked rows so the reuse-detection branch can see
 * `revoked_at` before the row is pruned.
 */
export async function purgeOldRefreshTokens(
  db: D1Database,
  now: number = Math.floor(Date.now() / 1000),
): Promise<number> {
  const cutoff = now - 7 * 24 * 60 * 60;
  const result = await db
    .prepare(
      `DELETE FROM refresh_tokens
        WHERE expires_at < ?1
           OR (revoked_at IS NOT NULL AND revoked_at < ?2)`,
    )
    .bind(now, cutoff)
    .run();
  return result.meta?.changes ?? 0;
}
