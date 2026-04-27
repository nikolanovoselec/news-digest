// Implements REQ-OPS-002
//
// Sanitized error codes and user-facing messages.
//
// User-visible errors expose ONLY the short codes defined in {@link ErrorCode}
// and the generic messages in {@link USER_FACING_MESSAGES}. Raw exceptions,
// stack traces, and upstream API response bodies never reach the browser — a
// REQ-OPS-001 error-level log line carries those details, and the response
// body carries only the sanitized code.
//
// Scope:
//  - `digests.error_code` column: `llm_invalid_json`, `llm_failed`,
//    `all_sources_failed`, `generation_stalled`, `user_cancelled` (REQ-OPS-002 AC 1)
//  - OAuth error allowlist: `access_denied`, `no_verified_email`,
//    `invalid_state`, `oauth_error` (REQ-OPS-002 AC 4) — see also
//    `src/lib/oauth-errors.ts` which owns the query-parameter sanitizer.
//  - HTTP API error codes: everything else in the enum.

/** Closed set of sanitized error codes surfaced through API responses, the
 * `digests.error_code` column, and the landing-page `?error=` query param.
 * Any new user-visible failure MUST add a code here and a matching entry in
 * {@link USER_FACING_MESSAGES}. */
export type ErrorCode =
  // Digest generation failure modes (persisted in digests.error_code)
  | 'llm_invalid_json'
  | 'llm_failed'
  | 'all_sources_failed'
  | 'generation_stalled'
  | 'user_cancelled'
  // Request-layer errors
  | 'rate_limited'
  | 'forbidden_origin'
  | 'not_found'
  | 'invalid_state'
  | 'already_in_progress'
  | 'bad_request'
  | 'unauthorized'
  | 'internal_error'
  // OAuth / session errors
  | 'no_verified_email'
  | 'access_denied'
  | 'oauth_error'
  | 'oauth_not_configured'
  | 'app_not_configured'
  // Account deletion
  | 'confirmation_required'
  // Settings validation failures
  | 'invalid_hashtags'
  | 'invalid_time'
  | 'invalid_model_id'
  | 'invalid_email_enabled'
  | 'invalid_tz'
  | 'unknown_tag';

/**
 * Generic, user-facing messages keyed by error code. These strings are safe
 * to render in the browser — they carry no internal details, no upstream
 * product names, and no field-level specifics that would help an attacker
 * probe the system.
 *
 * When adding a new code, keep the message:
 *  - Short (one sentence, ≤120 chars)
 *  - Action-oriented when possible ("Try again in a few minutes.")
 *  - Free of implementation detail (no vendor names, no internal IDs)
 */
export const USER_FACING_MESSAGES: Record<ErrorCode, string> = {
  // Digest generation
  llm_invalid_json:
    'The language model returned an unexpected response. Please try again.',
  llm_failed:
    'The language model could not produce a digest right now. Please try again.',
  all_sources_failed:
    'None of your sources could be fetched. Please try again later.',
  generation_stalled:
    'Digest generation did not complete in time. Please try again.',
  user_cancelled: 'Digest generation was cancelled.',

  // Request layer
  rate_limited: 'Too many requests. Please slow down and try again shortly.',
  forbidden_origin: 'This request is not allowed from the current origin.',
  not_found: 'The requested resource was not found.',
  invalid_state: 'Your session state is invalid. Please sign in again.',
  already_in_progress: 'A digest is already being generated for this day.',
  bad_request: 'The request is malformed. Please try again.',
  unauthorized: 'You must be signed in to perform this action.',
  internal_error: 'Something went wrong on our end. Please try again.',

  // OAuth / session
  no_verified_email:
    'Your account does not have a verified email address. Please verify one and sign in again.',
  access_denied: 'Access was denied. You must approve the sign-in request to continue.',
  oauth_error: 'Sign-in failed. Please try again.',
  oauth_not_configured: 'Sign-in is not configured. Please contact the site administrator.',
  app_not_configured: 'The application is not configured. Please contact the site administrator.',

  // Account deletion. CF-039 — user-facing copy only; API contract
  // (the literal `{"confirm":"DELETE"}` body shape) is documented in
  // documentation/api-reference.md, not surfaced to end-users.
  confirmation_required: 'Account deletion was not confirmed. Use the delete button on the settings page and follow the prompt.',

  // Settings validation
  invalid_hashtags: 'One or more of the provided hashtags is not in a valid format.',
  invalid_time: 'The provided time is not valid.',
  invalid_model_id: 'The selected model is not available.',
  invalid_email_enabled: 'The email delivery setting is not valid.',
  invalid_tz: 'The provided time zone is not valid.',
  unknown_tag: 'One of the provided tags is not recognised.',
};

/** Default HTTP status for each error code. Callers can override via the
 * `status` argument to {@link errorResponse}. The map is intentionally
 * conservative: anything ambiguous defaults to 400 (bad request). */
const DEFAULT_STATUS: Record<ErrorCode, number> = {
  // Digest generation — surfaced via the digest page, not typical HTTP errors,
  // but the shared helper still needs a sensible default when called.
  llm_invalid_json: 502,
  llm_failed: 502,
  all_sources_failed: 502,
  generation_stalled: 504,
  user_cancelled: 409,

  // Request layer
  rate_limited: 429,
  forbidden_origin: 403,
  not_found: 404,
  invalid_state: 400,
  already_in_progress: 409,
  bad_request: 400,
  unauthorized: 401,
  internal_error: 500,

  // OAuth / session
  no_verified_email: 403,
  access_denied: 403,
  oauth_error: 400,
  oauth_not_configured: 500,
  app_not_configured: 500,

  // Account deletion
  confirmation_required: 400,

  // Settings validation
  invalid_hashtags: 400,
  invalid_time: 400,
  invalid_model_id: 400,
  invalid_email_enabled: 400,
  invalid_tz: 400,
  unknown_tag: 400,
};

/**
 * Build a sanitized JSON error {@link Response}.
 *
 * Body shape:
 *   { error: "<generic message>", code: "<error_code>", ...extras }
 *
 * @param code   Sanitized {@link ErrorCode}. The user-visible message is
 *               looked up from {@link USER_FACING_MESSAGES}.
 * @param extras Optional extra fields merged into the response body. Use
 *               this for non-sensitive hints ({`retry_after_seconds: 30`}),
 *               never for raw error detail — that belongs in server logs.
 * @param status Optional HTTP status override. Defaults to a code-specific
 *               sensible value (4xx for client errors, 5xx for upstream
 *               failures).
 * @returns      A {@link Response} with `Content-Type: application/json`.
 */
export function errorResponse(
  code: ErrorCode,
  extras?: Record<string, unknown>,
  status?: number,
): Response {
  const body: Record<string, unknown> = {
    ...extras,
    error: USER_FACING_MESSAGES[code],
    code,
  };
  return new Response(JSON.stringify(body), {
    status: status ?? DEFAULT_STATUS[code],
    headers: { 'Content-Type': 'application/json' },
  });
}
