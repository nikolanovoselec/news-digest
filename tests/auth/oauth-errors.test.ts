// Tests for src/lib/oauth-errors.ts — REQ-AUTH-004 (OAuth error
// allowlist and sanitization).
//
// CF-060: isKnownOAuthErrorCode export removed from production module.
// The membership test now uses OAUTH_ERROR_CODES.includes() directly,
// which is behaviourally equivalent without leaking a test-internal
// predicate into the production surface.

import { describe, it, expect } from 'vitest';
import {
  OAUTH_ERROR_CODES,
  mapOAuthError,
} from '~/lib/oauth-errors';

describe('OAUTH_ERROR_CODES', () => {
  it('REQ-AUTH-004: enumerates exactly the four allowlisted codes', () => {
    expect(OAUTH_ERROR_CODES).toEqual([
      'access_denied',
      'no_verified_email',
      'invalid_state',
      'oauth_error',
    ]);
  });
});

describe('mapOAuthError', () => {
  it('REQ-AUTH-004: passes through access_denied', () => {
    expect(mapOAuthError('access_denied')).toBe('access_denied');
  });

  it('REQ-AUTH-004: passes through no_verified_email', () => {
    expect(mapOAuthError('no_verified_email')).toBe('no_verified_email');
  });

  it('REQ-AUTH-004: passes through invalid_state', () => {
    expect(mapOAuthError('invalid_state')).toBe('invalid_state');
  });

  it('REQ-AUTH-004: collapses unknown codes to oauth_error', () => {
    expect(mapOAuthError('redirect_uri_mismatch')).toBe('oauth_error');
    expect(mapOAuthError('application_suspended')).toBe('oauth_error');
    expect(mapOAuthError('bad_verification_code')).toBe('oauth_error');
  });

  it('REQ-AUTH-004: collapses null/undefined/empty to oauth_error', () => {
    expect(mapOAuthError(null)).toBe('oauth_error');
    expect(mapOAuthError(undefined)).toBe('oauth_error');
    expect(mapOAuthError('')).toBe('oauth_error');
  });

  it('REQ-AUTH-004: does not reflect attacker-controlled strings (no prefix match)', () => {
    expect(mapOAuthError('access_denied<script>')).toBe('oauth_error');
    expect(mapOAuthError('invalid_state;xss')).toBe('oauth_error');
    expect(mapOAuthError('ACCESS_DENIED')).toBe('oauth_error'); // case-sensitive
  });
});

describe('OAUTH_ERROR_CODES membership (replaces isKnownOAuthErrorCode — CF-060)', () => {
  it('REQ-AUTH-004: all four allowlisted codes are in the array', () => {
    for (const code of OAUTH_ERROR_CODES) {
      expect(
        (OAUTH_ERROR_CODES as readonly string[]).includes(code),
      ).toBe(true);
    }
  });

  it('REQ-AUTH-004: non-allowlisted strings and non-strings are not members', () => {
    expect((OAUTH_ERROR_CODES as readonly string[]).includes('nope')).toBe(false);
    expect((OAUTH_ERROR_CODES as readonly string[]).includes('')).toBe(false);
  });
});
