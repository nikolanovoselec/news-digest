// Implements REQ-AUTH-001
// CF-013 — defence-in-depth RS256 signature verification for Google
// `id_token`s. The prior implementation decoded claims without
// verifying the signature, relying solely on the TLS channel to the
// Google token endpoint (OIDC Core 3.1.3.7 step 6). That is the
// guidance Google itself publishes, but a single piece of code
// pointing `tokenUrl` at the wrong endpoint — or a TLS-stripping
// proxy quietly injected upstream — would have admitted a forged
// id_token. Verifying the signature against Google's published JWKS
// removes both failure modes.
//
// JWKS caching: Google's JWKS rotates roughly weekly. The Cache-Control
// header on the JWKS response advertises a max-age in the 4-6 hour
// range; we cache for 1 hour in KV (`oidc:jwks:google`) so a stale-key
// scenario after a Google rotation self-heals within an hour even if
// every isolate happened to grab the keys just before the rotation.
//
// Cost: one fetch per Worker isolate per hour. The JWKS body is ~1 KB
// and the fetch is to a Google-cached CDN endpoint, so the marginal
// latency on the login callback is single-digit ms in the cache-miss
// case and zero in the cache-hit case.

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const JWKS_KV_KEY = 'oidc:jwks:google';
const JWKS_TTL_SECONDS = 60 * 60; // 1 hour

interface JsonWebKey {
  kty: string;
  alg?: string;
  use?: string;
  kid?: string;
  n?: string;
  e?: string;
}

interface Jwks {
  keys: JsonWebKey[];
}

/** Fetch the current Google JWKS, caching the raw JSON in KV for an
 *  hour. The cached value is a string (the raw HTTP body) so a
 *  schema-incompatible Google response surface (added/renamed keys
 *  per RFC 7517 §4) does not need a code change before re-caching. */
async function loadJwks(kv: KVNamespace): Promise<Jwks> {
  const cached = await kv.get(JWKS_KV_KEY);
  if (cached !== null) {
    try {
      return JSON.parse(cached) as Jwks;
    } catch {
      // Cached value corrupt — fall through to a fresh fetch.
    }
  }
  const res = await fetch(JWKS_URL, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`google_jwks_http_${res.status}`);
  }
  const body = await res.text();
  let parsed: Jwks;
  try {
    parsed = JSON.parse(body) as Jwks;
  } catch {
    throw new Error('google_jwks_parse_error');
  }
  if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) {
    throw new Error('google_jwks_empty');
  }
  // Fire-and-forget cache write; failures are non-fatal because the
  // verifier already has the parsed JWKS for this request.
  await kv.put(JWKS_KV_KEY, body, { expirationTtl: JWKS_TTL_SECONDS });
  return parsed;
}

/** Parse the JWT header segment. Returns null on any structural
 *  defect — caller falls back to the rejection path. */
function parseJwtHeader(jwt: string): { alg?: string; kid?: string } | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const headerB64 = parts[0] ?? '';
  if (headerB64 === '') return null;
  const b64 = headerB64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  let json: string;
  try {
    json = atob(padded);
  } catch {
    return null;
  }
  try {
    return JSON.parse(json) as { alg?: string; kid?: string };
  } catch {
    return null;
  }
}

/** Base64url-decode to a Uint8Array (no padding stripping side-effects). */
function b64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Verify the RS256 signature on a Google id_token against the current
 *  JWKS. Returns true on a valid signature, false otherwise. Throws
 *  only on operational failures (JWKS fetch failed, KV unreachable);
 *  callers treat a throw as fail-closed (reject the token). */
export async function verifyGoogleIdToken(
  jwt: string,
  kv: KVNamespace,
): Promise<boolean> {
  const header = parseJwtHeader(jwt);
  if (header === null) return false;
  if (header.alg !== 'RS256') return false;
  if (typeof header.kid !== 'string' || header.kid === '') return false;

  const jwks = await loadJwks(kv);
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (jwk === undefined) {
    // Cache miss-by-kid can happen briefly after Google rotates keys.
    // Re-fetch directly (bypassing the cache) so a freshly-rotated key
    // is available for this verification.
    const refreshed = await fetch(JWKS_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!refreshed.ok) return false;
    let parsed: Jwks;
    try {
      parsed = (await refreshed.json()) as Jwks;
    } catch {
      return false;
    }
    const fresh = parsed.keys.find((k) => k.kid === header.kid);
    if (fresh === undefined) return false;
    // Replace the cached JWKS so subsequent verifications hit fast.
    await kv.put(JWKS_KV_KEY, JSON.stringify(parsed), {
      expirationTtl: JWKS_TTL_SECONDS,
    });
    return verifySignatureAgainstJwk(jwt, fresh);
  }
  return verifySignatureAgainstJwk(jwt, jwk);
}

async function verifySignatureAgainstJwk(
  jwt: string,
  jwk: JsonWebKey,
): Promise<boolean> {
  if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
    return false;
  }
  const parts = jwt.split('.');
  if (parts.length !== 3) return false;
  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let signature: Uint8Array;
  try {
    signature = b64urlToBytes(parts[2] ?? '');
  } catch {
    return false;
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'RSA',
        n: jwk.n,
        e: jwk.e,
        alg: 'RS256',
        ext: true,
      } as unknown as JsonWebKey & globalThis.JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch {
    return false;
  }
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature as unknown as ArrayBuffer,
    signedData as unknown as ArrayBuffer,
  );
}
