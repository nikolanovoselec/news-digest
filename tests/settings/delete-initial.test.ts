// Tests for src/pages/api/tags/delete-initial.ts + the conditional
// Restore / Delete-all buttons on /settings — REQ-SET-002 AC 8.
//
// Endpoint contract (rewritten; filename + URL kept for git-blame
// continuity):
//   - POST /api/tags/delete-initial clears the user's entire
//     hashtags_json to '[]' regardless of whether a tag came from the
//     default seed or was added custom.
//   - 303-redirects to /digest on success.
//   - Origin check enforced (REQ-AUTH-003).
//   - Unauthenticated callers get a 303 back to the login flow, not
//     a 401 — the flow is a native form submit and the browser
//     follows the redirect transparently.
//
// Visibility contract (from the settings.astro ?raw source):
//   - Restore shown ⇔ at least one default is missing from the user's list
//   - Delete all shown ⇔ user has at least one tag (hides when list empty)

import { describe, it, expect, vi } from 'vitest';
import { POST } from '~/pages/api/tags/delete-initial';
import { SESSION_COOKIE_NAME } from '~/middleware/auth';
import { signSession } from '~/lib/session-jwt';
import {
  DEFAULT_HASHTAGS,
  DELETE_ALL_TAGS_LABEL,
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

  it('REQ-SET-002: clears the entire list when the user has defaults + customs', async () => {
    const bindings: { sql: string; params: unknown[] }[] = [];
    const db = makeDb(
      userWith(
        JSON.stringify([...DEFAULT_HASHTAGS, 'ikea', 'dostoevsky']),
      ),
      bindings,
    );
    const req = await postRequest(await signedCookie());
    const res = await POST(makeContext(req, env(db)) as never);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/digest');
    const upd = bindings.find((b) => b.sql.includes('UPDATE users'));
    expect(upd).toBeDefined();
    const persisted = JSON.parse(upd!.params[0] as string) as string[];
    expect(persisted).toEqual([]);
  });

  it('REQ-SET-002: clears a custom-only list (no defaults preserved)', async () => {
    const bindings: { sql: string; params: unknown[] }[] = [];
    const db = makeDb(
      userWith(JSON.stringify(['ikea', 'dostoevsky'])),
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

  it('REQ-SET-002: clears a defaults-only list', async () => {
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

  it('REQ-SET-002: persists an empty list even when hashtags_json is malformed', async () => {
    // Endpoint ignores the incoming value and hard-writes '[]', so a
    // corrupt row is recovered-to-empty by a single click — a useful
    // safety valve for legacy data shapes.
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

describe('settings.astro — Restore + Delete-all visibility (REQ-SET-002 AC 8)', () => {
  it('REQ-SET-002: settings.astro imports DELETE_ALL_TAGS_LABEL and uses it as the button label', () => {
    expect(settingsPage).toContain('DELETE_ALL_TAGS_LABEL');
    expect(DELETE_ALL_TAGS_LABEL).toBe('Delete all tags');
  });

  it('REQ-SET-002: the Restore form is wrapped in a showRestoreButton guard so it disappears when every default is already present', () => {
    expect(settingsPage).toContain('showRestoreButton');
    expect(settingsPage).toMatch(
      /\{showRestoreButton\s*&&[\s\S]{0,200}action="\/api\/tags\/restore"/,
    );
  });

  it('REQ-SET-002: the Delete-all form is wrapped in a showDeleteAllButton guard so it only appears when the user has at least one tag', () => {
    expect(settingsPage).toContain('showDeleteAllButton');
    expect(settingsPage).toMatch(
      /\{showDeleteAllButton\s*&&[\s\S]{0,200}action="\/api\/tags\/delete-initial"/,
    );
  });

  it('REQ-SET-002: showRestoreButton is computed as "at least one default is missing from the user list"', () => {
    expect(settingsPage).toMatch(
      /showRestoreButton\s*=\s*DEFAULT_HASHTAGS\.some\([\s\S]{0,60}!userHashtagSet\.has/,
    );
  });

  it('REQ-SET-002: showDeleteAllButton is computed as "user has at least one tag"', () => {
    expect(settingsPage).toMatch(
      /showDeleteAllButton\s*=\s*userHashtags\.length\s*>\s*0/,
    );
    // Regression guard: the old defaults+customs composite condition
    // is gone.
    expect(settingsPage).not.toMatch(/userHasAnyDefault\s*&&\s*userHasAnyCustom/);
  });
});
