// Tests for src/middleware/settings-gate.ts — REQ-SET-006 (redirect
// users whose onboarding is incomplete, and bounce completed users off
// of /settings?first_run=1).

import { describe, it, expect } from 'vitest';
import { requireSettingsComplete } from '~/middleware/settings-gate';
import type { AuthenticatedUser } from '~/lib/types';

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: '12345',
    email: 'alice@example.com',
    gh_login: 'alice',
    tz: 'Europe/Zurich',
    digest_hour: 8,
    digest_minute: 0,
    hashtags_json: JSON.stringify(['ai']),
    model_id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    email_enabled: 1,
    session_version: 1,
    ...overrides,
  };
}

function ctx(path: string, u: AuthenticatedUser | undefined): unknown {
  const request = new Request(`https://example.com${path}`);
  const locals: { user?: AuthenticatedUser } = {};
  if (u !== undefined) locals.user = u;
  return {
    request,
    locals,
    url: new URL(request.url),
  };
}

describe('requireSettingsComplete', () => {
  it('REQ-SET-006: returns null when no user is present', () => {
    const res = requireSettingsComplete(ctx('/digest', undefined) as never);
    expect(res).toBeNull();
  });

  it('REQ-SET-006: returns null for a fully configured user on /digest', () => {
    const res = requireSettingsComplete(ctx('/digest', user()) as never);
    expect(res).toBeNull();
  });

  it('REQ-SET-006: does NOT redirect when hashtags_json is null (tags now edited on /digest)', () => {
    // Hashtags moved out of /settings into the /digest tag strip.
    // A user with digest_hour set and no hashtags_json is free to visit
    // /digest — the empty tag strip prompts them to add their first tag.
    const res = requireSettingsComplete(
      ctx('/digest', user({ hashtags_json: null })) as never,
    );
    expect(res).toBeNull();
  });

  it('REQ-SET-006: redirects to /settings?first_run=1 when digest_hour is null', () => {
    const res = requireSettingsComplete(
      ctx('/digest', user({ digest_hour: null })) as never,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(303);
    expect(res!.headers.get('Location')).toBe('/settings?first_run=1');
  });

  it('REQ-SET-006: does NOT redirect when hashtags_json is empty string (tags now edited on /digest)', () => {
    const res = requireSettingsComplete(
      ctx('/digest', user({ hashtags_json: '' })) as never,
    );
    expect(res).toBeNull();
  });

  it('REQ-SET-006: does NOT redirect when user is already on /settings', () => {
    const res = requireSettingsComplete(
      ctx('/settings', user({ digest_hour: null })) as never,
    );
    expect(res).toBeNull();
  });

  it('REQ-SET-006: does NOT redirect when user is on /settings?first_run=1 and incomplete', () => {
    const res = requireSettingsComplete(
      ctx('/settings?first_run=1', user({ digest_hour: null })) as never,
    );
    expect(res).toBeNull();
  });

  it('REQ-SET-006: bounces a completed user off /settings?first_run=1 to /settings', () => {
    const res = requireSettingsComplete(
      ctx('/settings?first_run=1', user()) as never,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(303);
    expect(res!.headers.get('Location')).toBe('/settings');
  });

  it('REQ-SET-006: does not touch a completed user on /settings (no query)', () => {
    const res = requireSettingsComplete(
      ctx('/settings', user()) as never,
    );
    expect(res).toBeNull();
  });

  it('REQ-SET-006: redirects incomplete users on /history', () => {
    const res = requireSettingsComplete(
      ctx('/history', user({ hashtags_json: null, digest_hour: null })) as never,
    );
    expect(res).not.toBeNull();
    expect(res!.headers.get('Location')).toBe('/settings?first_run=1');
  });
});
