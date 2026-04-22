// Implements REQ-AUTH-002
//
// HMAC-SHA256 session JWT for GitHub OAuth sessions.
//
// The Worker secret (`OAUTH_JWT_SECRET`) IS the signing key — symmetric, no
// JWKS, no key rotation. Claims include `sv` (session_version) so incrementing
// the user's row-level `session_version` invalidates every outstanding JWT
// previously issued to that user (REQ-AUTH-002 AC 3). Pattern adopted from
// the codeflare repo's src/lib/session-jwt.ts.

const DEFAULT_TTL_SECONDS = 3600; // 1 hour — REQ-AUTH-002 AC 1
const REFRESH_THRESHOLD_SECONDS = 15 * 60; // 15 minutes — REQ-AUTH-002 AC 4

const HEADER_B64 = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_');

/** Cached CryptoKey keyed by the secret string. Module-level cache avoids
 * re-importing the key on every request hot path. */
let cachedKey: CryptoKey | null = null;
let cachedKeySecret: string | null = null;

export interface SessionClaims {
  sub: string;
  email: string;
  ghl: string;
  sv: number;
  iat: number;
  exp: number;
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey && cachedKeySecret === secret) return cachedKey;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  cachedKey = key;
  cachedKeySecret = secret;
  return key;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(input: string): Uint8Array {
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
 * Sign a session JWT with HMAC-SHA256.
 *
 * @returns `base64url(header).base64url(payload).base64url(signature)`
 */
export async function signSession(
  claims: Omit<SessionClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const full: SessionClaims = {
    ...claims,
    iat: now,
    exp: now + ttlSeconds,
  };

  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(full)));
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const key = await getHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify and decode a session JWT.
 *
 * Returns `null` on signature mismatch, expiry, malformed shape, or invalid
 * payload JSON. Constant-time signature comparison is provided by Web
 * Crypto's `subtle.verify`.
 */
export async function verifySession(
  token: string,
  secret: string,
): Promise<SessionClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const signingInput = `${headerB64}.${payloadB64}`;

  let key: CryptoKey;
  try {
    key = await getHmacKey(secret);
  } catch {
    return null;
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlDecode(signatureB64);
  } catch {
    return null;
  }

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      new TextEncoder().encode(signingInput),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let payload: unknown;
  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(payloadB64));
    payload = JSON.parse(decoded);
  } catch {
    return null;
  }

  if (!isSessionClaims(payload)) return null;

  // Expiry check (verifySession is the one gate that enforces it).
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return null;

  return payload;
}

function isSessionClaims(value: unknown): value is SessionClaims {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sub === 'string' &&
    typeof v.email === 'string' &&
    typeof v.ghl === 'string' &&
    typeof v.sv === 'number' &&
    typeof v.iat === 'number' &&
    typeof v.exp === 'number'
  );
}

/**
 * True when the session has less than 15 minutes remaining but is not yet
 * expired. Callers use this to trigger silent re-issue on active requests
 * (REQ-AUTH-002 AC 4).
 */
export function shouldRefreshJWT(claims: SessionClaims, now?: number): boolean {
  const currentSec = now ?? Math.floor(Date.now() / 1000);
  return claims.exp > currentSec && claims.exp - currentSec < REFRESH_THRESHOLD_SECONDS;
}
