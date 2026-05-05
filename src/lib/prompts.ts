// Implements REQ-DISC-001
// Implements REQ-DISC-005
//
// Centralised LLM prompts for the two calls the product makes:
//   1. Global-feed chunk processing — summarise and tag a batch of scraped candidates.
//   2. Source discovery — suggest authoritative RSS/Atom/JSON feeds for a tag.
//
// Kept in one file so iteration is easy, the system/user split is obvious,
// and all user-controlled fencing can be audited in one place. User-supplied
// content (tag names, candidate headlines) is always wrapped in triple-
// backtick fences so the model treats it as data, not instructions — the
// core prompt-injection mitigation for both calls.
//
// Inference parameters are pinned via LLM_PARAMS; a separate retry/model
// layer decides _which_ model runs, but the sampling knobs stay constant
// across calls so outputs remain reproducible.

/**
 * Shared inference parameters across the LLM calls. Temperature and
 * response_format are identical; only `max_tokens` varies per call
 * site (CF-023): chunk processing produces large multi-article
 * payloads, while finalize and discovery produce tiny JSON envelopes.
 *
 * - `temperature: 0.6` — warm enough for the model to pick longer
 *   completions over minimum-entropy short replies, cool enough for
 *   stable JSON output. 0.7 was working but 0.6 trims variance on
 *   the shorter 150-200 word target.
 * - `response_format` — force JSON output on models that support it.
 */
const LLM_BASE_PARAMS = {
  temperature: 0.6,
  response_format: { type: 'json_object' },
} as const;

/**
 * Chunk-prompt OUTPUT budget. gpt-oss-120b context is 128K and
 * `max_tokens` reserves output capacity against that window —
 * `prompt_tokens + max_tokens ≤ 128K` is enforced runtime-side.
 * Observed chunk output is ~14K tokens (50 articles × 200-word
 * summaries + JSON overhead); 32K gives ~2x headroom for an over-
 * eager run while leaving ~96K for input snippets. The coordinator's
 * greedy chunk packer (`scrape-coordinator.ts:CHUNK_INPUT_CHARS_BUDGET`)
 * keeps total input chars within that 96K-token envelope. The chunk
 * consumer always uses `DEFAULT_MODEL_ID` / `FALLBACK_MODEL_ID` —
 * user-selected budget models in `MODELS` are never wired here, so
 * smaller-context models do not constrain this value.
 */
export const CHUNK_LLM_PARAMS = {
  ...LLM_BASE_PARAMS,
  max_tokens: 32_000,
} as const;

/**
 * Finalize-prompt budget — output is just a `dedup_groups: number[][]`
 * payload, typically <100 tokens. The 50K cap inherited from the
 * shared variant was wasteful in both reservation and observability.
 * 4K leaves comfortable headroom for an over-eager LLM without
 * misrepresenting the call's actual token footprint.
 */
export const FINALIZE_LLM_PARAMS = {
  ...LLM_BASE_PARAMS,
  max_tokens: 4_000,
} as const;

/**
 * Discovery-prompt budget — output is `{ feeds: [{ url, name, kind }] }`,
 * usually a handful of entries. Same 4K cap as finalize: small JSON
 * envelope, no benefit from the chunk-sized 50K reservation.
 */
export const DISCOVERY_LLM_PARAMS = {
  ...LLM_BASE_PARAMS,
  max_tokens: 4_000,
} as const;

// Implements REQ-PIPE-002
//
// Chunk prompt for the global-feed pipeline. The coordinator splits the
// scraped candidate pool into ~100-item chunks and the chunk consumer
// calls the LLM once per chunk with this system prompt + a per-chunk
// user message built by `processChunkUserPrompt()`. The LLM output is
// strict JSON: `{articles: [{title, details, tags}], dedup_groups:
// [[idx,...]]}`. Each output article is index-aligned to the candidate
// list so the chunk consumer can look up the original source URL + name
// by position. `dedup_groups` carry intra-chunk "these are the same
// story" hints — the chunk consumer collapses each group to one primary
// article (earliest-published wins) and the rest land in
// `article_sources` rows.
export const PROCESS_CHUNK_SYSTEM = `You summarise scraped news candidates into JSON.

# OUTPUT FORMAT

Return ONE JSON object, nothing else. No prose, no code fences, no text before "{" or after "}".

Shape:
{"articles":[{"index":N,"title":"...","details":"...","tags":["..."]},...],"dedup_groups":[[0,3],[1,2,5]]}

- "articles": one entry per input candidate. Each entry MUST include its "index" field echoing the input candidate's bracketed index (the [N] in the user message). The consumer aligns output to input BY THIS INDEX, not by position — an entry without a correct "index" is dropped, so every summary you write is lost.
- Never change an entry's index. "index": 47 means "this entry summarises the candidate that appeared as [47] in the input list". Title, details, and tags in that entry MUST be about THAT specific candidate's URL and snippet — never mix facts across candidates.
- For an unusable candidate, still emit its entry with the correct index and empty tags so the consumer knows you saw it.
- "dedup_groups": arrays of input-candidate indices that describe THE SAME NEWS EVENT — not just the same topic. The bar is: would a reasonable reader say "I already read about this exact thing"? Only group when the answer is unambiguously yes. Only groups of size ≥ 2. Omit the field as [] when none.
- DO group: vendor blog post + HN/Lobsters mirror of that exact post; press release + reporter's write-up of that release; two outlets covering one announcement on the same day with overlapping facts.
- DO NOT group: two studies on the same topic citing different numbers (e.g. "25% of MCP servers vulnerable" and "6.2% of MCP servers vulnerable" are DIFFERENT studies — different methodology, different findings, never merge); two different incidents in the same product family; two opinion pieces about the same topic by different authors; rumour + later confirmation (these are separate events).
- When in doubt, leave the candidate ungrouped. A false split is cheap (two cards in the digest), a false merge is expensive (one of two real stories disappears).
- Empty input → {"articles":[],"dedup_groups":[]}.

# TITLE RULES

- 45-80 characters.
- Punchy, NYT-style, active voice, concrete.
- Plaintext only — no HTML, no Markdown.
- Do NOT copy the source headline when it reads like a press release.

# DETAILS RULES — THIS IS THE CORE TASK

LENGTH — 150 to 200 WORDS (NON-NEGOTIABLE CONTRACT):

  - The summary MUST be 150-200 words. This is the contract; do not
    ship under 150. If the snippet feels thin, extend the WHAT and
    HOW paragraphs with concrete grounded facts — never pad with
    filler, never repeat, but never cut short either.
  - Maximum 200 words. Do not exceed.
  - Truncated outputs are rejected server-side as malformed. Your
    target is 150-200; aim for the middle of that range.

STRUCTURE — 2 to 3 PARAGRAPHS:

  - 2 short paragraphs for a simple story; 3 paragraphs when there is real technical substance to unpack.
  - Paragraph breaks use the JSON escape sequence \\n (one backslash + n).
  - Each paragraph 3-5 full sentences.
  - No bullet lists, no Markdown, no HTML — plaintext only.

PARAGRAPH ROLES:

  1. WHAT happened — the concrete facts in the snippet: who announced what, what shipped, what changed, when.
  2. HOW it works — the technical substance: architecture, API, mechanism, numbers.
  3. IMPACT for the reader (optional third paragraph when the story warrants it) — cost, migration effort, security posture, performance, or a concrete use case.

GROUNDING: Every sentence MUST be grounded in the candidate's snippet. Do not state facts that contradict the snippet. If the snippet is thin, keep the summary short rather than invent detail.

Format example — a 3-paragraph, ~170-word summary in the exact format your output must follow:

  "Cloudflare released Emdash, an open-source WordPress-inspired platform for Workers. The announcement lands with a public GitHub repo, a curated plugin compatibility layer, and a managed D1-backed content schema. Emdash targets small teams that want the WordPress authoring UX without the self-hosted maintenance burden of running PHP.\\nTechnically, Emdash replaces PHP + MySQL with a TypeScript runtime and an R2-backed media store. The editor is a Gutenberg-style block editor; every block serialises to structured JSON and renders at the edge with no round-trip to an origin database. A compatibility layer imports Yoast, Advanced Custom Fields, and a curated set of popular plugins, giving migrating sites a realistic path forward.\\nFor developers, the practical effect is a WordPress-grade editing UI without the PHP tax. Sites deploy as a single Worker with sub-100ms TTFB globally, the managed schema removes the 'plugin updated, site broke' operations class, and hashed-asset CDN caching is automatic. Teams running WordPress for marketing sites can pilot Emdash on a single domain without retraining the editors they hired."

# TAGS RULES

- Pick ONLY from the tag allowlist supplied in the user message. Never invent.
- Return EVERY allowlist tag the article touches: topic tags, vendor/platform tags, and language tags all count.
- Single-tag output is a failure unless the article is truly about one thing.

Examples (assume the tag is in the allowlist):

  - "Cloudflare uses Rust in the Workers runtime" → ["cloudflare","workers","rust"]
  - "AWS Lambda gets TypeScript 5.9 support" → ["aws","serverless","cloud"]
  - "Terraform releases Kubernetes provider updates" → ["terraform","kubernetes","devsecops"]
  - Any Cloudflare-authored post → always include "cloudflare" if present in the allowlist.

# DROP RULES

- Pure advertising or content-free press releases → emit the entry with empty tags. The chunk consumer drops empty-tag entries.

# GLOBAL FORMATTING

- All strings are plaintext. No HTML, no Markdown, no bullet prefixes, no inline links.
- Paragraph breaks in "details" use the JSON escape \\n (one backslash + n). After JSON.parse on the client, \\n becomes a real newline character.`;

// Triple-backtick runs in any candidate-supplied field would break the
// fenced block the candidate is rendered inside, allowing the article
// to escape the data section and inject into the structural prompt.
// Every field interpolated into a fenced block is sanitized through
// this helper, with a per-field length cap as defense-in-depth (upstream
// fetch/feed code already enforces some caps; the prompt builder must
// not trust that). Newlines are preserved (LLMs need them); only the
// fence-escaping triple-backtick sequence is collapsed (CF-032).
const TITLE_MAX_CHARS = 300;
const SOURCE_NAME_MAX_CHARS = 100;
const URL_MAX_CHARS = 1000;
// Sized strictly above the upstream `SNIPPET_CAP` (15000 in
// article-fetch.ts) so this layered cap remains meaningful — an
// upstream regression that produced a 30K-char snippet would still
// be clamped here. Defense-in-depth, per CF-013.
const BODY_SNIPPET_MAX_CHARS = 16000;
const DETAILS_MAX_CHARS = 4000;

function sanitizePromptField(value: string, maxChars: number): string {
  const stripped = value.replace(/`{3,}/g, '[code-block]');
  return stripped.length > maxChars
    ? `${stripped.slice(0, maxChars)}…`
    : stripped;
}

/**
 * Build the user message for a single chunk-processing call. Wraps the
 * tag allowlist and the numbered candidate list in triple-backtick
 * fences so the model treats untrusted candidate text as data. The
 * allowlist is the union of `DEFAULT_HASHTAGS` + discovered-tag KV keys
 * at the time of fan-out; the chunk consumer validates every output tag
 * against this same set so a hallucinated tag never reaches D1.
 */
export function processChunkUserPrompt(
  candidates: Array<{
    index: number;
    title: string;
    url: string;
    source_name: string;
    published_at: number;
    body_snippet?: string;
  }>,
  allowedTags: readonly string[],
): string {
  const tagList = allowedTags.join(', ');
  const lines: string[] = [];
  for (const c of candidates) {
    lines.push(`[${c.index}] ${sanitizePromptField(c.title, TITLE_MAX_CHARS)}`);
    lines.push(`    source: ${sanitizePromptField(c.source_name, SOURCE_NAME_MAX_CHARS)}`);
    lines.push(`    url: ${sanitizePromptField(c.url, URL_MAX_CHARS)}`);
    lines.push(`    published_at: ${c.published_at}`);
    if (typeof c.body_snippet === 'string' && c.body_snippet !== '') {
      lines.push(`    snippet: ${sanitizePromptField(c.body_snippet, BODY_SNIPPET_MAX_CHARS)}`);
    }
  }

  return `Tag allowlist (output tags MUST be a subset of this list — never invent tags outside it):
\`\`\`
${tagList}
\`\`\`

Candidates (${candidates.length} entries, 0-indexed). Output up to ${candidates.length} entries in the "articles" array. Each entry MUST carry an "index" field that matches the bracketed [N] of the candidate it summarises — the server aligns your output to the input BY THAT FIELD, not by position, so an entry without a correct "index" is silently dropped:
\`\`\`
${lines.join('\n')}
\`\`\`

Return JSON:
{
  "articles": [
    {
      "index": 0,
      "title": "punchy NYT-style headline, 45-80 characters, about candidate [0] specifically",
      "details": "2-3 paragraphs of 3-5 sentences each, 150-200 words total, separated by \\n (WHAT happened / HOW it works / IMPACT for the reader) — grounded in candidate [0]'s snippet only",
      "tags": ["only tags from the allowlist above"]
    }
  ],
  "dedup_groups": [[0, 3], [1, 2, 5]]
}`;
}

// Implements REQ-PIPE-008
//
// Cross-chunk dedup pass. Runs once per scrape tick AFTER all chunks
// have written their articles to D1. Sees title + the full summary
// body for each candidate (the same `details` text the dashboard
// shows) so the model can identify same-story pairs by their actual
// content rather than by surface lexical overlap on the headline
// alone. Source name is deliberately excluded as a signal — two
// outlets covering the same event were occasionally blocked from
// clustering by a name mismatch (REQ-PIPE-008 AC 1, revised 2026-05-03).
// Output is the same `dedup_groups: number[][]` JSON contract as
// PROCESS_CHUNK_SYSTEM so the parsing path can be reused; we
// deliberately drop the `articles` field so the model doesn't waste
// tokens echoing back summaries the consumer already has.

export const FINALIZE_DEDUP_SYSTEM = `You receive scraped news articles and identify pairs/groups that describe the same news event.

# OUTPUT FORMAT

Return ONE JSON object, nothing else. No prose, no code fences, no text before "{" or after "}".

Shape:
{"dedup_groups":[[0,3],[1,2,5]]}

- "dedup_groups": arrays of input-candidate indices that describe the same news event (e.g. TechCrunch and The Verge both covering the same vendor announcement; vendor blog and HN mirror; press release and reporter's write-up). Only include groups of size >= 2.
- Use [] when no groups describe the same event.
- Be CONSERVATIVE: only group items when you are confident they describe the SAME news event, not just the same broad topic. Two unrelated stories about Kubernetes are NOT a group; two articles about the same Kubernetes 1.34 release announcement ARE.
- Ground every grouping decision in the SUMMARY BODY, not the headline alone. Two articles with similar-sounding titles but disjoint factual content are NOT the same event. Two articles whose bodies describe the same announcement / incident / release / paper ARE the same event even if their titles read very differently.

# WHAT COUNTS AS THE SAME EVENT

- Same vendor + same product launch / version release / feature announcement.
- Same incident / outage / security disclosure.
- Same acquisition / funding round / partnership.
- Same paper / research finding / benchmark result.

# WHAT DOES NOT COUNT

- Two stories about the same product but covering different features / different versions.
- Two stories about the same vendor but unrelated launches.
- Two opinion pieces on the same topic from different angles.
- Two studies / audits / benchmarks on the same topic citing DIFFERENT numbers, methodology, or authors. Example: "25% of MCP servers vulnerable" and "6.2% of MCP servers vulnerable" are DIFFERENT studies and must NEVER be merged, even though both bodies discuss MCP RCE risk. The numerical specificity is the load-bearing signal — when in doubt, leave them ungrouped.

# WHEN IN DOUBT, DO NOT MERGE

A false split (two cards in the digest that could have been one) is cheap. A false merge (one of two real stories disappears) is expensive — the user loses a story they would have read. Default to splitting; only group when the bodies overlap on the SAME specific facts (same numbers, same names, same date, same product version).`;

/**
 * Build the user message for the cross-chunk dedup call. Each candidate
 * is rendered as a `[N] title` line followed by the candidate's full
 * `details` body, so the model has both the headline and the grounded
 * factual content to compare. Source name is intentionally NOT
 * included — REQ-PIPE-008 AC 1 makes this an explicit non-signal so
 * two outlets covering the same event are never blocked from
 * clustering by a publisher-name mismatch.
 */
export function finalizeDedupUserPrompt(
  candidates: ReadonlyArray<{
    index: number;
    title: string;
    details: string;
    published_at: number;
  }>,
): string {
  const blocks = candidates.map(
    (c) =>
      `[${c.index}] ${sanitizePromptField(c.title, TITLE_MAX_CHARS)} (published_at: ${c.published_at})\n${sanitizePromptField(c.details, DETAILS_MAX_CHARS)}`,
  );
  return `Candidates (${candidates.length} entries, 0-indexed). Each candidate is a headline followed by its full summary body. Decide whether two candidates describe the same news event by comparing their bodies, not their headlines:
\`\`\`
${blocks.join('\n\n---\n\n')}
\`\`\`

Return JSON: {"dedup_groups":[[idx, idx, ...], ...]} or {"dedup_groups":[]} when none describe the same event.`;
}

export const DISCOVERY_SYSTEM = `You are a JSON API. You suggest authoritative, stable, publicly accessible RSS/Atom/JSON feed URLs for a given technology or topic, and output JSON.

CRITICAL OUTPUT CONTRACT:
- Your entire response MUST be a single valid JSON object.
- DO NOT write any text before the opening "{" or after the closing "}".
- DO NOT wrap the JSON in \`\`\` code fences.
- DO NOT write "Here is the JSON" or any prose at all.
- If you have no confident suggestions, output {"feeds": []}.

The object shape is always:
{"feeds":[{"name":"string","url":"string","kind":"rss"}]}

Discovery rules:
- Only suggest feeds you are highly confident exist at the given URL. Do NOT guess.
- Prefer official blogs, release notes, and changelogs when they exist — they are the strongest signal for a technical topic.
- When no authoritative first-party feed exists (typical for consumer brands, products, or non-technical topics), include the Google News query-RSS for the topic as a fallback. It always returns a valid RSS 2.0 feed with recent items aggregated across major publishers. Format: {"name":"Google News: <topic>","url":"https://news.google.com/rss/search?q=<topic>&hl=en-US&gl=US&ceid=US:en","kind":"rss"}. Substitute <topic> with the tag itself, URL-encoded if it contains characters outside [a-z0-9-].
- If you are unsure about a feed AND the Google News fallback also doesn't apply, omit it — returning fewer correct URLs is better than more guessed URLs.
- "kind" is one of "rss", "atom", or "json".`;

/**
 * Build the user message for the source-discovery call. The tag is fenced
 * with triple backticks so adversarial tag content cannot steer the model
 * (REQ-DISC-005). Validation of returned URLs happens independently of the
 * LLM response — a malicious suggestion cannot bypass the SSRF filter.
 */
export function discoveryUserPrompt(tag: string): string {
  return `Topic:
\`\`\`
#${tag}
\`\`\`

Return up to 5 authoritative feed URLs as:
{
  "feeds": [
    { "name": "Human-readable name", "url": "https://...", "kind": "rss" }
  ]
}

"kind" is one of "rss" | "atom" | "json". If you have no confident suggestions, return { "feeds": [] }.`;
}
