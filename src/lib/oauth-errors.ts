// Implements REQ-AUTH-004
//
// Allowlisted error codes surfaced to the browser on OAuth failures.
// Keeping these as a closed enum prevents reflected content in the
// `?error=` query parameter — any raw error we receive from GitHub that
// is not on this allowlist collapses to the generic `oauth_error` code.
// Full detail is logged server-side via `logOAuthError` (caller-provided
// logger), never surfaced to the browser.

/**
 * Closed set of OAuth error codes that can appear in the `?error=` query
 * parameter on the landing page. Any value the browser sees MUST be one
 * of these — every code path that surfaces an error goes through
 * {@link mapOAuthError} to enforce the allowlist.
 */
export const OAUTH_ERROR_CODES = [
  'access_denied',
  'no_verified_email',
  'invalid_state',
  'oauth_error',
] as const;

export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

/**
 * Sanitize a raw OAuth error identifier into one of the four allowlisted
 * codes. Unknown inputs collapse to `oauth_error` (AC 4). The caller is
 * responsible for logging the raw value server-side before sanitization.
 *
 * GitHub's public OAuth error set is documented at
 * https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/troubleshooting-authorization-request-errors.
 * The mapping is intentionally narrow — only codes the user can action
 * are surfaced with their own message; everything else (redirect URI
 * mismatch, application suspension, bad credentials, etc.) collapses to
 * the generic bucket.
 */
export function mapOAuthError(raw: string | null | undefined): OAuthErrorCode {
  if (typeof raw !== 'string' || raw === '') {
    return 'oauth_error';
  }
  if (raw === 'access_denied') return 'access_denied';
  if (raw === 'no_verified_email') return 'no_verified_email';
  if (raw === 'invalid_state') return 'invalid_state';
  return 'oauth_error';
}

/**
 * @internal — exported for the OAuth-error-code unit test only. Production
 * callers MUST use {@link mapOAuthError}, which delivers the structured
 * `{ message, severity }` shape; this predicate's existence is purely so
 * the test surface can verify membership without re-typing the allowlist
 * literal.
 */
export function isKnownOAuthErrorCode(code: unknown): code is OAuthErrorCode {
  return typeof code === 'string' && (OAUTH_ERROR_CODES as readonly string[]).includes(code);
}
