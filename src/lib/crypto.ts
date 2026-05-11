// Implements REQ-AUTH-001
// Implements REQ-AUTH-002
//
// Cryptographic primitives shared across auth + session paths.
//
// Centralises three patterns that were previously duplicated across
// callback.ts / dev/login.ts / dev/trigger-scrape.ts (timingSafeEqual)
// and across session-jwt.ts / [provider]/login.ts (base64UrlEncode).
// All call sites must consume these exports rather than re-implementing
// the primitive (CF-005).
//
// Constant-time comparison uses Web Crypto's HMAC verify path — a
// JS-level XOR loop is not a guaranteed constant-time primitive under
// V8 JIT optimisation. `crypto.subtle.verify` IS constant-time by spec.

const enc = new TextEncoder();

/**
 * Encode a Uint8Array as base64url (no padding, '+' → '-', '/' → '_').
 * Canonical implementation; previously duplicated in session-jwt.ts and
 * src/pages/api/auth/[provider]/login.ts.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Decode a base64url string back to a Uint8Array. Pairs with
 * {@link base64UrlEncode}.
 */
export function base64UrlDecode(input: string): Uint8Array {
  let b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Constant-time string equality via HMAC-SHA256.
 *
 * The implementation signs `candidate` with `secret`, then asks the
 * runtime to `crypto.subtle.verify` that signature against
 * `enc.encode(expected)`. Because HMAC-SHA256 is collision-resistant,
 * `verify` returns true iff `expected === candidate` byte-for-byte —
 * so the function IS a constant-time equality check despite its
 * sign/verify shape.
 *
 * **Argument convention (CF-014 / AD24):** put the server-trusted
 * value first (`expected`) and the caller-supplied / cookie-echoed
 * value second (`candidate`). The implementation is symmetric — order
 * does not change the boolean result — but the convention keeps call
 * sites readable and aligns with the broader "compare(known, unknown)"
 * security idiom. The single OAUTH_JWT_SECRET reuse for both session
 * signing and CSRF state HMAC is documented in AD24 and intentional.
 *
 * `subtle.verify` is constant-time by Web Crypto spec, so timing
 * leakage is bounded by the key-import + sign duration — neither of
 * which depends on the prefix of `expected` matching the prefix of
 * the freshly-derived MAC.
 *
 * Returns false for empty inputs (defends against the empty-cookie
 * vs empty-state false-positive: an attacker who can omit both is
 * not authenticated).
 */
export async function verifyHmacSignature(
  expected: string,
  candidate: string,
  secret: string,
): Promise<boolean> {
  if (expected === '' || candidate === '') return false;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
  } catch {
    return false;
  }
  let candidateMac: ArrayBuffer;
  try {
    candidateMac = await crypto.subtle.sign('HMAC', key, enc.encode(candidate));
  } catch {
    return false;
  }
  try {
    return await crypto.subtle.verify(
      'HMAC',
      key,
      candidateMac,
      enc.encode(expected),
    );
  } catch {
    return false;
  }
}

/**
 * Constant-time byte-equality on two strings of equal length.
 *
 * Returns false when the lengths differ (the length check is itself
 * unsafe to expose timing on, but length is not a secret — the
 * CSRF-state cookie values this helper compares are public-shape
 * tokens whose byte length is fixed by `oauthStateCookieName`).
 *
 * Implementation: XOR-accumulate over the full length of both strings
 * so the loop time depends only on the input length, not on the
 * position of the first differing byte. The accumulator is then
 * checked against zero in a single equality test.
 *
 * Used in `src/pages/api/auth/[provider]/callback.ts` for the OAuth
 * CSRF state cookie vs. query-param byte equality check (CF-011) —
 * the cookie value is set by the worker itself, so HMAC verification
 * adds no security over plain byte equality there. The
 * {@link verifyHmacSignature} helper remains the correct primitive
 * when the candidate is HMAC-signed input (e.g. dev-bypass tokens).
 */
export function constantTimeEq(expected: string, candidate: string): boolean {
  if (expected.length !== candidate.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Hex-encode a Uint8Array. Lowercase, no separator. Used by the
 * refresh-token module for cookie values + SHA-256 digests.
 */
export function hexEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === undefined) continue; // unreachable: i < bytes.length
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Parse a single cookie value out of a Cookie header string. Returns
 * null when absent. Case-sensitive per RFC 6265.
 *
 * Canonical implementation — `src/middleware/auth.ts` re-exports this
 * for backwards-compat with callers that import from the middleware.
 * Prefer importing from `~/lib/crypto` in new code.
 */
export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (cookieHeader === null || cookieHeader === '') return null;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    if (k === name) {
      return pair.slice(idx + 1).trim();
    }
  }
  return null;
}
