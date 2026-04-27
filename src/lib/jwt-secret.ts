// Implements REQ-AUTH-002
//
// Runtime validation of OAUTH_JWT_SECRET strength (CF-029). The HMAC
// signing key is the only thing standing between an attacker who can
// guess it and arbitrary session minting — a 6-byte secret is not
// adequate. We require ≥ 32 UTF-8 bytes of secret material.
//
// Called at every signing/verifying site. The check is cheap (a string
// length lookup); the structured warn log fires once per cold worker
// boot via a module-level guard so a misconfigured deploy is loudly
// visible in Cloudflare Logs without spamming on every request.

import { log } from '~/lib/log';

/** Minimum acceptable UTF-8 byte length for the HMAC secret. */
export const MIN_JWT_SECRET_BYTES = 32;

/** Module-level latch — log once per cold worker, not once per request. */
let weakSecretLogged = false;

/**
 * Throw `Error('jwt_secret_too_weak')` when the configured secret is
 * shorter than {@link MIN_JWT_SECRET_BYTES}. The throw is caught by the
 * signing/verifying call sites and surfaced as a 500 to the client; the
 * log line gives the operator the diagnostic.
 */
export function requireStrongJwtSecret(secret: string): void {
  const byteLength = new TextEncoder().encode(secret).byteLength;
  if (byteLength < MIN_JWT_SECRET_BYTES) {
    if (!weakSecretLogged) {
      weakSecretLogged = true;
      log('warn', 'jwt.secret.weak', {
        configured_bytes: byteLength,
        required_bytes: MIN_JWT_SECRET_BYTES,
      });
    }
    throw new Error('jwt_secret_too_weak');
  }
}

/** Reset the module-level latch — exposed for tests only. */
export function __resetWeakSecretLatch(): void {
  weakSecretLogged = false;
}
