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
// Cost. Per scrape tick: ~20-30 new articles, expected 2-5 borderline
// pairs => 2-5 LLM calls. Per historical-dedup operator invocation:
// bounded by the actual count of borderline pairs in the corpus.

import { runJson, asAiBinding } from '~/lib/llm-json';
import { log } from '~/lib/log';

/** Default lower bound of the borderline band. Cosines strictly below
 *  this value skip the LLM and stay distinct. Lowered from 0.72 to
 *  0.70 on 2026-05-07 alongside the threshold drop (0.85 → 0.78) so
 *  same-news-cycle pairs in the lower tail (PANW valuation week at
 *  0.7286-0.7293) reach the LLM rather than being filtered out
 *  pre-rerank. */
export const DEFAULT_RERANK_FLOOR = 0.70;

/** Hard cap on snippet bytes sent per article. Keeps the prompt under
 *  ~1k tokens regardless of upstream body length so the LLM call stays
 *  fast and cheap. */
const SNIPPET_CHAR_CAP = 600;

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

interface RerankPayload {
  same_event?: unknown;
}

function narrowRerankPayload(raw: unknown): RerankPayload | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    if (raw === '') return null;
    try {
      return JSON.parse(raw) as RerankPayload;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw as RerankPayload;
  return null;
}

const RERANK_SYSTEM = [
  'You are a news deduplication assistant.',
  'Decide whether two article snippets are part of the SAME news cycle for the SAME subject.',
  'Answer ONLY with strict JSON: {"same_event": true} or {"same_event": false}.',
  'Same news cycle = either (a) reporting on the same underlying real-world occurrence (e.g. the same vote, the same product launch, the same CVE advisory, the same acquisition), OR (b) closely-coupled follow-on coverage of one subject within the same news cycle (e.g. multiple analyst takes on the same company\'s outlook published the same week, multiple security outlets covering the same vulnerability, multiple write-ups of the same earnings call).',
  'Concrete same-event examples — answer true on these shapes:',
  '- "Acme Q1 Earnings Beat Forecast" + "Acme Cuts 1,000 Jobs After Q1 Results" — same earnings call, different angles.',
  '- "Critical CVE-2026-1234 Disclosed in OpenSSL" + "OpenSSL Patches Authentication Bypass" — same vulnerability advisory.',
  '- "Union Demands Accountability After Boeing Worker Death" + "IAM Calls for Investigation Following Plant Fatality" — same workplace incident, different sources.',
  '- "Cloudflare Announces 20% Layoffs" + "Cloudflare Shares Slide on Workforce Cut" — same announcement triggering market reaction.',
  'Different = different occurrences with no shared underlying news driver (e.g. an acquisition versus a product launch by the same company, a CVE advisory versus a marketing announcement, a Q1 earnings call versus a Q2 earnings call).',
  'When unsure, prefer false. False is the conservative answer.',
].join(' ');

function buildRerankUser(a: RerankArticle, b: RerankArticle): string {
  const aSnip = (a.snippet ?? '').slice(0, SNIPPET_CHAR_CAP);
  const bSnip = (b.snippet ?? '').slice(0, SNIPPET_CHAR_CAP);
  return [
    'Article A:',
    `Title: ${a.title}`,
    `Snippet: ${aSnip}`,
    '',
    'Article B:',
    `Title: ${b.title}`,
    `Snippet: ${bSnip}`,
    '',
    'Are A and B reporting on the same news event? Reply with strict JSON only.',
  ].join('\n');
}

/** Ask the LLM whether two borderline-cosine articles describe the
 *  same news event. Returns true only when the model emits a strict
 *  `{"same_event": true}` JSON object. Any other outcome - parse
 *  failure, network error, ambiguous shape, explicit `false` - returns
 *  false so the conservative path (keep both articles separate) wins.
 *  Never throws; the caller can call this in a tight loop without
 *  defensive try/catch. */
export async function rerankBorderlinePair(
  env: Pick<Env, 'AI'>,
  a: RerankArticle,
  b: RerankArticle,
): Promise<boolean> {
  const llmRun = await runJson<RerankPayload>({
    ai: asAiBinding(env.AI),
    params: {
      messages: [
        { role: 'system', content: RERANK_SYSTEM },
        { role: 'user', content: buildRerankUser(a, b) },
      ],
      temperature: 0,
    },
    narrow: (raw) => narrowRerankPayload(raw),
  }).catch((err: unknown) => {
    log('warn', 'digest.generation', {
      status: 'dedup_rerank_failed',
      article_a: a.id,
      article_b: b.id,
      detail: String(err).slice(0, 500),
    });
    return null;
  });

  if (llmRun === null || !llmRun.ok) {
    log('warn', 'digest.generation', {
      status: 'dedup_rerank_unparseable',
      article_a: a.id,
      article_b: b.id,
    });
    return false;
  }
  const same = llmRun.parsed.same_event;
  return same === true;
}
