// Tests for src/pages/api/tags/delete-initial.ts + the conditional
// Restore / Delete buttons on /settings — REQ-SET-002 AC 8.
//
// Endpoint contract:
//   - POST /api/tags/delete-initial strips DEFAULT_HASHTAGS entries
//     from the user's hashtags_json, keeping custom tags intact.
//   - 303-redirects to /digest on success.
//   - Origin check enforced (REQ-AUTH-003).
//   - Unauthenticated callers get a 303 back to the login flow, not
//     a 401 — the flow is a native form submit and the browser
//     follows the redirect transparently.
//
// Visibility contract (from the settings.astro ?raw source):
//   - Restore shown ⇔ at least one default is missing from the user's list
//   - Delete  shown ⇔ user has at least one default AND at least one custom

import { describe, it, expect, vi } from 'vitest';
import { POST } from '~/pages/api/tags/delete-initial';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';
import { signSession } from '~/lib/session-jwt';
import {
  DEFAULT_HASHTAGS,
  DELETE_INITIALS_LABEL,
} from '~/lib/default-hashtags';
import settingsPage from '../../src/pages/settings.astro?raw';

const JWT_SECRET = 'test-secret-for-hmac-sha256-signing-minimum-length';
const APP_URL = 'https://news-digest.example.com';

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

function userWith(hashtagsJson: string | null): UserRow {
  return {
    id: 'u1',
    email: 'u1@example.com',
    gh_login: 'u1',
    tz: 'UTC',
    digest_hour: 8,
    digest_minute: 0,
    hashtags_json: hashtagsJson,
    model_id: null,
    email_enabled: 1,
    session_version: 1,
  };
}

function makeDb(
  user: UserRow,
  bindings: { sql: string; params: unknown[] }[] = [],
): D1Database {
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const stmt = {
      _sql: sql,
      _params: [] as unknown[],
      bind(...params: unknown[]) {
        stmt._params = params;
        return stmt;
      },
      first: vi.fn().mockImplementation(async () => {
        if (sql.includes('FROM users')) return user;
        return null;
      }),
      all: vi.fn().mockResolvedValue({ success: true, results: [] }),
      run: vi.fn().mockImplementation(async () => {
        bindings.push({ sql, params: [...stmt._params] });
        return { success: true, meta: { changes: 1 } };
      }),
    };
    return stmt;
  });
  return { prepare } as unknown as D1Database;
}

function env(db: D1Database): Partial<Env> {
  return { APP_URL, OAUTH_JWT_SECRET: JWT_SECRET, DB: db };
}

function makeContext(request: Request, e: Partial<Env>): unknown {
  return {
    request,
    locals: { runtime: { env: e as Env } },
    url: new URL(request.url),
  };
}

async function signedCookie(): Promise<string> {
  const token = await signSession(
    { sub: 'u1', email: 'u1@example.com', ghl: 'u1', sv: 1 },
    JWT_SECRET,
  );
  return `${SESSION_COOKIE_NAME}=${token}`;
}

async function postRequest(cookie: string | null): Promise<Request> {
  const headers = new Headers({ Origin: APP_URL });
  if (cookie !== null) headers.set('Cookie', cookie);
  return new Request(`${APP_URL}/api/tags/delete-initial`, {
    method: 'POST',
    headers,
  });
}

describe('POST /api/tags/delete-initial — REQ-SET-002 AC 8', () => {
  it('REQ-SET-002: rejects a request with missing or mismatched Origin header (REQ-AUTH-003)', async () => {
    const db = makeDb(userWith(JSON.stringify(['ai', 'cloudflare'])));
    const req = new Request(`${APP_URL}/api/tags/delete-initial`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example.com',
        Cookie: await signedCookie(),
      },
    });
    const res = await POST(makeContext(req, env(db)) as never);
    expect([403, 400]).toContain(res.status);
  });

  it('REQ-SET-002: unauthenticated POST 303-redirects to the login flow', async () => {
    const db = makeDb(userWith(JSON.stringify(DEFAULT_HASHTAGS)));
    const req = await postRequest(null);
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toContain('/api/auth/github/login');
  });

  it('REQ-SET-002: strips every DEFAULT_HASHTAGS entry, keeps custom tags', async () => {
    const custom = ['ikea', 'dostoevsky'];
    const bindings: { sql: string; params: unknown[] }[] = [];
    const db = makeDb(
      userWith(JSON.stringify([...DEFAULT_HASHTAGS, ...custom])),
      bindings,
    );
    const req = await postRequest(await signedCookie());
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/digest');
    const upd = bindings.find((b) => b.sql.includes('UPDATE users'));
    expect(upd).toBeDefined();
    const persisted = JSON.parse(upd!.params[0] as string) as string[];
    // Only customs remain; no default survived.
    expect(persisted).toEqual(custom);
    for (const d of DEFAULT_HASHTAGS) {
      expect(persisted).not.toContain(d);
    }
  });

  it('REQ-SET-002: leaves custom-only lists unchanged (no defaults to strip)', async () => {
    const custom = ['ikea', 'dostoevsky'];
    const bindings: { sql: string; params: unknown[] }[] = [];
    const db = makeDb(userWith(JSON.stringify(custom)), bindings);
    const req = await postRequest(await signedCookie());
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(303);
    const upd = bindings.find((b) => b.sql.includes('UPDATE users'));
    expect(upd).toBeDefined();
    const persisted = JSON.parse(upd!.params[0] as string) as string[];
    expect(persisted).toEqual(custom);
  });

  it('REQ-SET-002: empties the list when the user had only defaults', async () => {
    const bindings: { sql: string; params: unknown[] }[] = [];
    const db = makeDb(
      userWith(JSON.stringify([...DEFAULT_HASHTAGS])),
      bindings,
    );
    const req = await postRequest(await signedCookie());
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(303);
    const upd = bindings.find((b) => b.sql.includes('UPDATE users'));
    expect(upd).toBeDefined();
    const persisted = JSON.parse(upd!.params[0] as string) as string[];
    expect(persisted).toEqual([]);
  });

  it('REQ-SET-002: handles malformed hashtags_json gracefully (treats as empty, persists empty list)', async () => {
    const bindings: { sql: string; params: unknown[] }[] = [];
    const db = makeDb(userWith('not-valid-json{{'), bindings);
    const req = await postRequest(await signedCookie());
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(303);
    const upd = bindings.find((b) => b.sql.includes('UPDATE users'));
    const persisted = JSON.parse(upd!.params[0] as string) as string[];
    expect(persisted).toEqual([]);
  });
});

describe('settings.astro — Restore + Delete visibility (REQ-SET-002 AC 8)', () => {
  it('REQ-SET-002: settings.astro imports DELETE_INITIALS_LABEL and uses it as the button label', () => {
    expect(settingsPage).toContain('DELETE_INITIALS_LABEL');
    expect(DELETE_INITIALS_LABEL).toBe('Delete initial tags');
  });

  it('REQ-SET-002: the Restore form is wrapped in a showRestoreButton guard so it disappears when every default is already present', () => {
    expect(settingsPage).toContain('showRestoreButton');
    // The guard surrounds the <form action="/api/tags/restore"> block.
    expect(settingsPage).toMatch(
      /\{showRestoreButton\s*&&[\s\S]{0,200}action="\/api\/tags\/restore"/,
    );
  });

  it('REQ-SET-002: the Delete-initials form is wrapped in a showDeleteInitialsButton guard so it only appears when the user has both defaults and customs', () => {
    expect(settingsPage).toContain('showDeleteInitialsButton');
    expect(settingsPage).toMatch(
      /\{showDeleteInitialsButton\s*&&[\s\S]{0,200}action="\/api\/tags\/delete-initial"/,
    );
  });

  it('REQ-SET-002: showRestoreButton is computed as "at least one default is missing from the user list"', () => {
    // Arrow function params contain parens, so [\s\S] is required.
    expect(settingsPage).toMatch(
      /showRestoreButton\s*=\s*DEFAULT_HASHTAGS\.some\([\s\S]{0,60}!userHashtagSet\.has/,
    );
  });

  it('REQ-SET-002: showDeleteInitialsButton is computed as "user has at least one default AND at least one custom"', () => {
    expect(settingsPage).toContain('userHasAnyDefault');
    expect(settingsPage).toContain('userHasAnyCustom');
    expect(settingsPage).toMatch(
      /showDeleteInitialsButton\s*=\s*userHasAnyDefault\s*&&\s*userHasAnyCustom/,
    );
  });
});
