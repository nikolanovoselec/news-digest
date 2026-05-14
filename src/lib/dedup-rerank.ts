// Implements REQ-PIPE-009
//
// LLM re-rank pass for borderline cosine pairs. Sits between the
// auto-merge band (cosine >= DEDUP_COSINE_THRESHOLD, default 0.78) and
// the distinct band (cosine < DEDUP_RERANK_FLOOR, default 0.70). Pairs
// in [floor, threshold) are sent to the LLM for a binary same-event
// judgment so embedding-only blind spots do not leak through as
// duplicates.
//
// Why this layer exists. bge-base-en-v1.5 sometimes scores
// genuinely-same-event pairs in the borderline band when the two
// summaries take different angles on the same news (e.g. "Romania PM
// ousted in no-confidence vote" vs "Romania government collapses as
// far-right coalition forms" - cosine 0.75). Lowering the threshold
// arbitrarily to catch these would reintroduce the false-merges the
// threshold was tuned to prevent (distinct same-publisher
// announcements also live in the 0.77-0.84 range). The LLM judges
// only the borderline band so the fast-path bands stay clean. The
// 2026-05-07 prod audit (AD36) shifted the band downward from
// [0.72, 0.85) to [0.70, 0.78) after same-news-cycle clusters were
// observed at 0.73-0.80.
//
// Batched call shape (AD48, 2026-05-14). Pre-AD48 this module exposed
// `rerankBorderlinePair(a, b)` — one LLM round-trip per pair. Across a
// 7d sweep that meant ~600-1200 LLM calls/day at a billed per-call
// system-prompt cost of ~300 tokens each. The batched API collects
// up to RERANK_BATCH_SIZE pairs and sends one prompt with a JSON
// array, amortising the system prompt and one round-trip per N pairs.
// The cap is deliberately small (15) so JSON-parse failures lose at
// most 15 verdicts (default to `false` per pair) and so per-pair
// classification accuracy on a smaller model does not degrade from
// attention dilution.

import { runJson, asAiBinding } from '~/lib/llm-json';
import { log } from '~/lib/log';

/** Default lower bound of the borderline band. Cosines strictly below
 *  this value skip the LLM and stay distinct. Lowered from 0.72 to
 *  0.70 on 2026-05-07 alongside the threshold drop (0.85 → 0.78) so
 *  same-news-cycle pairs in the lower tail (PANW valuation week at
 *  0.7286-0.7293) reach the LLM rather than being filtered out
 *  pre-rerank. */
export const DEFAULT_RERANK_FLOOR = 0.70;

/** Hard cap on snippet bytes sent per article. Keeps the per-pair
 *  payload bounded so a batched prompt of N pairs stays well under
 *  the 128K context regardless of upstream body length. */
const SNIPPET_CHAR_CAP = 600;

/** Hard cap on pairs sent in a single batched LLM call. 15 keeps the
 *  prompt small enough for the model to attend to every pair without
 *  dilution, limits the blast radius on JSON parse failure to 15
 *  verdicts, and stays well below output-token limits (15 verdicts ≈
 *  ~300 tokens of structured JSON). Callers with >15 pairs receive
 *  multiple LLM calls internally; the returned verdict array is still
 *  1:1 with the input. */
export const RERANK_BATCH_SIZE = 15;

/** Read the runtime rerank floor from env, with a safe fallback. Same
 *  shape as readCosineThreshold: string-typed in wrangler.toml, parsed
 *  to float, clamped to [0, 1]. An invalid value falls back to the
 *  default rather than silently disabling the rerank band. */
export function readRerankFloor(env: Pick<Env, 'DEDUP_RERANK_FLOOR'>): number {
  const raw = env.DEDUP_RERANK_FLOOR;
  if (typeof raw !== 'string' || raw === '') return DEFAULT_RERANK_FLOOR;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return DEFAULT_RERANK_FLOOR;
  }
  return parsed;
}

/** Article shape passed to the rerank pair check. Title is required;
 *  snippet is preferred but optional - the LLM still gets a usable
 *  signal from headlines alone for clear cases. */
export interface RerankArticle {
  id: string;
  title: string;
  snippet: string | null;
}

/** One borderline pair queued for a same-event verdict. The `i` field
 *  is opaque to this module — the caller assigns it (typically the
 *  pair's position in the caller's working array) and receives it back
 *  on the verdict so it can map results to its own data. */
export interface RerankPair {
  a: RerankArticle;
  b: RerankArticle;
}

interface BatchVerdictEntry {
  i?: unknown;
  same_event?: unknown;
}

interface BatchPayload {
  verdicts?: unknown;
}

function narrowBatchPayload(raw: unknown): BatchPayload | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    if (raw === '') return null;
    try {
      return JSON.parse(raw) as BatchPayload;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw as BatchPayload;
  return null;
}

const RERANK_SYSTEM = [
  'You are a news deduplication assistant.',
  'You will receive an array of pairs. For EACH pair, decide whether the two article snippets are part of the SAME news cycle for the SAME subject.',
  'Answer ONLY with strict JSON: {"verdicts": [{"i": <index>, "same_event": true|false}, ...]} — one verdict object per input pair, with `i` matching the pair\'s input index.',
  'Same news cycle = either (a) reporting on the same underlying real-world occurrence (e.g. the same vote, the same product launch, the same CVE advisory, the same acquisition), OR (b) closely-coupled follow-on coverage of one subject within the same news cycle (e.g. multiple analyst takes on the same company\'s outlook published the same week, multiple security outlets covering the same vulnerability, multiple write-ups of the same earnings call).',
  'Concrete same-event examples — answer true on these shapes:',
  '- "Acme Q1 Earnings Beat Forecast" + "Acme Cuts 1,000 Jobs After Q1 Results" — same earnings call, different angles.',
  '- "Critical CVE-2026-1234 Disclosed in OpenSSL" + "OpenSSL Patches Authentication Bypass" — same vulnerability advisory.',
  '- "Union Demands Accountability After Boeing Worker Death" + "IAM Calls for Investigation Following Plant Fatality" — same workplace incident, different sources.',
  '- "Cloudflare Announces 20% Layoffs" + "Cloudflare Shares Slide on Workforce Cut" — same announcement triggering market reaction.',
  'Different = different occurrences with no shared underlying news driver (e.g. an acquisition versus a product launch by the same company, a CVE advisory versus a marketing announcement, a Q1 earnings call versus a Q2 earnings call).',
  'When unsure for a given pair, prefer false. False is the conservative answer.',
  'Judge each pair INDEPENDENTLY — do not assume transitivity across pairs.',
].join(' ');

function buildBatchUser(pairs: ReadonlyArray<RerankPair>): string {
  const items = pairs.map((p, i) => {
    const aSnip = (p.a.snippet ?? '').slice(0, SNIPPET_CHAR_CAP);
    const bSnip = (p.b.snippet ?? '').slice(0, SNIPPET_CHAR_CAP);
    return {
      i,
      title_a: p.a.title,
      snippet_a: aSnip,
      title_b: p.b.title,
      snippet_b: bSnip,
    };
  });
  return [
    'Pairs to judge:',
    JSON.stringify(items),
    '',
    'Return strict JSON: {"verdicts": [{"i": <index>, "same_event": true|false}, ...]}.',
  ].join('\n');
}

/** Run one batched LLM call for up to {@link RERANK_BATCH_SIZE} pairs.
 *  Returns a boolean array aligned 1:1 with the input. Parse failure,
 *  network error, or any malformed shape → all `false` (matches the
 *  pre-AD48 single-pair conservative fallback). Never throws. */
async function runOneBatch(
  env: Pick<Env, 'AI'>,
  pairs: ReadonlyArray<RerankPair>,
): Promise<boolean[]> {
  if (pairs.length === 0) return [];

  const llmRun = await runJson<BatchPayload>({
    ai: asAiBinding(env.AI),
    params: {
      messages: [
        { role: 'system', content: RERANK_SYSTEM },
        { role: 'user', content: buildBatchUser(pairs) },
      ],
      temperature: 0,
    },
    narrow: (raw) => narrowBatchPayload(raw),
  }).catch((err: unknown) => {
    log('warn', 'digest.generation', {
      status: 'dedup_rerank_batch_failed',
      pair_count: pairs.length,
      first_pair_a: pairs[0]?.a.id ?? null,
      first_pair_b: pairs[0]?.b.id ?? null,
      detail: String(err).slice(0, 500),
    });
    return null;
  });

  if (llmRun === null || !llmRun.ok) {
    log('warn', 'digest.generation', {
      status: 'dedup_rerank_batch_unparseable',
      pair_count: pairs.length,
    });
    return pairs.map(() => false);
  }

  const verdictsRaw = llmRun.parsed.verdicts;
  if (!Array.isArray(verdictsRaw)) {
    log('warn', 'digest.generation', {
      status: 'dedup_rerank_batch_no_verdicts',
      pair_count: pairs.length,
    });
    return pairs.map(() => false);
  }

  // Build an index -> bool map then materialise the aligned array.
  // Missing indices default to `false` (model dropped a pair). Out-of-
  // range or non-numeric `i` entries are ignored.
  const verdictMap = new Map<number, boolean>();
  for (const v of verdictsRaw as BatchVerdictEntry[]) {
    if (v === null || typeof v !== 'object') continue;
    const idx = v.i;
    if (typeof idx !== 'number' || !Number.isInteger(idx)) continue;
    if (idx < 0 || idx >= pairs.length) continue;
    verdictMap.set(idx, v.same_event === true);
  }

  log('info', 'digest.generation', {
    status: 'dedup_rerank_batch_called',
    pair_count: pairs.length,
    verdicts_returned: verdictMap.size,
    same_event_count: Array.from(verdictMap.values()).filter((b) => b).length,
  });

  return pairs.map((_, i) => verdictMap.get(i) ?? false);
}

/** Ask the LLM, in batched form, whether each borderline pair describes
 *  the same news event. Returns a boolean array aligned 1:1 with the
 *  input array. Internally chunks the request into batches of
 *  {@link RERANK_BATCH_SIZE}. Conservative on any failure: a batch that
 *  fails to return parseable JSON contributes `false` for every pair
 *  in that batch, so the caller never accidentally merges on a model
 *  outage. Never throws. */
export async function rerankBorderlinePairsBatch(
  env: Pick<Env, 'AI'>,
  pairs: ReadonlyArray<RerankPair>,
): Promise<boolean[]> {
  if (pairs.length === 0) return [];

  const out: boolean[] = [];
  for (let start = 0; start < pairs.length; start += RERANK_BATCH_SIZE) {
    const slice = pairs.slice(start, start + RERANK_BATCH_SIZE);
    const verdicts = await runOneBatch(env, slice);
    for (const v of verdicts) out.push(v);
  }
  return out;
}
