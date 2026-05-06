// Implements REQ-PIPE-003
// Implements REQ-AUTH-001
//
// Operator-only diagnostic route for tuning the dedup threshold.
// GET /api/admin/dedup-diag?a=<article_id>&b=<article_id>
//
// Returns the cosine similarity between two articles' stored vectors
// plus a same-vendor flag and the current effective threshold. Used
// to inspect the cosine distribution across known true / false
// positives before committing to a threshold change.
//
// Three-layer admin auth (CF-001) — same gate every other admin route
// uses. No Origin check on GET (read-only) and the route is also
// driven from curl / scripts via the dev-bypass session.

import type { APIContext } from 'astro';
import { log } from '~/lib/log';
import { requireAdminSession } from '~/middleware/admin-auth';
import { applyRefreshCookie } from '~/middleware/auth';
import {
  cosineSimilarity,
  readCosineThreshold,
  readSameVendorPenalty,
} from '~/lib/embeddings';
import { etldPlusOne } from '~/lib/etld';

interface ArticleSide {
  id: string;
  title: string;
  primary_source_url: string;
  host: string;
  etld1: string;
  embedding_status: string | null;
}

interface DiagSuccess {
  ok: true;
  a: ArticleSide;
  b: ArticleSide;
  cosine: number;
  same_etld1: boolean;
  /** Effective score after the same-vendor cosine penalty has been
   *  applied (cosine - DEDUP_SAME_VENDOR_PENALTY when same_etld1, else
   *  cosine). The dedup pipeline compares this to `threshold`, so it's
   *  what an operator should look at when judging whether the pair
   *  would merge today. */
  adjusted_score: number;
  /** Active same-vendor penalty in effect at request time. */
  same_vendor_penalty: number;
  threshold: number;
  above_threshold: boolean;
}

interface DiagError {
  ok: false;
  error: string;
}

interface ArticleRow {
  id: string;
  title: string;
  primary_source_url: string;
  embedding_status: string | null;
}

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  const adminAuth = await requireAdminSession(context);
  if (!adminAuth.ok) return adminAuth.response;

  const aId = context.url.searchParams.get('a');
  const bId = context.url.searchParams.get('b');
  if (aId === null || aId === '' || bId === null || bId === '') {
    return jsonResponse({ ok: false, error: 'missing_a_or_b' }, 400, adminAuth);
  }
  if (aId === bId) {
    return jsonResponse({ ok: false, error: 'identical_ids' }, 400, adminAuth);
  }

  const [aRow, bRow] = await Promise.all([
    selectArticle(env.DB, aId),
    selectArticle(env.DB, bId),
  ]);
  if (aRow === null || bRow === null) {
    return jsonResponse(
      { ok: false, error: 'article_not_found' },
      404,
      adminAuth,
    );
  }

  let aVec: number[] | null = null;
  let bVec: number[] | null = null;
  try {
    const vecs = await env.VECTORIZE.getByIds([aId, bId]);
    for (const v of vecs) {
      if (v.id === aId) aVec = v.values as number[];
      else if (v.id === bId) bVec = v.values as number[];
    }
  } catch (err) {
    log('error', 'digest.generation', {
      status: 'dedup_diag_vectorize_failed',
      detail: String(err).slice(0, 500),
    });
    return jsonResponse(
      { ok: false, error: 'vectorize_lookup_failed' },
      500,
      adminAuth,
    );
  }
  if (aVec === null || bVec === null) {
    return jsonResponse(
      { ok: false, error: 'vector_not_found' },
      404,
      adminAuth,
    );
  }

  const cosine = cosineSimilarity(aVec, bVec);
  const a = buildSide(aRow);
  const b = buildSide(bRow);
  const sameEtld1 = a.etld1 === b.etld1 && a.etld1 !== '';
  const threshold = readCosineThreshold(env);
  const sameVendorPenalty = readSameVendorPenalty(env);
  const adjustedScore = sameEtld1 ? cosine - sameVendorPenalty : cosine;

  const result: DiagSuccess = {
    ok: true,
    a,
    b,
    cosine,
    same_etld1: sameEtld1,
    adjusted_score: adjustedScore,
    same_vendor_penalty: sameVendorPenalty,
    threshold,
    above_threshold: adjustedScore >= threshold,
  };
  return jsonResponse(result, 200, adminAuth);
}

async function selectArticle(
  db: D1Database,
  id: string,
): Promise<ArticleRow | null> {
  const row = await db
    .prepare(
      `SELECT id, title, primary_source_url, embedding_status
         FROM articles WHERE id = ?1`,
    )
    .bind(id)
    .first<ArticleRow>();
  return row ?? null;
}

function buildSide(row: ArticleRow): ArticleSide {
  let host = '';
  try {
    host = new URL(row.primary_source_url).host;
  } catch {
    host = '';
  }
  return {
    id: row.id,
    title: row.title,
    primary_source_url: row.primary_source_url,
    host,
    etld1: host === '' ? '' : etldPlusOne(host),
    embedding_status: row.embedding_status,
  };
}

function jsonResponse(
  body: DiagSuccess | DiagError,
  status: number,
  adminAuth: { cookiesToSet: readonly string[] },
): Response {
  return applyRefreshCookie(
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }),
    adminAuth,
  );
}
