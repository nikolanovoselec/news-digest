// Implements REQ-AUTH-005
//
// DELETE /api/auth/account — permanently delete the authenticated
// user's account and all cascaded data.
//
// Request body: `{ "confirm": "DELETE" }` — explicit string confirmation
// required; anything else is rejected. The Origin check (REQ-AUTH-003)
// is applied first to block cross-site CSRF. Foreign-key ON DELETE
// CASCADE (see migrations/0001_initial.sql) removes every related
// `digests`, `articles`, and `pending_discoveries` row atomically with
// the users row removal.
//
// KV entries keyed by the user's id are enumerated and deleted after
// the row delete so a failure there does not block account removal
// itself (AC 4 — best-effort on KV, required on D1).

import type { APIContext } from 'astro';
import { applyForeignKeysPragma } from '~/lib/db';
import { errorResponse } from '~/lib/errors';
import { log } from '~/lib/log';
import { loadSession, buildClearSessionCookie } from '~/middleware/auth';
import { checkOrigin, originOf } from '~/middleware/origin-check';

interface DeleteAccountBody {
  confirm?: unknown;
}

/**
 * Delete every KV key that belongs to {@link userId}. We namespace
 * by the user id (`user:<id>:...`) so the list prefix is enough. The
 * KV list API returns up to 1000 keys per page; we paginate via cursor
 * until the set is empty.
 */
async function deleteUserKvEntries(kv: KVNamespace, userId: string): Promise<void> {
  const prefix = `user:${userId}:`;
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, ...(cursor !== undefined ? { cursor } : {}) });
    await Promise.all(page.keys.map((k) => kv.delete(k.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
}

/**
 * Shared core: run Origin + session checks + confirmation validation,
 * cascade-delete the user row, best-effort KV cleanup, clear the
 * session cookie. Called by both DELETE (JSON API path) and POST
 * (native-form path).
 *
 * Returns either an errorResponse (not-ok) or an object with the
 * userId so the caller can shape the final Response to the caller's
 * preferred format (JSON vs 303 redirect).
 */
async function deleteAccountCore(
  context: APIContext,
  confirm: unknown,
): Promise<
  { ok: true; userId: string; clearCookie: string } | { ok: false; response: Response }
> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return { ok: false, response: errorResponse('app_not_configured') };
  }
  const appOrigin = originOf(env.APP_URL);

  const originResult = checkOrigin(context.request, appOrigin);
  if (!originResult.ok) {
    return { ok: false, response: originResult.response! };
  }

  const session = await loadSession(context.request, env.DB, env.OAUTH_JWT_SECRET);
  if (session === null) {
    return { ok: false, response: errorResponse('unauthorized') };
  }

  if (confirm !== 'DELETE') {
    return { ok: false, response: errorResponse('confirmation_required') };
  }

  const userId = session.user.id;

  try {
    // D1 requires the FK pragma per connection for ON DELETE CASCADE
    // to fire. Without it the users row goes but the child rows stay.
    await applyForeignKeysPragma(env.DB);
    const result = await env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(userId).run();
    if (result.meta === undefined || result.meta.changes === 0) {
      // Race with a concurrent logout or already-deleted account —
      // still clear the cookie and return success from the user's POV.
      log('warn', 'auth.account.delete', {
        user_id: userId,
        detail: 'no row affected',
      });
    }
  } catch (err) {
    log('error', 'auth.account.delete.failed', {
      user_id: userId,
      error_code: 'internal_error',
      detail: String(err).slice(0, 500),
    });
    return { ok: false, response: errorResponse('internal_error') };
  }

  // Best-effort KV cleanup (AC 4). Failure here is logged but does
  // not roll back the D1 delete — once the user row is gone the
  // account is effectively deleted from the user's perspective.
  try {
    await deleteUserKvEntries(env.KV, userId);
  } catch (err) {
    log('error', 'auth.account.delete.failed', {
      user_id: userId,
      error_code: 'kv_cleanup_failed',
      detail: String(err).slice(0, 500),
    });
  }

  log('info', 'auth.account.delete', { user_id: userId });

  return { ok: true, userId, clearCookie: buildClearSessionCookie() };
}

export async function DELETE(context: APIContext): Promise<Response> {
  // JSON API path — fetch('/api/auth/account', { method: 'DELETE',
  // body: JSON.stringify({ confirm: 'DELETE' }) }).
  let body: DeleteAccountBody;
  try {
    body = (await context.request.json()) as DeleteAccountBody;
  } catch {
    return errorResponse('bad_request');
  }

  const result = await deleteAccountCore(context, body.confirm);
  if (!result.ok) return result.response;

  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', result.clearCookie);
  return new Response(
    JSON.stringify({ ok: true, redirect: `/?account_deleted=1` }),
    { status: 200, headers },
  );
}

export async function POST(context: APIContext): Promise<Response> {
  // Native-form path — <form method="post" action="/api/auth/account">
  // with `<input name="confirm">`. Browser submits form-encoded body
  // so the JS intercept layer (which was flaky across Samsung Browser
  // and some in-app webviews) is bypassed entirely. Returns a 303
  // redirect so the browser navigates to the landing page with a
  // query param the UI can pick up to show "your account was
  // deleted" confirmation.
  // Guard: reject an explicitly empty body before touching
  // formData(). Native browser form POSTs set Content-Length to the
  // encoded length, so a zero here means a programmatic caller sent
  // nothing — which can't satisfy the confirmation contract anyway.
  // Also cheaper than letting formData() throw and catching the
  // TypeError. Absent header (chunked encoding) passes through and
  // takes the try/catch path below as before.
  const contentLength = context.request.headers.get('content-length');
  if (contentLength === '0') {
    return errorResponse('bad_request');
  }

  let confirm: FormDataEntryValue | null = null;
  try {
    const form = await context.request.formData();
    confirm = form.get('confirm');
  } catch {
    return errorResponse('bad_request');
  }

  const result = await deleteAccountCore(
    context,
    typeof confirm === 'string' ? confirm : null,
  );
  if (!result.ok) return result.response;

  const headers = new Headers({ Location: '/?account_deleted=1' });
  headers.append('Set-Cookie', result.clearCookie);
  return new Response(null, { status: 303, headers });
}
