// Tests for src/lib/errors.ts — REQ-OPS-002 (sanitized error surfaces).
// Verifies the ErrorCode enum, the USER_FACING_MESSAGES registry, and the
// errorResponse() helper shape.

import { describe, it, expect } from 'vitest';
import {
  USER_FACING_MESSAGES_FOR_TESTS as USER_FACING_MESSAGES,
  errorResponse,
  type ErrorCode,
} from '~/lib/errors';

/** Every ErrorCode the spec mandates must exist in USER_FACING_MESSAGES and
 * be reachable via errorResponse(). Keeping the list duplicated here (not
 * derived from the type system) is deliberate — if a code is added to the
 * union but someone forgets to update the message registry, the test below
 * fails cleanly. */
const ALL_ERROR_CODES: ErrorCode[] = [
  // Digest generation
  'llm_invalid_json',
  'llm_failed',
  'all_sources_failed',
  'generation_stalled',
  'user_cancelled',
  // Request layer
  'rate_limited',
  'forbidden_origin',
  'not_found',
  'invalid_state',
  'already_in_progress',
  // OAuth / session
  'no_verified_email',
  'access_denied',
  'oauth_error',
  // Settings validation
  'invalid_hashtags',
  'invalid_time',
  'invalid_model_id',
  'invalid_email_enabled',
  'invalid_tz',
  'unknown_tag',
];

describe('USER_FACING_MESSAGES', () => {
  it('REQ-OPS-002: contains an entry for every ErrorCode', () => {
    for (const code of ALL_ERROR_CODES) {
      expect(USER_FACING_MESSAGES).toHaveProperty(code);
    }
  });

  it('REQ-OPS-002: every message is a non-empty string', () => {
    for (const code of ALL_ERROR_CODES) {
      const msg = USER_FACING_MESSAGES[code];
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it('REQ-OPS-002: messages do not leak stack traces, internal paths, or vendor product names', () => {
    const forbiddenFragments = [
      /\bstack\b/i,
      /\bat .*\.ts:\d+/, // stack frame pattern
      /\.ts\b/,
      /\.js\b/,
      /workers?\.dev/i,
      /cloudflare/i,
      /github\.com\b/i,
      /d1 /i,
      /sqlite/i,
      /resend/i,
      /hmac/i,
      /openai/i,
      /anthropic/i,
    ];
    for (const code of ALL_ERROR_CODES) {
      const msg = USER_FACING_MESSAGES[code];
      for (const pat of forbiddenFragments) {
        expect(msg, `message for ${code} matched forbidden pattern ${pat}`).not.toMatch(pat);
      }
    }
  });
});

describe('errorResponse', () => {
  it('REQ-OPS-002: returns an HTTP Response', () => {
    const res = errorResponse('not_found');
    expect(res).toBeInstanceOf(Response);
  });

  it('REQ-OPS-002: sets Content-Type to application/json', () => {
    const res = errorResponse('not_found');
    const ct = res.headers.get('Content-Type');
    expect(ct).toMatch(/application\/json/);
  });

  it('REQ-OPS-002: body carries the code and the generic user-facing message', async () => {
    const res = errorResponse('llm_failed');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('llm_failed');
    expect(body.error).toBe(USER_FACING_MESSAGES.llm_failed);
  });

  it('REQ-OPS-002: merges extras into the body without dropping code/error', async () => {
    const res = errorResponse('rate_limited', { retry_after_seconds: 30 });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('rate_limited');
    expect(body.error).toBe(USER_FACING_MESSAGES.rate_limited);
    expect(body.retry_after_seconds).toBe(30);
  });

  it('REQ-OPS-002: extras cannot override the code field', async () => {
    const res = errorResponse('rate_limited', { code: 'oauth_error' });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('rate_limited');
  });

  it('REQ-OPS-002: extras cannot override the error field', async () => {
    const res = errorResponse('rate_limited', { error: 'raw upstream detail' });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe(USER_FACING_MESSAGES.rate_limited);
  });

  it('REQ-OPS-002: default status for rate_limited is 429', () => {
    expect(errorResponse('rate_limited').status).toBe(429);
  });

  it('REQ-OPS-002: default status for forbidden_origin is 403', () => {
    expect(errorResponse('forbidden_origin').status).toBe(403);
  });

  it('REQ-OPS-002: default status for not_found is 404', () => {
    expect(errorResponse('not_found').status).toBe(404);
  });

  it('REQ-OPS-002: default status for already_in_progress is 409', () => {
    expect(errorResponse('already_in_progress').status).toBe(409);
  });

  it('REQ-OPS-002: status override is honoured', () => {
    // Pass an empty extras object so the status override is the 3rd arg.
    expect(errorResponse('not_found', {}, 410).status).toBe(410);
  });

  it('REQ-OPS-002: every code yields a response with a 4xx or 5xx status', () => {
    for (const code of ALL_ERROR_CODES) {
      const res = errorResponse(code);
      expect(res.status, `status for ${code}`).toBeGreaterThanOrEqual(400);
      expect(res.status, `status for ${code}`).toBeLessThan(600);
    }
  });
});
