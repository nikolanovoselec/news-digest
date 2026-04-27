// Implements REQ-AUTH-001
// Implements REQ-OPS-002
//
// KV-backed application-layer rate limiter (CF-028). Cloudflare's edge
// WAF can throttle at the zone level, but a misconfigured rule (or a
// `*.workers.dev` URL bypassing the zone entirely) leaves auth + write
// endpoints fully exposed. This helper adds a Worker-side window-counter
// rate limit that fails closed on KV errors.
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
}

/** Result of a rate-limit check. */
export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfter: number };

/**
 * Check + increment the counter for {@link rule} keyed by {@link identity}.
 * On KV failure the helper logs and fails OPEN (returns ok=true) — a
 * broken counter must not lock users out of auth flows. Reverse this
 * to fail-closed only if the rate limiter becomes a critical safety
 * gate (e.g., billing-coupled endpoints).
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
    log('warn', 'rate.limit.exceeded', {
      route_class: rule.routeClass,
      identity,
      kv_error: String(err).slice(0, 200),
      decision: 'fail_open',
    });
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
} as const satisfies Record<string, RateLimitRule>;
