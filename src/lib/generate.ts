// Implements REQ-GEN-001, REQ-GEN-002, REQ-GEN-003, REQ-GEN-004, REQ-GEN-005,
// REQ-GEN-006, REQ-GEN-008
//
// The single digest-generation pipeline, invoked from two places:
//
//   1. The queue consumer (Phase 5C) drains `digest-jobs` messages produced by
//      either the cron dispatcher (`trigger: 'scheduled'`) or the manual
//      refresh API handler (`trigger: 'manual'`).
//   2. Both paths arrive at this single entry point, `generateDigest`, so the
//      behaviour for scheduled and manual triggers is identical apart from
//      row-claiming (INSERT vs UPDATE) and post-success email delivery
//      (scheduled only).
//
// Pipeline (happy path):
//   - Claim / create the digests row.
//   - Load the user's tags and their discovered feed adapters from KV.
//   - Fan out across generic + discovered sources → up to 100 Headlines.
//   - Call Workers AI once with DIGEST_SYSTEM + digestUserPrompt. Parse strict
//     JSON. Sanitize every plaintext field. Generate ULIDs + slugs.
//   - One db.batch([...]): article INSERTs, digest UPDATE (status → 'ready'),
//     user UPDATE (last_generated_local_date). Atomic.
//   - Best-effort email for scheduled + email_enabled users.
//
// Failure modes write `status='failed'` with a sanitized error_code:
//   - `all_sources_failed` — every source returned zero headlines
//   - `llm_invalid_json` — LLM response did not parse as strict JSON
//   - `llm_failed` — LLM call threw (network/backend error)
//   - plus any other caught exception → `llm_failed` with the raw error logged
//
// Everything is wrapped in a try/catch so no uncaught exception escapes to
// the consumer. The digest row is always marked either `ready` or `failed`
// before this function returns.

import { adaptersForDiscoveredFeeds, fanOutForTags } from '~/lib/sources';
import type { SourceAdapter } from '~/lib/sources';
import { canonicalize } from '~/lib/canonical-url';
import { DIGEST_SYSTEM, LLM_PARAMS, digestUserPrompt } from '~/lib/prompts';
import { generateUlid } from '~/lib/ulid';
import { deduplicateSlug, slugify } from '~/lib/slug';
import { localDateInTz } from '~/lib/tz';
import { DEFAULT_MODEL_ID, estimateCost, modelById } from '~/lib/models';
import { applyForeignKeysPragma, batch } from '~/lib/db';
import { sendDigestEmail } from '~/lib/email';
import type { DigestEmailContext } from '~/lib/email';
import { log } from '~/lib/log';
import type { ErrorCode } from '~/lib/errors';
import type {
  AuthenticatedUser,
  DiscoveredFeed,
  GeneratedArticle,
  Headline,
  SourcesCacheValue,
} from '~/lib/types';

/** Result returned by {@link generateDigest}. `status` is always terminal:
 * a `'ready'` digest has its articles written and user dedupe-key updated,
 * a `'failed'` digest has its `error_code` set. Callers (the queue consumer)
 * use this to decide whether to ack or retry the message. */
export interface GenerateDigestResult {
  digestId: string;
  status: 'ready' | 'failed';
  error_code?: ErrorCode;
}

/** Shape Workers AI `.run()` returns. Different models surface token counts
 * under slightly different keys — the reader at the usage site tolerates all
 * the common variants (`usage.input_tokens`, `usage.prompt_tokens`,
 * top-level `tokens_in`). */
interface AIRunResponse {
  response?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  tokens_in?: number;
  tokens_out?: number;
  [key: string]: unknown;
}

/** Shape the LLM is instructed to return. Validated at parse time — any
 * deviation falls through to the `llm_invalid_json` error code. */
interface LLMDigestPayload {
  articles?: Array<{
    title?: unknown;
    url?: unknown;
    one_liner?: unknown;
    details?: unknown;
    tags?: unknown;
  }>;
}

/** The closed set of error codes this function writes to `digests.error_code`.
 * Any other caught exception maps to `llm_failed` (conservative default). */
type DigestErrorCode =
  | 'llm_invalid_json'
  | 'llm_failed'
  | 'all_sources_failed';

/**
 * Run the full digest-generation pipeline for a single user.
 *
 * The function is the single entry point reached from both the cron-
 * dispatched scheduled path and the manual refresh path. It claims (or
 * creates) a `digests` row, assembles candidate headlines, calls the LLM,
 * and commits articles + status + user dedupe key in one atomic batch.
 *
 * Never throws. On any failure, a `status='failed'` row is persisted with a
 * sanitized `error_code` and the corresponding {@link GenerateDigestResult}
 * is returned.
 *
 * @param env      Worker bindings (DB, KV, AI, RESEND_*, APP_URL)
 * @param user     Authenticated user row (hashtags, tz, model_id, email_enabled)
 * @param trigger  `'scheduled'` (cron) or `'manual'` (refresh API)
 * @param digestId Required for `trigger='manual'` — the id returned by the
 *                 refresh endpoint's conditional INSERT. Ignored for
 *                 `trigger='scheduled'` (a fresh id is generated).
 */
export async function generateDigest(
  env: Env,
  user: AuthenticatedUser,
  trigger: 'scheduled' | 'manual',
  digestId?: string,
): Promise<GenerateDigestResult> {
  await applyForeignKeysPragma(env.DB);

  const startedAtMs = Date.now();
  const localDate = localDateInTz(Math.floor(startedAtMs / 1000), user.tz);
  // Fall back to DEFAULT_MODEL_ID when the user's stored model_id is
  // null OR no longer in the MODELS catalog. The latter protects users
  // whose preference pointed at a model we've since retired (e.g.,
  // llama-3.3-70b-instruct-fp8-fast, which was removed after its 24K
  // async-queue limitation surfaced in production).
  const storedModelValid =
    user.model_id !== null &&
    user.model_id !== '' &&
    modelById(user.model_id) !== undefined;
  const modelId = storedModelValid ? user.model_id! : DEFAULT_MODEL_ID;

  // --- Step 1: Claim / create the digest row --------------------------------
  //
  // Scheduled: INSERT with a local_date dedupe guard (same user + same
  // local_date would violate no-double-digest-per-day). We use a conditional
  // INSERT selecting on NOT EXISTS so two cron invocations at the same minute
  // don't create duplicate rows.
  //
  // Manual: the refresh API has already inserted the `status='in_progress'`
  // row and passed us its id. We UPDATE `generated_at` + `model_id` to reflect
  // the start of processing (in case the queue was backed up) and fall
  // through — the row is already ours.
  let resolvedDigestId: string;
  try {
    if (trigger === 'scheduled') {
      const newId = generateUlid();
      // Conditional INSERT: only proceed if no row exists for this user +
      // local_date. The dedupe check is belt-and-braces — the cron
      // dispatcher already filters on last_generated_local_date, but a
      // crash between enqueue and consume could reissue a message.
      const insert = await env.DB.prepare(
        `INSERT INTO digests (id, user_id, local_date, generated_at, model_id, status, trigger)
         SELECT ?1, ?2, ?3, ?4, ?5, 'in_progress', 'scheduled'
         WHERE NOT EXISTS (
           SELECT 1 FROM digests WHERE user_id = ?2 AND local_date = ?3
         )`,
      )
        .bind(newId, user.id, localDate, Math.floor(startedAtMs / 1000), modelId)
        .run();
      const changes =
        (insert.meta as { changes?: number } | undefined)?.changes ?? 0;
      if (changes === 0) {
        // A row already exists for today; nothing to do. Surface the existing
        // row's id so the consumer can log a no-op ack.
        const existing = await env.DB.prepare(
          'SELECT id, status FROM digests WHERE user_id = ?1 AND local_date = ?2',
        )
          .bind(user.id, localDate)
          .first<{ id: string; status: string }>();
        const id = existing?.id ?? newId;
        log('info', 'digest.generation', {
          user_id: user.id,
          digest_id: id,
          trigger,
          status: 'already_exists',
        });
        return { digestId: id, status: 'ready' };
      }
      resolvedDigestId = newId;
    } else {
      // Manual — digestId MUST be supplied by the refresh endpoint.
      if (digestId === undefined || digestId === '') {
        throw new Error('manual trigger requires a digest_id');
      }
      await env.DB.prepare(
        `UPDATE digests
         SET generated_at = ?1, model_id = ?2
         WHERE id = ?3 AND status = 'in_progress'`,
      )
        .bind(Math.floor(startedAtMs / 1000), modelId, digestId)
        .run();
      resolvedDigestId = digestId;
    }
  } catch (err) {
    // Row-claim failed before we even started — nothing to mark as failed
    // because we have no id. Surface a no-op failure.
    log('error', 'digest.generation', {
      user_id: user.id,
      trigger,
      status: 'claim_failed',
      detail: errorDetail(err),
    });
    return {
      digestId: digestId ?? '',
      status: 'failed',
      error_code: 'llm_failed',
    };
  }

  // Everything below this point must be wrapped so we can mark the claimed
  // row as `failed` on any uncaught error.
  try {
    // --- Step 2: Parse user's hashtags ------------------------------------
    const tags = parseHashtags(user.hashtags_json);

    // --- Step 3: Load discovered-source feeds from KV --------------------
    const discoveredByTag = await loadDiscoveredFeeds(env.KV, tags);

    // --- Step 4: Fan out across every {tag × source} pair ---------------
    const headlines = await fanOutForTags(tags, env.KV, discoveredByTag);

    // Build a canonical-URL → source_name lookup so we can persist the
    // originating source on each article row. The LLM returns only the
    // raw URL string, so we dedupe headline URLs the same way
    // `fanOutForTags` does (see REQ-GEN-004) and look up by canonical
    // form. First occurrence wins — matches the fan-out's dedupe order
    // (tag-specific feeds land ahead of generic sources).
    const sourceNameByCanonicalUrl = buildSourceNameMap(headlines);
    // A parallel lookup from canonical URL to the fan-out's source_tags,
    // used as a last-resort fallback when `sanitizeArticles` finds the
    // LLM omitted the `tags` field entirely.
    const sourceTagsByCanonicalUrl = buildSourceTagsMap(headlines);

    // --- Step 5: All-sources-failed guard -------------------------------
    if (headlines.length === 0) {
      await markFailed(
        env.DB,
        resolvedDigestId,
        'all_sources_failed',
        startedAtMs,
      );
      log('warn', 'digest.generation', {
        user_id: user.id,
        digest_id: resolvedDigestId,
        trigger,
        status: 'all_sources_failed',
      });
      return {
        digestId: resolvedDigestId,
        status: 'failed',
        error_code: 'all_sources_failed',
      };
    }

    // --- Step 6: Workers AI call ----------------------------------------
    let aiResult: AIRunResponse;
    try {
      const ai = env.AI as unknown as {
        run: (model: string, params: Record<string, unknown>) => Promise<AIRunResponse>;
      };
      aiResult = await ai.run(modelId, {
        messages: [
          { role: 'system', content: DIGEST_SYSTEM },
          { role: 'user', content: digestUserPrompt(tags, headlines) },
        ],
        ...LLM_PARAMS,
      });
    } catch (err) {
      await markFailed(env.DB, resolvedDigestId, 'llm_failed', startedAtMs);
      log('error', 'digest.generation', {
        user_id: user.id,
        digest_id: resolvedDigestId,
        trigger,
        status: 'llm_failed',
        detail: errorDetail(err),
      });
      return {
        digestId: resolvedDigestId,
        status: 'failed',
        error_code: 'llm_failed',
      };
    }

    // Different Workers AI model families return the generated text under
    // different keys. Traditional Meta/Mistral/etc. models expose a flat
    // `response` (string or already-parsed object). OpenAI-style models
    // (`@cf/openai/gpt-oss-*`) return the full chat-completion envelope
    // with the text under `choices[0].message.content`. Resolve both
    // here so parseLLMPayload sees a plain string/object either way.
    const rawResponse = extractResponsePayload(aiResult);
    const parsed = parseLLMPayload(rawResponse);
    if (parsed === null) {
      await markFailed(
        env.DB,
        resolvedDigestId,
        'llm_invalid_json',
        startedAtMs,
      );
      // Log a short fingerprint of the raw response so we can diagnose
      // why the parser rejected it. Truncate to keep structured-log
      // payload small and avoid dumping user data into stdout.
      // Capture a fingerprint of whatever the LLM returned — might be a
      // string (most models) or an object (if response_format returned
      // already-parsed). Both shapes land here when parseLLMPayload
      // can't find an `articles` array.
      const rawType = typeof rawResponse;
      const rawString =
        rawType === 'string'
          ? (rawResponse as string)
          : JSON.stringify(rawResponse ?? null);
      const sample = rawString.slice(0, 300);
      const tail = rawString.length > 600 ? rawString.slice(-300) : '';
      log('warn', 'digest.generation', {
        user_id: user.id,
        digest_id: resolvedDigestId,
        trigger,
        status: 'llm_invalid_json',
        raw_type: rawType,
        raw_length: rawString.length,
        raw_sample: sample,
        raw_tail: tail,
      });
      return {
        digestId: resolvedDigestId,
        status: 'failed',
        error_code: 'llm_invalid_json',
      };
    }

    // --- Step 7: Sanitize article plaintext ------------------------------
    const articles = sanitizeArticles(
      parsed,
      sourceNameByCanonicalUrl,
      sourceTagsByCanonicalUrl,
      tags,
    );
    if (articles.length === 0) {
      // Parsed OK but produced zero usable articles — treat as invalid JSON
      // (the contract says ≥1 article with the documented shape).
      await markFailed(
        env.DB,
        resolvedDigestId,
        'llm_invalid_json',
        startedAtMs,
      );
      log('warn', 'digest.generation', {
        user_id: user.id,
        digest_id: resolvedDigestId,
        trigger,
        status: 'llm_invalid_json',
        detail: 'no usable articles after sanitize',
      });
      return {
        digestId: resolvedDigestId,
        status: 'failed',
        error_code: 'llm_invalid_json',
      };
    }

    // --- Step 8: Atomic final write -------------------------------------
    const executionMs = Date.now() - startedAtMs;
    const tokensIn = extractTokensIn(aiResult);
    const tokensOut = extractTokensOut(aiResult);
    const costUsd = estimateCost(modelId, tokensIn, tokensOut);

    const statements = buildFinalBatch({
      db: env.DB,
      digestId: resolvedDigestId,
      userId: user.id,
      tz: user.tz,
      articles,
      executionMs,
      tokensIn,
      tokensOut,
      costUsd,
      nowSeconds: Math.floor(Date.now() / 1000),
    });

    try {
      await batch(env.DB, statements);
    } catch (err) {
      // Atomic batch failed — roll the row forward to failed so clients
      // stop polling. D1 already rolled back the attempted writes.
      await markFailed(env.DB, resolvedDigestId, 'llm_failed', startedAtMs);
      log('error', 'digest.generation', {
        user_id: user.id,
        digest_id: resolvedDigestId,
        trigger,
        status: 'batch_failed',
        detail: errorDetail(err),
      });
      return {
        digestId: resolvedDigestId,
        status: 'failed',
        error_code: 'llm_failed',
      };
    }

    log('info', 'digest.generation', {
      user_id: user.id,
      digest_id: resolvedDigestId,
      trigger,
      status: 'ready',
      article_count: articles.length,
      execution_ms: executionMs,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      estimated_cost_usd: costUsd,
      model_id: modelId,
    });

    // --- Step 9: Best-effort email --------------------------------------
    //
    // Scheduled + email_enabled only. Manual refreshes never email — the
    // user is already looking at the page. Email failures are logged by
    // `sendDigestEmail` but never rejected to the caller.
    if (trigger === 'scheduled' && user.email_enabled === 1) {
      try {
        const modelOption = modelById(modelId);
        const modelName = modelOption?.name ?? modelId;
        const emailCtx: DigestEmailContext = {
          user: { email: user.email, gh_login: user.gh_login },
          digest_id: resolvedDigestId,
          local_date: localDate,
          article_count: articles.length,
          top_tags: tags.slice(0, 3),
          execution_ms: executionMs,
          tokens: tokensIn + tokensOut,
          estimated_cost_usd: costUsd,
          model_name: modelName,
          app_url: env.APP_URL,
        };
        await sendDigestEmail(env, emailCtx);
      } catch (err) {
        // sendDigestEmail is documented as non-throwing, but guard
        // anyway — email is best-effort.
        log('error', 'email.send.failed', {
          user_id: user.gh_login,
          digest_id: resolvedDigestId,
          status: null,
          error: errorDetail(err),
        });
      }
    }

    return { digestId: resolvedDigestId, status: 'ready' };
  } catch (err) {
    // Step 10: catch-all. Mark the row failed with the conservative
    // `llm_failed` code and log the full detail for post-hoc debugging.
    await markFailed(env.DB, resolvedDigestId, 'llm_failed', startedAtMs).catch(
      () => {
        // Swallow — if even the failure UPDATE failed, the stuck-digest
        // sweeper (REQ-GEN-007) will pick up the in_progress row at the
        // next cron tick.
      },
    );
    log('error', 'digest.generation', {
      user_id: user.id,
      digest_id: resolvedDigestId,
      trigger,
      status: 'exception',
      detail: errorDetail(err),
    });
    return {
      digestId: resolvedDigestId,
      status: 'failed',
      error_code: 'llm_failed',
    };
  }
}

// ---------- Helpers -------------------------------------------------------

/** Parse `hashtags_json` ("[\"#ai\", \"#cloudflare\"]") into a bare tag list
 * ("ai", "cloudflare"). Never throws. Empty/malformed input → empty array. */
function parseHashtags(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue;
    // Strip the leading '#' if present; stored tags are usually in the
    // "#tag" form, but the fan-out and adapters use the bare form.
    const bare = entry.startsWith('#') ? entry.slice(1) : entry;
    const trimmed = bare.trim().toLowerCase();
    if (trimmed === '') continue;
    out.push(trimmed);
  }
  return out;
}

/** Load `sources:{tag}` KV entries for every tag and adapt them into
 * SourceAdapter arrays for `fanOutForTags`. Missing entries are simply
 * absent from the returned Map; the fan-out treats that as "no discovered
 * feeds for this tag, use generic sources only". */
async function loadDiscoveredFeeds(
  kv: KVNamespace,
  tags: string[],
): Promise<Map<string, SourceAdapter[]>> {
  const map = new Map<string, SourceAdapter[]>();
  for (const tag of tags) {
    let raw: string | null;
    try {
      raw = await kv.get(`sources:${tag}`, 'text');
    } catch {
      continue;
    }
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const feeds = extractFeeds(parsed);
    if (feeds.length === 0) continue;
    map.set(tag, adaptersForDiscoveredFeeds(feeds));
  }
  return map;
}

/** Narrow a KV-parsed value to a `DiscoveredFeed[]`. Tolerates partial
 * shapes — a stored entry missing `discovered_at` is still usable. */
function extractFeeds(parsed: unknown): DiscoveredFeed[] {
  if (parsed === null || typeof parsed !== 'object') return [];
  const feeds = (parsed as Partial<SourcesCacheValue>).feeds;
  if (!Array.isArray(feeds)) return [];
  const out: DiscoveredFeed[] = [];
  for (const f of feeds) {
    if (f === null || typeof f !== 'object') continue;
    const name = (f as { name?: unknown }).name;
    const url = (f as { url?: unknown }).url;
    const kind = (f as { kind?: unknown }).kind;
    if (typeof name !== 'string' || name === '') continue;
    if (typeof url !== 'string' || url === '') continue;
    if (kind !== 'rss' && kind !== 'atom' && kind !== 'json') continue;
    out.push({ name, url, kind });
  }
  return out;
}

/**
 * Pull the model-produced text out of an `AIRunResponse`. Resolves two
 * shapes across Workers AI's model families:
 *
 *   1. Flat: `{ response: "<JSON string>" | <object> }` — Llama, Mistral,
 *      Kimi, and most other text-generation models.
 *   2. OpenAI envelope: `{ choices: [{ message: { content: "..." } }] }`
 *      — every `@cf/openai/*` endpoint, which proxies OpenAI's
 *      chat-completions API shape directly.
 *
 * Any other shape returns `undefined`, which `parseLLMPayload` then
 * treats as `llm_invalid_json`.
 */
function extractResponsePayload(aiResult: AIRunResponse): unknown {
  // `typeof null === 'object'`, so guard against a null `response`
  // explicitly — we want to fall through to the OpenAI envelope branch
  // rather than accept a null payload as valid.
  if (typeof aiResult.response === 'string') return aiResult.response;
  if (typeof aiResult.response === 'object' && aiResult.response !== null) {
    return aiResult.response;
  }
  const choices = (aiResult as Record<string, unknown>)['choices'];
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown> | null | undefined;
    if (first !== null && first !== undefined && typeof first === 'object') {
      const message = first['message'] as Record<string, unknown> | null | undefined;
      if (message !== null && message !== undefined && typeof message === 'object') {
        const content = message['content'];
        if (typeof content === 'string') return content;
        // Reject `null` content (tool-call-only responses) so the
        // caller correctly classifies them as llm_invalid_json instead
        // of silently passing null through the parser.
        if (typeof content === 'object' && content !== null) return content;
      }
    }
  }
  return undefined;
}

/** Parse the LLM response body as `{ articles: [...] }`. Returns the parsed
 * payload on success or null on any JSON error.
 *
 * Tolerant of common LLM deviations even when `response_format: json_object`
 * is requested: leading/trailing whitespace, ```json fences, a prose
 * preamble like "Here is the JSON:", or a trailing comment block. Falls
 * back to extracting the first brace-balanced object in the string when
 * a direct parse fails. */
function parseLLMPayload(response: unknown): LLMDigestPayload | null {
  // Some Workers AI models honour `response_format: json_object` by
  // returning an already-parsed object on `response` instead of a JSON
  // string. Accept that shape directly — the shape check below is the
  // same either way.
  if (response !== null && typeof response === 'object') {
    const articles = (response as LLMDigestPayload).articles;
    if (Array.isArray(articles)) return response as LLMDigestPayload;
  }

  if (typeof response !== 'string' || response === '') return null;

  const cleaned = stripFencesAndPreamble(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const candidate = extractFirstJsonObject(cleaned);
    if (candidate === null) return null;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const articles = (parsed as LLMDigestPayload).articles;
  if (!Array.isArray(articles)) return null;
  return parsed as LLMDigestPayload;
}

/** Strip ```json or ``` fences and any prose preamble before the first
 * `{`. Leaves everything from the first brace-match opening to the last
 * closing brace. */
function stripFencesAndPreamble(raw: string): string {
  let s = raw.trim();
  // Remove leading ```json or ``` and trailing ``` fences.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  // Cut any prose before the first '{'.
  const firstBrace = s.indexOf('{');
  if (firstBrace > 0) s = s.slice(firstBrace);
  // Cut any trailing text after the last '}'.
  const lastBrace = s.lastIndexOf('}');
  if (lastBrace > -1 && lastBrace < s.length - 1) s = s.slice(0, lastBrace + 1);
  return s.trim();
}

/** Walk the string and return the first balanced {...} substring.
 * Respects string literals so a `}` inside a string does not close the
 * outer object. Returns null when no balanced pair is found. */
function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** Convert a validated LLM payload into a sanitized list of articles ready
 * for insertion. Drops entries that lack required fields or produce empty
 * text after sanitization. Each article's `source_name` is resolved from
 * the supplied map by canonicalized URL; articles whose URL is not in the
 * map (i.e., the LLM hallucinated a URL outside the fetched headlines)
 * get `source_name: null`. */
function sanitizeArticles(
  payload: LLMDigestPayload,
  sourceNameByCanonicalUrl: Map<string, string>,
  sourceTagsByCanonicalUrl: Map<string, string[]>,
  userHashtags: string[],
): GeneratedArticle[] {
  const rawArticles = Array.isArray(payload.articles) ? payload.articles : [];
  const userHashtagSet = new Set(userHashtags);
  const out: GeneratedArticle[] = [];
  for (const a of rawArticles) {
    if (a === null || typeof a !== 'object') continue;
    const title = sanitizeText(a.title);
    const url = typeof a.url === 'string' ? a.url.trim() : '';
    const oneLiner = sanitizeText(a.one_liner);
    const detailsRaw = Array.isArray(a.details) ? a.details : [];
    const details: string[] = [];
    for (const d of detailsRaw) {
      const sanitized = sanitizeText(d);
      if (sanitized !== '') details.push(sanitized);
    }
    if (title === '' || url === '' || oneLiner === '') continue;
    const canonical = canonicalize(url);
    const sourceName = sourceNameByCanonicalUrl.get(canonical) ?? null;
    // Tags: validated twice — first against the user's current hashtag
    // list (so a hallucinated tag never reaches the DB), then — if the
    // LLM omitted / returned all-invalid tags — fall back to the
    // source_tags that the fan-out recorded for this URL. Either path
    // yields a subset of the user's hashtags.
    const llmTags = Array.isArray(a.tags) ? a.tags : [];
    const validatedTags: string[] = [];
    const seenTags = new Set<string>();
    for (const t of llmTags) {
      if (typeof t !== 'string') continue;
      const lower = t.trim().toLowerCase().replace(/^#/, '');
      if (lower === '' || seenTags.has(lower)) continue;
      if (!userHashtagSet.has(lower)) continue;
      seenTags.add(lower);
      validatedTags.push(lower);
    }
    if (validatedTags.length === 0) {
      const fallback = sourceTagsByCanonicalUrl.get(canonical) ?? [];
      for (const t of fallback) {
        if (seenTags.has(t) || !userHashtagSet.has(t)) continue;
        seenTags.add(t);
        validatedTags.push(t);
      }
    }
    out.push({
      title,
      url,
      one_liner: oneLiner,
      details,
      tags: validatedTags,
      source_name: sourceName,
    });
  }
  return out;
}

/** Build a canonical-URL → source_name lookup from the fetched headlines.
 * First occurrence wins (mirrors the fan-out's dedupe priority, where
 * tag-specific feeds are inserted before generic sources). Used by
 * {@link sanitizeArticles} to persist the originating source on each
 * article row for the UI's source badge. */
function buildSourceNameMap(headlines: Headline[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const h of headlines) {
    const key = canonicalize(h.url);
    if (map.has(key)) continue;
    map.set(key, h.source_name);
  }
  return map;
}

/** Build a canonical-URL → source_tags lookup so `sanitizeArticles` can
 * fall back to the fan-out's source_tags when the LLM omits the `tags`
 * field entirely. A canonical URL may have come from multiple hashtags
 * (fan-out unions them); we keep the whole array. */
function buildSourceTagsMap(headlines: Headline[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const h of headlines) {
    const key = canonicalize(h.url);
    if (map.has(key)) continue;
    map.set(key, Array.from(new Set(h.source_tags ?? [])));
  }
  return map;
}

/**
 * Sanitize a single plaintext field. Applied to titles, one-liners, and each
 * bullet in details per REQ-GEN-006 AC #4.
 *
 *  1. Strip HTML tags via `/<[^>]*>/g` — the model is instructed to return
 *     plaintext, but defence in depth. A hostile headline could contain
 *     `<script>` which we never want to store or render.
 *  2. Strip ASCII control characters (U+0000..U+001F, U+007F..U+009F) so
 *     stray tabs, newlines, NULs, and Unicode C1 controls cannot break
 *     layout or sanitizer downstream.
 *  3. Collapse any run of whitespace (including the newlines we just kept
 *     in step 1, any non-breaking spaces, etc.) into a single ASCII space.
 *
 * Returns the empty string for nullish / non-string input or for text that
 * sanitizes away to nothing.
 */
export function sanitizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Step 1: strip HTML tags (non-greedy, matches across newlines since `.`
  // in a bracket set `[^>]` naturally spans them). Replace with a space
  // so adjacent words don't concatenate (e.g. "before<br/>after" → "before after").
  const withoutTags = value.replace(/<[^>]*>/g, ' ');
  // Step 2: strip ASCII/C0 control chars (0x00-0x1F + 0x7F) and C1 (0x80-0x9F).
  // Keep tab/LF/CR handling to the whitespace-collapse step so tokens like
  // "line1\nline2" don't concatenate without a space.
  let out = '';
  for (const ch of withoutTags) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      // Replace with a single space so whitespace collapse preserves the
      // word boundary.
      out += ' ';
      continue;
    }
    if (code >= 0x80 && code <= 0x9f) {
      out += ' ';
      continue;
    }
    out += ch;
  }
  // Step 3: collapse whitespace. `\s` in ES2018+ covers Unicode whitespace.
  return out.replace(/\s+/g, ' ').trim();
}

/** Build the statements for the single atomic batch write: article INSERTs,
 * digest status UPDATE, user dedupe-key UPDATE. Slugs are deduplicated
 * within the batch so the UNIQUE(digest_id, slug) index never trips. */
function buildFinalBatch(args: {
  db: D1Database;
  digestId: string;
  userId: string;
  tz: string;
  articles: GeneratedArticle[];
  executionMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  nowSeconds: number;
}): D1PreparedStatement[] {
  const { db, digestId, userId, tz, articles, executionMs, tokensIn, tokensOut, costUsd, nowSeconds } =
    args;

  const statements: D1PreparedStatement[] = [];
  const usedSlugs: string[] = [];
  articles.forEach((article, idx) => {
    const base = slugify(article.title) || `article-${idx + 1}`;
    const slug = deduplicateSlug(base, usedSlugs);
    usedSlugs.push(slug);
    const articleId = generateUlid();
    const detailsJson = JSON.stringify(article.details);
    const tagsJson = JSON.stringify(article.tags ?? []);
    statements.push(
      db
        .prepare(
          `INSERT INTO articles
             (id, digest_id, slug, source_url, title, one_liner, details_json, source_name, rank, tags_json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        )
        .bind(
          articleId,
          digestId,
          slug,
          article.url,
          article.title,
          article.one_liner,
          detailsJson,
          article.source_name,
          idx + 1,
          tagsJson,
        ),
    );
  });

  // Digest status update — the WHERE clause ensures we never overwrite a
  // row that was externally marked failed (e.g., by the stuck-digest
  // sweeper in REQ-GEN-007).
  statements.push(
    db
      .prepare(
        `UPDATE digests
         SET status = 'ready',
             execution_ms = ?1,
             tokens_in = ?2,
             tokens_out = ?3,
             estimated_cost_usd = ?4
         WHERE id = ?5 AND status = 'in_progress'`,
      )
      .bind(executionMs, tokensIn, tokensOut, costUsd, digestId),
  );

  // User dedupe-key update — applies to both scheduled and manual triggers
  // so a manual refresh consumes today's slot (REQ-GEN-006 AC #3).
  const localDate = localDateInTz(nowSeconds, tz);
  statements.push(
    db
      .prepare(
        `UPDATE users SET last_generated_local_date = ?1 WHERE id = ?2`,
      )
      .bind(localDate, userId),
  );

  return statements;
}

/** Run a single UPDATE to mark the digest failed. Never throws; callers
 * are expected to catch and log. `execution_ms` is populated so the history
 * view can show how long the failure took. */
async function markFailed(
  db: D1Database,
  digestId: string,
  code: DigestErrorCode,
  startedAtMs: number,
): Promise<void> {
  const executionMs = Date.now() - startedAtMs;
  await db
    .prepare(
      `UPDATE digests
       SET status = 'failed', error_code = ?1, execution_ms = ?2
       WHERE id = ?3 AND status = 'in_progress'`,
    )
    .bind(code, executionMs, digestId)
    .run();
}

/** Extract input-token count from a Workers AI response. Tolerates the
 * several key names different models use. Returns 0 when no count is
 * present (the cost/UI layer handles the "unknown" display). */
function extractTokensIn(r: AIRunResponse): number {
  if (typeof r.usage?.input_tokens === 'number') return r.usage.input_tokens;
  if (typeof r.usage?.prompt_tokens === 'number') return r.usage.prompt_tokens;
  if (typeof r.tokens_in === 'number') return r.tokens_in;
  return 0;
}

/** Extract output-token count. Mirrors {@link extractTokensIn}. */
function extractTokensOut(r: AIRunResponse): number {
  if (typeof r.usage?.output_tokens === 'number') return r.usage.output_tokens;
  if (typeof r.usage?.completion_tokens === 'number')
    return r.usage.completion_tokens;
  if (typeof r.tokens_out === 'number') return r.tokens_out;
  return 0;
}

/** Stringify an unknown error for log fields; truncate to keep log lines
 * reasonable. */
function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return String(err).slice(0, 500);
}

/* Expose internals for focused unit tests without forcing them through the
 * full pipeline. Not part of the public contract. */
export const __test = {
  parseHashtags,
  parseLLMPayload,
  sanitizeArticles,
  sanitizeText,
  extractTokensIn,
  extractTokensOut,
  extractFeeds,
  buildSourceNameMap,
};
