// Implements REQ-OPS-008
// Implements REQ-AUTH-001
//
// Operator-only kicker for the backend-driven full pipeline run. POST
// /api/admin/pipeline-run creates one `pipeline_runs` row and enqueues
// exactly one `pipeline-jobs` queue message; the consumer drives the
// rest of the phases without an open browser tab.
//
// Body (JSON, optional): `{ "mode": "full" | "wipe" }`. Defaults to
// 'full' (keep existing embeddings, scrape + dedup). 'wipe' starts at
// reembed_flip — every article's embedding is invalidated and re-
// computed before scraping resumes.
//
// Three-layer admin auth (CF-001) — same gate every other admin route
// uses. No Origin check on POST so the dev-bypass curl flow works.

import type { APIContext } from 'astro';
import { log } from '~/lib/log';
import { requireAdminSession } from '~/middleware/admin-auth';
import { applyRefreshCookie } from '~/middleware/auth';
import { originOf } from '~/middleware/origin-check';
import { generateUlid } from '~/lib/ulid';
import type { PipelinePhase } from '~/queue/pipeline-consumer';

interface KickResult {
  ok: true;
  pipeline_run_id: string;
  mode: 'full' | 'wipe';
  current_phase: PipelinePhase;
  started_at: number;
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (typeof env.APP_URL !== 'string' || env.APP_URL === '') {
    return new Response('Application not configured', { status: 500 });
  }
  const appOrigin = originOf(env.APP_URL);
  const wantsJson = (context.request.headers.get('Accept') ?? '').includes(
    'application/json',
  );

  const adminAuth = await requireAdminSession(context);
  if (!adminAuth.ok) {
    if (wantsJson) return adminAuth.response;
    return new Response(null, {
      status: 303,
      headers: { Location: `${appOrigin}/settings?pipeline=denied` },
    });
  }

  const mode = await parseMode(context.request);
  const initialPhase: PipelinePhase =
    mode === 'wipe' ? 'reembed_flip' : 'scrape_kick';
  const pipelineRunId = generateUlid();
  const now = Math.floor(Date.now() / 1000);

  try {
    await env.DB
      .prepare(
        `INSERT INTO pipeline_runs
           (id, status, mode, current_phase, embed_processed, embed_remaining,
            started_at, updated_at)
         VALUES (?1, 'running', ?2, ?3, 0, 0, ?4, ?4)`,
      )
      .bind(pipelineRunId, mode, initialPhase, now)
      .run();

    await env.PIPELINE_JOBS.send({
      pipeline_run_id: pipelineRunId,
      phase: initialPhase,
    });
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'pipeline_kick_failed',
      pipeline_run_id: pipelineRunId,
      detail: String(err).slice(0, 500),
    });
    try {
      await env.DB
        .prepare(
          `UPDATE pipeline_runs
              SET status = 'failed',
                  updated_at = ?2,
                  error = ?3
            WHERE id = ?1
              AND status = 'running'`,
        )
        .bind(pipelineRunId, now, String(err).slice(0, 500))
        .run();
    } catch {
      /* swallow */
    }
    if (wantsJson) {
      return applyRefreshCookie(
        new Response(
          JSON.stringify({ ok: false, error: 'pipeline_kick_failed' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        ),
        adminAuth,
      );
    }
    return applyRefreshCookie(
      new Response(null, {
        status: 303,
        headers: { Location: `${appOrigin}/settings?pipeline=error` },
      }),
      adminAuth,
    );
  }

  log('info', 'digest.generation', {
    status: 'pipeline_kicked',
    pipeline_run_id: pipelineRunId,
    mode,
    initial_phase: initialPhase,
  });

  if (wantsJson) {
    const body: KickResult = {
      ok: true,
      pipeline_run_id: pipelineRunId,
      mode,
      current_phase: initialPhase,
      started_at: now,
    };
    return applyRefreshCookie(
      new Response(JSON.stringify(body, null, 2), {
        status: 202,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }),
      adminAuth,
    );
  }

  return applyRefreshCookie(
    new Response(null, {
      status: 303,
      headers: {
        Location: `${appOrigin}/settings?pipeline=enqueued&pipeline_run_id=${pipelineRunId}`,
      },
    }),
    adminAuth,
  );
}

async function parseMode(request: Request): Promise<'full' | 'wipe'> {
  try {
    const raw = await request.text();
    if (raw === '') return 'full';
    if (raw.startsWith('{')) {
      const body = JSON.parse(raw) as { mode?: unknown };
      if (body.mode === 'wipe') return 'wipe';
      return 'full';
    }
    // form-encoded body from a button submit
    const params = new URLSearchParams(raw);
    return params.get('mode') === 'wipe' ? 'wipe' : 'full';
  } catch {
    return 'full';
  }
}
