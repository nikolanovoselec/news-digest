// Implements REQ-AUTH-003, REQ-OPS-002
//
// CSRF defense for state-changing endpoints. Every POST, PUT, PATCH,
// DELETE MUST have an Origin header that equals the app's canonical
// origin (derived from `APP_URL`). GET is exempt — the session cookie's
// SameSite=Lax handles cross-origin GETs.
//
// This is not a double-submit token. Origin is set by the browser and
// cannot be forged by cross-site JavaScript, making this the simplest
// CSRF defense that holds up in modern browsers.

import { errorResponse } from '~/lib/errors';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Discriminated union (CF-013) — when ok is false, `response` is
 *  guaranteed present so callers do not need a non-null assertion. */
export type OriginCheckResult =
  | { ok: true }
  | { ok: false; response: Response };

/**
 * Verify the Origin header on a state-changing request.
 *
 * Returns `{ ok: true }` for GET/HEAD/OPTIONS (not subject to the check
 * per AC 3), and for POST/PUT/PATCH/DELETE requests whose Origin matches
 * {@link appOrigin}. Returns `{ ok: false, response }` on mismatch or
 * missing Origin; the response is HTTP 403 with a JSON body.
 *
 * {@link appOrigin} is derived from the `APP_URL` env var (origin only,
 * no path). The check is an exact string match on origins — case-
 * sensitive per the URL spec (hosts are lowercased by browsers, schemes
 * are lowercase).
 */
export function checkOrigin(request: Request, appOrigin: string): OriginCheckResult {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) {
    return { ok: true };
  }
  const origin = request.headers.get('Origin');
  if (origin === null || origin === '' || origin !== appOrigin) {
    return {
      ok: false,
      response: forbiddenOriginResponse(),
    };
  }
  return { ok: true };
}

/**
 * Extract the origin (`https://host[:port]`) from an arbitrary URL
 * string. Throws on an unparseable URL — callers should pass a
 * server-controlled value (e.g., `env.APP_URL`).
 */
export function originOf(url: string): string {
  return new URL(url).origin;
}

function forbiddenOriginResponse(): Response {
  return errorResponse('forbidden_origin');
}

/**
 * Defence-in-depth Origin check used by token-gated dev endpoints
 * (`/api/dev/login`, `/api/dev/trigger-scrape`). CF-035 — these
 * endpoints are primarily defended by `DEV_BYPASS_TOKEN`; the Origin
 * check is uniformity defence that blocks browser-driven CSRF without
 * breaking curl-driven CI flows that send no Origin header.
 *
 * Returns `true` if the request should pass (no Origin header sent,
 * APP_URL not configured, OR Origin matches APP_URL).
 * Returns `false` only when the browser sent a wrong Origin —
 * caller responds 404 to avoid telegraphing the endpoint's existence.
 */
export function checkDevEndpointOrigin(
  request: Request,
  appUrl: string | undefined,
): boolean {
  const origin = request.headers.get('Origin');
  if (origin === null || origin === '') return true;
  if (typeof appUrl !== 'string' || appUrl === '') return true;
  return origin === originOf(appUrl);
}
