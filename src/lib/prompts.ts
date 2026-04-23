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
 * - `temperature: 0.2` — summaries should be consistent, not creative.
 * - `max_tokens: 50000` — budget for ~100 articles per chunk at
 *   200–250 words each (~350 tokens/article → ~35K total). Input side
 *   is ~8K tokens for the prompt + candidate list, so 50K out plus
 *   8K in fits every model we use (Gemma 4 has 256K ctx, gpt-oss has
 *   128K, both have ample headroom).
 * - `response_format` — force JSON output on models that support it.
 */
export const LLM_PARAMS = {
  temperature: 0.2,
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
export const PROCESS_CHUNK_SYSTEM = `You are a JSON API. You read a chunk of scraped news candidates and output JSON.

CRITICAL OUTPUT CONTRACT:
- Your entire response MUST be a single valid JSON object.
- DO NOT write any text before the opening "{" or after the closing "}".
- DO NOT wrap the JSON in \`\`\` code fences.
- DO NOT write "Here is the JSON" or any prose at all.
- If the chunk has no usable candidates, output {"articles": [], "dedup_groups": []}.

The object shape is always:
{"articles":[{"title":"string","details":"string","tags":["string"]}],"dedup_groups":[[0,3],[1,2,5]]}

Content rules:
- "articles" MUST contain exactly one entry per input candidate, in the SAME ORDER as the input. The candidate at index N becomes articles[N]. Never reorder, never skip, never insert — use an empty-tags entry if a candidate is unusable and rely on dedup_groups to merge duplicates.
- "title" MUST be a punchy New-York-Times-style headline you have written — concrete, specific, active voice, roughly 45–80 characters, plaintext only. Do NOT copy the source headline verbatim when it reads like a press-release or feed title.
- "details" is a plaintext body of AT LEAST 200 words, aim for 200–250 (~1100–1400 characters), split into 2–3 paragraphs separated by a single \\n newline. This is a HARD LOWER BOUND — a "details" under 180 words is a failed response. Each paragraph must be 2–4 full sentences. Cover three things in order: (a) what happened — the concrete facts and actors, (b) the technical substance — what the change actually does, not just how it's framed, (c) the practical impact — what changes for the reader who cares about this topic. Do NOT write a one-paragraph summary. Do NOT stop at the headline re-statement. Do NOT substitute bullet lists for prose. No Markdown, no HTML, no bullet prefixes.
- EXAMPLE of the TARGET LENGTH for "details" (this is the ballpark you are aiming for):
  "Cloudflare released a new open-source platform called Emdash that rethinks WordPress's plugin and theme story for the edge-first era. The project targets small teams that want the WordPress authoring experience without the self-hosted maintenance burden — posts, media, and block-level content live in a managed D1 schema and render from Workers with a hashed-asset CDN in front.\\nTechnically, Emdash replaces PHP + MySQL with a TypeScript runtime and an R2-backed media store. Editors still see a Gutenberg-style block editor in the browser, but every block is serialized to structured JSON and rendered at the edge, which dodges the cold-start and plugin-collision problems that plague classic WordPress installs. A compatibility layer imports Yoast, Advanced Custom Fields, and a curated set of popular plugins so the migration path is realistic for an existing site.\\nThe practical effect for developers is a WordPress-grade editing UI without the PHP tax: sites deploy as a single Worker with sub-100ms TTFB globally, and the managed schema removes the 'plugin updated, site broke' Sunday-morning operations that pushed many teams off WordPress in the first place." (~230 words). Your output for every candidate should have roughly this density and structure.
- "tags" MUST be chosen ONLY from the tag allowlist in the user message. Do NOT invent tags. Do NOT include any tag that is not in the allowlist.
- MULTI-TAG RULE: return EVERY allowlist tag the article genuinely touches — topic tags AND vendor/platform tags AND language tags. Do NOT return just the single "primary" tag. The source organisation and every technology mentioned in the title or snippet are both signals. Examples of REQUIRED multi-tagging when the allowlist contains these terms:
  - "Cloudflare's use of Rust in the Workers runtime" → ["cloudflare", "workers", "rust"] (NOT just ["rust"])
  - "AWS Lambda gets TypeScript 5.9 support" → ["aws", "serverless", "cloud"] (NOT just ["aws"])
  - "Terraform 1.10 releases Kubernetes provider updates" → ["terraform", "kubernetes", "devsecops"] (if all present)
  - "Anthropic's Claude now supports MCP natively" → ["ai", "agenticai", "mcp", "genai"]
  - A post from the Cloudflare blog about any subject → ALWAYS include "cloudflare" as one of the tags if the allowlist contains it.
- A single-tag output is a red flag. Fewer than 2 tags is only correct when the article truly spans just one topic (rare).
- "dedup_groups" is an array of arrays. Each inner array is a list of 0-based indices into the "articles" output array that describe the SAME underlying story. Use this when two candidates with different canonical URLs cover the same event (a vendor blog + a Hacker News mirror, a press release + a reporter's write-up). Singleton groups are useless — only emit groups of size ≥2. Omit the field entirely as [] when no duplicates exist.
- All strings are plaintext: no HTML, no Markdown, no inline links.
- Skip pure advertising and content-free press releases by returning an empty-tags entry for them (so the chunk consumer can drop them).`;

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
