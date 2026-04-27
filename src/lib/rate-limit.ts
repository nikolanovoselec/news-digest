// Implements REQ-AUTH-001
// Implements REQ-OPS-002
//
// KV-backed application-layer rate limiter (CF-028). Cloudflare's edge
// WAF can throttle at the zone level, but a misconfigured rule (or a
// `*.workers.dev` URL bypassing the zone entirely) leaves auth + write
// endpoints fully exposed. This helper adds a Worker-side window-counter
// rate limit. Each rule chooses its KV-failure mode independently
// (`failClosed`): fail open for routes where a broken counter must not
// lock users out (auth_login, auth_callback) and fail closed for
// security-critical routes where KV outage must not bypass the limit
// (auth_refresh — a stolen cookie should not benefit from KV downtime).
//
// Scheme:
//   - One KV key per (route_class, identity, time_window).
//   - identity is "ip:<addr>" for unauthenticated routes (login,
//     callback) and "user:<id>" for authenticated mutation routes.
//   - The window is wall-clock-based, NOT a sliding window. Two
//     consecutive 60-second windows can each carry the full quota;
//     this is acceptable because the absolute ceiling stays bounded
//     and the simpler scheme has no race surface.
//
// TOCTOU note: KV has no compare-and-swap. Two requests racing inside
// the same window can both read N and both write N+1, allowing a small
// over-shoot under load. Acceptable for rate-limit purposes — over-
// permitting by a factor of <2 under contention is fine.

import { log } from '~/lib/log';

/** Configuration of a single rate-limit rule. */
export interface RateLimitRule {
  /** Logical name of the rule, used in the KV key + the log line. */
  routeClass: string;
  /** Maximum requests per window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
  /**
   * On KV error, return `{ ok: false }` (deny the request) instead of
   * the default `{ ok: true }` (permit). Defaults to false (fail open)
   * because most rate-limited paths exist to absorb noisy clients, not
   * to keep them out at all costs. Set to true on security-critical
   * routes where a KV outage must not bypass the limit.
   */
  failClosed?: boolean;
}

/** Result of a rate-limit check. */
export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfter: number };

/**
 * Check + increment the counter for {@link rule} keyed by {@link identity}.
 * On KV failure the helper logs `rate.limit.kv_error` and either fails
 * OPEN (default) or fails CLOSED (when {@link RateLimitRule.failClosed}
 * is true). Failing open keeps users from being locked out by KV
 * outages; failing closed is the right call for routes where KV
 * downtime must not bypass the limit.
 */
export async function enforceRateLimit(
  env: { KV: KVNamespace },
  rule: RateLimitRule,
  identity: string,
): Promise<RateLimitResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowIndex = Math.floor(nowSec / rule.windowSec);
  const key = `ratelimit:${rule.routeClass}:${identity}:${windowIndex}`;

  let current = 0;
  try {
    const raw = await env.KV.get(key, 'text');
    current = raw === null ? 0 : Math.max(0, Number.parseInt(raw, 10) || 0);
  } catch (err) {
    const failClosed = rule.failClosed === true;
    log('warn', 'rate.limit.kv_error', {
      route_class: rule.routeClass,
      identity,
      kv_error: String(err).slice(0, 200),
      decision: failClosed ? 'fail_closed' : 'fail_open',
    });
    if (failClosed) {
      // Use the full window length as Retry-After so the client backs
      // off for at least one full window before retrying.
      return { ok: false, retryAfter: rule.windowSec };
    }
    return { ok: true };
  }

  if (current >= rule.limit) {
    const retryAfter = (windowIndex + 1) * rule.windowSec - nowSec;
    log('warn', 'rate.limit.exceeded', {
      route_class: rule.routeClass,
      identity,
      current,
      limit: rule.limit,
      retry_after_seconds: retryAfter,
    });
    return { ok: false, retryAfter };
  }

  try {
    await env.KV.put(key, String(current + 1), {
      // 2× window TTL guarantees the counter survives the full window
      // even if KV write propagation runs slow.
      expirationTtl: rule.windowSec * 2,
    });
  } catch {
    // Increment failure is non-fatal — fall through and permit the
    // request. The next caller's read may miss this increment but
    // the absolute ceiling stays bounded.
  }
  return { ok: true };
}

/**
 * Build a `429 Too Many Requests` Response with the `Retry-After` header
 * that an HTTP-compliant client will honour.
 */
export function rateLimitResponse(retryAfter: number): Response {
  return new Response('Too Many Requests', {
    status: 429,
    headers: {
      'Retry-After': String(Math.max(1, retryAfter)),
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

/**
 * Extract the request's client IP for use as a rate-limit identity.
 * Cloudflare sets `CF-Connecting-IP` on every inbound request; falls
 * back to a literal "unknown" so the rule still applies (one bucket
 * for all unidentifiable clients — fail-quiet, not fail-open).
 */
export function clientIp(request: Request): string {
  const ip = request.headers.get('CF-Connecting-IP');
  return ip !== null && ip !== '' ? ip : 'unknown';
}

/** Pre-baked rules for the routes PR1 enforces. Add new rules here so
 *  the per-route limits are reviewable in one file. */
export const RATE_LIMIT_RULES = {
  AUTH_LOGIN: {
    routeClass: 'auth_login',
    limit: 10,
    windowSec: 60,
  },
  AUTH_CALLBACK: {
    routeClass: 'auth_callback',
    limit: 20,
    windowSec: 60,
  },
  ARTICLE_STAR: {
    routeClass: 'article_star',
    limit: 60,
    windowSec: 60,
  },
  TAGS_MUTATION: {
    routeClass: 'tags_mutation',
    limit: 30,
    windowSec: 60,
  },
  // REQ-AUTH-008 — explicit /api/auth/refresh force-rotates a refresh
  // token on every call. An attacker holding a valid refresh cookie
  // could otherwise hammer this endpoint to mint unlimited 5-minute
  // access JWTs. 10/min/IP is generous for any browser; legitimate
  // clients call this at most once per access-token expiry (~12/hr).
  AUTH_REFRESH: {
    routeClass: 'auth_refresh',
    limit: 10,
    windowSec: 60,
    // A stolen refresh cookie must not benefit from a KV outage —
    // fail closed so the limiter denies during KV downtime rather
    // than waving every request through unbounded.
    failClosed: true,
  },
  // REQ-AUTH-002 — bound logout calls per IP. Practical blast radius
  // is small (logout requires a live cookie), but a low ceiling
  // prevents loop-incrementing session_version under attack.
  AUTH_LOGOUT: {
    routeClass: 'auth_logout',
    limit: 5,
    windowSec: 60,
  },
} as const satisfies Record<string, RateLimitRule>;
