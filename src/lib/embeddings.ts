// Implements REQ-PIPE-003
//
// Workers AI embedding helpers used by the chunk-consumer (new-article
// path), the finalize-consumer (cross-chunk dedup query), and the admin
// embed-backfill / historical-dedup routes.
//
// Model is pinned to `@cf/baai/bge-base-en-v1.5` — 768-dim, English-
// pretrained, cosine-metric. Validated against 11 production articles
// 2026-05-06: same-event Anthropic financial-AI cluster pairwise cosine
// 0.81-0.91; different events 0.77-0.84; unrelated topic <0.73. Threshold
// 0.85 (DEDUP_COSINE_THRESHOLD) catches the cluster cleanly without
// false-merges.
//
// All functions are pure I/O: no D1, no KV, no Vectorize. Callers thread
// the resulting vectors into Vectorize.upsert / Vectorize.query.

/** Pinned embedding model. Changing this without re-embedding the entire
 *  Vectorize index would silently corrupt cosine scores — a different
 *  embedding model produces a different vector geometry, so a query
 *  vector from model B against an index full of model-A vectors returns
 *  meaningless distances. The model id is referenced in the AD33 ADR. */
export const EMBEDDING_MODEL_ID = '@cf/baai/bge-base-en-v1.5';

/** Hard cap on input characters per article. bge-base-en-v1.5 truncates
 *  at ~512 tokens (~2k chars); we trim earlier so the same vocabulary
 *  block lands across all calls regardless of upstream body length. */
const MAX_INPUT_CHARS = 1_800;

/** Hard cap on inputs per Workers AI call. The binding accepts batched
 *  text input but very large batches degrade tail latency. 100 fits
 *  every realistic chunk and the historical-dedup admin route's page
 *  size. */
const MAX_BATCH_SIZE = 100;

/** Per-call cap for `Vectorize.deleteByIds`. The platform paginates
 *  delete requests and rejects oversized payloads — `cleanup.ts` uses
 *  the same 100 ceiling. Centralised here so every call site batches
 *  consistently rather than rediscovering the limit. */
const VECTORIZE_DELETE_BATCH_SIZE = 100;

/** Default cosine threshold when DEDUP_COSINE_THRESHOLD is unset.
 *  Validated 2026-05-06; see the file header for evidence. */
export const DEFAULT_COSINE_THRESHOLD = 0.85;

/** Read the runtime cosine threshold from env, with a safe fallback.
 *  Parses the env var (string-typed in wrangler.toml) and clamps to
 *  [0, 1]. An invalid value falls back to the default rather than
 *  silently disabling dedup with a 0.0 floor. */
export function readCosineThreshold(env: Pick<Env, 'DEDUP_COSINE_THRESHOLD'>): number {
  const raw = env.DEDUP_COSINE_THRESHOLD;
  if (typeof raw !== 'string' || raw === '') return DEFAULT_COSINE_THRESHOLD;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return DEFAULT_COSINE_THRESHOLD;
  }
  return parsed;
}

/** Build the embedding input string for one article. Title + body
 *  prefix, whitespace collapsed, capped at MAX_INPUT_CHARS. The title
 *  is prefixed because bge-base attends to the leading tokens most
 *  strongly; putting the headline first means two articles with the
 *  same headline produce highly-similar vectors even when their bodies
 *  differ in framing. */
export function buildEmbeddingInput(article: {
  title: string;
  details_json?: string | null;
  body_summary?: string | null;
}): string {
  const title = article.title.trim();
  let body = '';
  const detailsRaw = article.details_json;
  if (typeof detailsRaw === 'string' && detailsRaw !== '') {
    try {
      const parsed = JSON.parse(detailsRaw) as unknown;
      if (Array.isArray(parsed)) {
        body = parsed.filter((p): p is string => typeof p === 'string').join(' ');
      } else if (typeof parsed === 'string') {
        body = parsed;
      }
    } catch {
      body = '';
    }
  } else if (typeof article.body_summary === 'string') {
    body = article.body_summary;
  }
  const combined = `${title}\n\n${body}`.replace(/\s+/g, ' ').trim();
  if (combined.length <= MAX_INPUT_CHARS) return combined;
  return combined.slice(0, MAX_INPUT_CHARS);
}

/** Cosine similarity between two equal-length vectors. Returns 0 on
 *  empty / mismatched-length input rather than throwing — this helper
 *  is for offline / test usage; the production path trusts the
 *  Vectorize-returned `score` field directly. */
export function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

interface BgeRunResult {
  data?: number[][];
  shape?: number[];
}

/** Embed one batch of texts. Calls Workers AI directly — no LLM-JSON
 *  retry / fallback ladder applies because bge-base does not produce
 *  JSON; on failure the caller marks affected articles `embedding_status
 *  = 'failed'` and surfaces the error.
 *
 *  Throws when the batch exceeds {@link MAX_BATCH_SIZE} so callers chunk
 *  upstream rather than silently dropping vectors. */
export async function embedTexts(
  ai: Pick<Ai, 'run'>,
  inputs: ReadonlyArray<string>,
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  if (inputs.length > MAX_BATCH_SIZE) {
    throw new Error(
      `embedTexts: batch size ${inputs.length} exceeds cap ${MAX_BATCH_SIZE}`,
    );
  }
  const result = (await ai.run(EMBEDDING_MODEL_ID, {
    text: inputs as string[],
  })) as BgeRunResult;
  const data = result.data;
  if (!Array.isArray(data) || data.length !== inputs.length) {
    throw new Error(
      `embedTexts: expected ${inputs.length} vectors, got ${
        Array.isArray(data) ? data.length : 'non-array'
      }`,
    );
  }
  for (const vec of data) {
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('embedTexts: empty vector in response');
    }
  }
  return data;
}

/** Delete vectors by id, paging through {@link VECTORIZE_DELETE_BATCH_SIZE}
 *  ids per platform call. `Vectorize.deleteByIds` rejects oversized
 *  payloads, so callers that may accumulate >100 ids (the finalize
 *  consumer with FINALIZE_CANDIDATE_CAP=250, the historical-dedup
 *  route with batch up to 500 × topK) must page rather than issue a
 *  single call.
 *
 *  Each page failure is reported via `onPageError` so the caller can
 *  decide whether to surface the error or treat the delete as best-
 *  effort cleanup. The function never throws on its own — a thrown
 *  page propagates to the caller via `onPageError` only. */
export async function deleteVectorsBatched(
  vectorize: Pick<Vectorize, 'deleteByIds'>,
  ids: ReadonlyArray<string>,
  onPageError?: (err: unknown, slice: string[]) => void,
): Promise<void> {
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += VECTORIZE_DELETE_BATCH_SIZE) {
    const slice = ids.slice(i, i + VECTORIZE_DELETE_BATCH_SIZE);
    try {
      await vectorize.deleteByIds(slice);
    } catch (err) {
      if (onPageError !== undefined) onPageError(err, slice);
      else throw err;
    }
  }
}
