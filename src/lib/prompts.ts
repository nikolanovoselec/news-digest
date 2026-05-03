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
 * Shared inference parameters across the chunk + finalize Workers AI
 * calls. Temperature and response_format are identical; only
 * max_tokens varies (CF-023). `LLM_PARAMS` remains exported as the
 * chunk-sized variant for backwards compatibility with any importer
 * that pulled the original constant.
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
 * Chunk-prompt budget — ~50 articles × 150-200 words each
 * (~280 toks/article → ~14K total with JSON overhead). Input side is
 * ~8K tokens for the prompt + candidate list.
 */
export const CHUNK_LLM_PARAMS = {
  ...LLM_BASE_PARAMS,
  max_tokens: 50_000,
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

/** Backwards-compatible alias. New code should import the variant
 *  that matches the call site (chunk vs finalize) directly. */
export const LLM_PARAMS = CHUNK_LLM_PARAMS;

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
- "dedup_groups": arrays of input-candidate indices that describe the same story (vendor blog + HN mirror, press release + reporter's write-up). Only groups of size ≥ 2. Omit the field as [] when none.
- Empty input → {"articles":[],"dedup_groups":[]}.

# TITLE RULES

- 45-80 characters.
- Punchy, NYT-style, active voice, concrete.
- Plaintext only — no HTML, no Markdown.
- Do NOT copy the source headline when it reads like a press release.

# DETAILS RULES — THIS IS THE CORE TASK

LENGTH — 150 to 200 WORDS:

  - Minimum 150 words. Under 120 words is malformed and will be dropped.
  - Maximum 200 words. Do not pad or repeat.

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

// Triple-backtick runs in `body_snippet` would break the fenced block
// the candidate is rendered inside, allowing an article body to escape
// the data section and inject into the structural prompt. The hard
// 2000-char cap is a defense-in-depth bound; upstream `fetchArticleBody`
// already truncates, but the prompt builder must not trust that.
const BODY_SNIPPET_MAX_CHARS = 2000;
function sanitizeBodySnippet(snippet: string): string {
  const stripped = snippet.replace(/`{3,}/g, '[code-block]');
  return stripped.length > BODY_SNIPPET_MAX_CHARS
    ? `${stripped.slice(0, BODY_SNIPPET_MAX_CHARS)}…`
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
    lines.push(`[${c.index}] ${c.title}`);
    lines.push(`    source: ${c.source_name}`);
    lines.push(`    url: ${c.url}`);
    lines.push(`    published_at: ${c.published_at}`);
    if (typeof c.body_snippet === 'string' && c.body_snippet !== '') {
      lines.push(`    snippet: ${sanitizeBodySnippet(c.body_snippet)}`);
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
- Two opinion pieces on the same topic from different angles.`;

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
    (c) => `[${c.index}] ${c.title} (published_at: ${c.published_at})\n${c.details}`,
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
