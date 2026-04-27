// Implements REQ-SET-006
//
// GET /api/discovery/status — return the set of hashtags the
// authenticated user has queued for background source discovery.
//
// The settings page polls this endpoint after a save so it can show a
// "Still discovering sources for #foo" note alongside the digest the
// user just generated. Pending rows are written by PUT /api/settings
// (INSERT OR IGNORE into `pending_discoveries`) and drained by the
// discovery worker in Phase 4.

import type { APIContext } from 'astro';
import { errorResponse } from '~/lib/errors';
import { log } from '~/lib/log';
import { requireSession } from '~/middleware/auth';

/** Row shape returned by the SELECT below. */
interface PendingRow {
  tag: string;
}

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return errorResponse('app_not_configured');
  }

  const auth = await requireSession(context.request, env);
  if (!auth.ok) return auth.response;

  let rows: PendingRow[];
  try {
    const result = await env.DB.prepare(
      'SELECT tag FROM pending_discoveries WHERE user_id = ?1',
    )
      .bind(auth.user.id)
      .all<PendingRow>();
    rows = result.results ?? [];
  } catch (err) {
    log('error', 'discovery.queued', {
      user_id: auth.user.id,
      error_code: 'internal_error',
      detail: String(err).slice(0, 500),
    });
    return errorResponse('internal_error');
  }

  const pending = rows.map((r) => r.tag);

  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  for (const c of auth.cookiesToSet) headers.append('Set-Cookie', c);

  return new Response(JSON.stringify({ pending }), { status: 200, headers });
}
