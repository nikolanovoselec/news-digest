// Reusable LLM response helpers consumed by the global-feed pipeline
// (src/queue/scrape-chunk-consumer.ts). The per-user generateDigest
// function was retired in the global-feed rework (Wave 3).


/** Shape Workers AI `.run()` returns. Different models surface token counts
 * under slightly different keys — the reader at the usage site tolerates all
 * the common variants (`usage.input_tokens`, `usage.prompt_tokens`,
 * top-level `tokens_in`). */
export interface AIRunResponse {
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

/** Shape the LLM is instructed to return. Validated at parse time. */
interface LLMPayload {
  articles?: Array<Record<string, unknown>>;
  [key: string]: unknown;
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
export function extractResponsePayload(aiResult: AIRunResponse): unknown {
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
export function parseLLMPayload(response: unknown): LLMPayload | null {
  // Some Workers AI models honour `response_format: json_object` by
  // returning an already-parsed object on `response` instead of a JSON
  // string. Accept that shape directly — the shape check below is the
  // same either way.
  if (response !== null && typeof response === 'object') {
    const articles = (response as LLMPayload).articles;
    if (Array.isArray(articles)) return response as LLMPayload;
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
  const articles = (parsed as LLMPayload).articles;
  if (!Array.isArray(articles)) return null;
  return parsed as LLMPayload;
}

/** Loose JSON parser shared by callers whose response shape doesn't carry
 *  an `articles` array — notably the cross-chunk dedup finalize prompt
 *  (REQ-PIPE-008) which returns `{dedup_groups: number[][]}` only. Same
 *  fence/preamble/brace-walking tolerance as `parseLLMPayload` above; the
 *  caller validates whichever fields it actually needs. */
export function parseLLMJson(response: unknown): Record<string, unknown> | null {
  if (response !== null && typeof response === 'object') {
    return response as Record<string, unknown>;
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
  return parsed as Record<string, unknown>;
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

/**
 * Sanitize a single plaintext field. Applied to titles, one-liners, and each
 * bullet in details.
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

/** Extract input-token count from a Workers AI response. Tolerates the
 * several key names different models use. Returns 0 when no count is
 * present (the cost/UI layer handles the "unknown" display). */
export function extractTokensIn(r: AIRunResponse): number {
  if (typeof r.usage?.input_tokens === 'number') return r.usage.input_tokens;
  if (typeof r.usage?.prompt_tokens === 'number') return r.usage.prompt_tokens;
  if (typeof r.tokens_in === 'number') return r.tokens_in;
  return 0;
}

/** Extract output-token count. Mirrors {@link extractTokensIn}. */
export function extractTokensOut(r: AIRunResponse): number {
  if (typeof r.usage?.output_tokens === 'number') return r.usage.output_tokens;
  if (typeof r.usage?.completion_tokens === 'number')
    return r.usage.completion_tokens;
  if (typeof r.tokens_out === 'number') return r.tokens_out;
  return 0;
}

