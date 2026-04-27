// Tests for src/middleware/admin-auth.ts — CF-001 (three-layer admin
// gate: Cloudflare Access header, Worker-side session, ADMIN_EMAIL
// match) and CF-072 (JWT sv mismatch flow through the admin path).
//
// Implements REQ-AUTH-001.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireAdminSession } from '~/middleware/admin-auth';
import { signSession } from '~/lib/session-jwt';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';
import { base64UrlEncode } from '~/lib/crypto';

const SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length-1';
const ADMIN_EMAIL = 'admin@example.com';

function makeAccessJwt(claims: Record<string, unknown>): string {
  const enc = new TextEncoder();
  const headerB64 = base64UrlEncode(enc.encode(JSON.stringify({ alg: 'RS256' })));
  const payloadB64 = base64UrlEncode(enc.encode(JSON.stringify(claims)));
  // Signature is opaque to the decoder (we never verify it in-Worker —
  // Cloudflare Access already verified before forwarding).
  return `${headerB64}.${payloadB64}.signature`;
}

interface UserRow {
  id: string;
  email: string;
  gh_login: string;
  tz: string;
  digest_hour: number | null;
  digest_minute: number;
  hashtags_json: string | null;
  model_id: string | null;
  email_enabled: number;
  session_version: number;
}

function defaultUserRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'user-1',
    email: ADMIN_EMAIL,
    gh_login: 'admin',
    tz: 'UTC',
    digest_hour: 8,
    digest_minute: 0,
    hashtags_json: null,
    model_id: null,
    email_enabled: 1,
    session_version: 1,
    ...overrides,
  };
}

function makeDb(row: UserRow | null): D1Database {
  const first = vi.fn().mockResolvedValue(row);
  const bind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare } as unknown as D1Database;
}

interface FakeContext {
  request: Request;
  locals: {
    runtime: {
      env: {
        DB: D1Database;
        OAUTH_JWT_SECRET: string;
        ADMIN_EMAIL: string;
        CF_ACCESS_AUD?: string;
      };
    };
  };
}

async function makeContext(opts: {
  accessJwt: string | null;
  cookieJwt: string | null;
  row: UserRow | null;
  cfAccessAud?: string;
}): Promise<FakeContext> {
  const headers = new Headers();
  if (opts.accessJwt !== null) {
    headers.set('Cf-Access-Jwt-Assertion', opts.accessJwt);
  }
  if (opts.cookieJwt !== null) {
    headers.set('Cookie', `${SESSION_COOKIE_NAME}=${opts.cookieJwt}`);
  }
  return {
    request: new Request('https://news.example.com/api/admin/force-refresh', {
      method: 'POST',
      headers,
    }),
    locals: {
      runtime: {
        env: {
          DB: makeDb(opts.row),
          OAUTH_JWT_SECRET: SECRET,
          ADMIN_EMAIL,
          ...(opts.cfAccessAud !== undefined ? { CF_ACCESS_AUD: opts.cfAccessAud } : {}),
        },
      },
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('requireAdminSession — Layer 1: Cf-Access-Jwt-Assertion', () => {
  it('CF-001: returns 401 when the Access header is missing', async () => {
    const ctx = await makeContext({ accessJwt: null, cookieJwt: null, row: null });
    const result = await requireAdminSession(ctx as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it('CF-001: returns 401 when the Access header is empty', async () => {
    const ctx = await makeContext({ accessJwt: '', cookieJwt: null, row: null });
    const result = await requireAdminSession(ctx as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it('CF-001: validates aud claim when CF_ACCESS_AUD is configured', async () => {
    const goodJwt = makeAccessJwt({ aud: 'tenant-aud-tag' });
    const badJwt = makeAccessJwt({ aud: 'other-tenant' });
    const jwt = await signSession(
      { sub: 'user-1', email: ADMIN_EMAIL, ghl: 'admin', sv: 1 },
      SECRET,
    );

    const goodCtx = await makeContext({
      accessJwt: goodJwt,
      cookieJwt: jwt,
      row: defaultUserRow(),
      cfAccessAud: 'tenant-aud-tag',
    });
    const goodResult = await requireAdminSession(goodCtx as never);
    expect(goodResult.ok).toBe(true);

    const badCtx = await makeContext({
      accessJwt: badJwt,
      cookieJwt: jwt,
      row: defaultUserRow(),
      cfAccessAud: 'tenant-aud-tag',
    });
    const badResult = await requireAdminSession(badCtx as never);
    expect(badResult.ok).toBe(false);
  });
});

describe('requireAdminSession — Layer 2: session', () => {
  it('CF-001: returns 401 when the session cookie is absent', async () => {
    const ctx = await makeContext({
      accessJwt: makeAccessJwt({}),
      cookieJwt: null,
      row: null,
    });
    const result = await requireAdminSession(ctx as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it('CF-072: returns 401 when the session_version mismatches the user row', async () => {
    const jwt = await signSession(
      { sub: 'user-1', email: ADMIN_EMAIL, ghl: 'admin', sv: 1 },
      SECRET,
    );
    const ctx = await makeContext({
      accessJwt: makeAccessJwt({}),
      cookieJwt: jwt,
      // Row's sv is now 2 — the JWT carrying sv=1 is stale.
      row: defaultUserRow({ session_version: 2 }),
    });
    const result = await requireAdminSession(ctx as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });
});

describe('requireAdminSession — Layer 3: ADMIN_EMAIL match', () => {
  it('CF-001: returns 403 when the session email does NOT match ADMIN_EMAIL', async () => {
    const jwt = await signSession(
      { sub: 'user-2', email: 'nobody@example.com', ghl: 'nobody', sv: 1 },
      SECRET,
    );
    const ctx = await makeContext({
      accessJwt: makeAccessJwt({}),
      cookieJwt: jwt,
      row: defaultUserRow({ id: 'user-2', email: 'nobody@example.com' }),
    });
    const result = await requireAdminSession(ctx as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
  });

  it('CF-001: passes when all three layers match', async () => {
    const jwt = await signSession(
      { sub: 'user-1', email: ADMIN_EMAIL, ghl: 'admin', sv: 1 },
      SECRET,
    );
    const ctx = await makeContext({
      accessJwt: makeAccessJwt({}),
      cookieJwt: jwt,
      row: defaultUserRow(),
    });
    const result = await requireAdminSession(ctx as never);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe('user-1');
      expect(result.email).toBe(ADMIN_EMAIL);
    }
  });

  it('CF-001: ADMIN_EMAIL match is case-insensitive', async () => {
    const jwt = await signSession(
      { sub: 'user-1', email: ADMIN_EMAIL.toUpperCase(), ghl: 'admin', sv: 1 },
      SECRET,
    );
    const ctx = await makeContext({
      accessJwt: makeAccessJwt({}),
      cookieJwt: jwt,
      row: defaultUserRow({ email: ADMIN_EMAIL.toUpperCase() }),
    });
    const result = await requireAdminSession(ctx as never);
    expect(result.ok).toBe(true);
  });
});
