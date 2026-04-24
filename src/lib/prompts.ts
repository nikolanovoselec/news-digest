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
 * Shared inference parameters for every Workers AI call.
 * - `temperature: 0.5` — enough creative room to write full 3-paragraph
 *   summaries instead of collapsing to minimum-entropy 1-paragraph
 *   stubs. 0.2 (the prior value) was starving the model's verbosity.
 * - `max_tokens: 50000` — budget for ~50 articles per chunk at
 *   200-250 words each (~350 toks/article → ~18K total). Input side
 *   is ~8K tokens for the prompt + candidate list, so 50K out plus
 *   8K in fits comfortably inside gpt-oss-20b's 128K context.
 * - `response_format` — force JSON output on models that support it.
 */
export const LLM_PARAMS = {
  temperature: 0.5,
  max_tokens: 50_000,
  response_format: { type: 'json_object' },
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
{"articles":[{"title":"...","details":"...","tags":["..."]},...],"dedup_groups":[[0,3],[1,2,5]]}

- "articles": one entry per input candidate, same order as input. Candidate index N → articles[N]. Never reorder, skip, or insert. For an unusable candidate, emit the entry with empty tags.
- "dedup_groups": arrays of article indices that describe the same story (vendor blog + HN mirror, press release + reporter's write-up). Only groups of size ≥ 2. Omit the field as [] when none.
- Empty input → {"articles":[],"dedup_groups":[]}.

# TITLE RULES

- 45-80 characters.
- Punchy, NYT-style, active voice, concrete.
- Plaintext only — no HTML, no Markdown.
- Do NOT copy the source headline when it reads like a press release.

# DETAILS RULES — THIS IS THE CORE TASK

Every "details" value is a plaintext string with THIS EXACT STRUCTURE:

  - 3 paragraphs.
  - Each paragraph: 3-4 full sentences.
  - Paragraphs separated by the JSON escape sequence \\n (one backslash + n).
  - Total length: 200-250 words.

Paragraph roles, in order:

  1. WHAT happened — the concrete facts the candidate's snippet reports: who announced what, what shipped, what changed, when.
  2. HOW it works — the technical substance: architecture, API, mechanism, numbers.
  3. IMPACT for the reader — what the change means for someone working in this space: cost, migration effort, security posture, performance.

Every paragraph MUST be grounded in the candidate's snippet field. The snippet carries the article body; read it and compress it. Do not state facts that contradict the snippet.

Format example — the EXACT format your output must follow (3 paragraphs, \\n separators, 200-250 words total):

  "Cloudflare released Emdash, an open-source WordPress-inspired platform for Workers. The announcement lands with a public GitHub repo, a curated plugin compatibility layer, and a managed D1-backed content schema. Emdash targets small teams that want the WordPress authoring UX without the self-hosted maintenance burden.\\nTechnically, Emdash replaces PHP + MySQL with a TypeScript runtime and an R2-backed media store. The editor is a Gutenberg-style block editor in the browser; every block serializes to structured JSON and renders at the edge. A compatibility layer imports Yoast, Advanced Custom Fields, and a curated set of popular plugins, giving migrating sites a realistic path forward.\\nFor developers, the practical effect is a WordPress-grade editing UI without the PHP tax. Sites deploy as a single Worker with sub-100ms TTFB globally, the managed schema removes the 'plugin updated, site broke' Sunday-morning operations, and hashed-asset CDN caching happens automatically. Teams already running WordPress for marketing sites can pilot Emdash on a single domain without giving up the editor their marketing team trained on."

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
  // Candidates are rendered as a numbered list so the model has an
  // obvious, stable mapping between input index and output index. The
  // body_snippet is optional; omit the line when absent to keep the
  // prompt small.
  const lines: string[] = [];
  for (const c of candidates) {
    lines.push(`[${c.index}] ${c.title}`);
    lines.push(`    source: ${c.source_name}`);
    lines.push(`    url: ${c.url}`);
    lines.push(`    published_at: ${c.published_at}`);
    if (typeof c.body_snippet === 'string' && c.body_snippet !== '') {
      lines.push(`    snippet: ${c.body_snippet}`);
    }
  }

  return `Tag allowlist (output tags MUST be a subset of this list — never invent tags outside it):
\`\`\`
${tagList}
\`\`\`

Candidates (${candidates.length} entries, 0-indexed). Output exactly ${candidates.length} entries in the "articles" array in the same order — the candidate at index N must become articles[N]:
\`\`\`
${lines.join('\n')}
\`\`\`

Return JSON:
{
  "articles": [
    {
      "title": "punchy NYT-style headline, 45–80 characters",
      "details": "2–3 paragraphs of plaintext prose totalling 200–250 words, paragraphs separated by a single \\n newline",
      "tags": ["only tags from the allowlist above"]
    }
  ],
  "dedup_groups": [[0, 3], [1, 2, 5]]
}`;
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
- Prefer official blogs, release notes, and changelogs over third-party news sites.
- If you are unsure about a feed, omit it — returning fewer correct URLs is better than more guessed URLs.
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
