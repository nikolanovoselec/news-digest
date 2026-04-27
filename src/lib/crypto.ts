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
 * The verifier signs `b` with `secret` and asks the runtime to
 * `crypto.subtle.verify` that signature against `a`. `subtle.verify`
 * is constant-time by Web Crypto spec, so timing leakage is bounded
 * by the key-import + sign duration — neither of which depends on
 * the prefix of `a` matching the prefix of `b`.
 *
 * Returns false for empty inputs (defends against the empty-cookie
 * vs empty-state false-positive: an attacker who can omit both is
 * not authenticated).
 */
export async function timingSafeEqualHmac(
  a: string,
  b: string,
  secret: string,
): Promise<boolean> {
  if (a === '' || b === '') return false;
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
  let expected: ArrayBuffer;
  try {
    expected = await crypto.subtle.sign('HMAC', key, enc.encode(b));
  } catch {
    return false;
  }
  try {
    return await crypto.subtle.verify(
      'HMAC',
      key,
      expected,
      enc.encode(a),
    );
  } catch {
    return false;
  }
}

/**
 * Hex-encode a Uint8Array. Lowercase, no separator. Used by the
 * refresh-token module for cookie values + SHA-256 digests.
 */
export function hexEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
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
