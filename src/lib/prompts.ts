// Implements REQ-GEN-005
// Implements REQ-DISC-001
// Implements REQ-DISC-005
//
// Centralised LLM prompts for the two calls the product makes:
//   1. Digest generation — rank + summarise up to 100 candidate headlines.
//   2. Source discovery — suggest authoritative RSS/Atom/JSON feeds for a tag.
//
// Kept in one file so iteration is easy, the system/user split is obvious,
// and all user-controlled fencing can be audited in one place. User-supplied
// content (hashtags, headlines, tag names) is always wrapped in triple-
// backtick fences so the model treats it as data, not instructions — the
// core prompt-injection mitigation for both calls.
//
// Inference parameters are pinned via LLM_PARAMS; a separate retry/model
// layer decides _which_ model runs, but the sampling knobs stay constant
// across calls so outputs remain reproducible.

import type { Headline } from '~/lib/types';

/**
 * Shared inference parameters for every Workers AI call.
 * - `temperature: 0.2` — summaries should be consistent, not creative.
 * - `max_tokens: 50000` — generous ceiling for up to 6 articles with
 *   ~200-char one-liners and 3× ~200-word detail paragraphs. The
 *   llama-3.3-70b default has a 128K context so 8K input + 50K output
 *   fits comfortably.
 * - `response_format` — force JSON output on models that support it.
 */
export const LLM_PARAMS = {
  temperature: 0.2,
  max_tokens: 50_000,
  response_format: { type: 'json_object' },
} as const;

export const DIGEST_SYSTEM = `You are a JSON API. You read headlines and output JSON.

CRITICAL OUTPUT CONTRACT:
- Your entire response MUST be a single valid JSON object.
- DO NOT write any text before the opening "{" or after the closing "}".
- DO NOT wrap the JSON in \`\`\` code fences.
- DO NOT write "Here is the JSON" or any prose at all.
- If you cannot produce a useful digest, output {"articles": []}.

The object shape is always:
{"articles":[{"title":"string","url":"string","one_liner":"string","details":["string","string","string"],"tags":["string"]}]}

Content rules:
- Pick between 15 and 30 headlines most relevant to the user's interests, ranked by relevance then recency. Fifteen is the floor when the candidate pool supports it; 30 is the hard ceiling.
- "title" MUST be a punchy, glance-ready New-York-Times-style headline of your own writing — concrete, specific, active voice, roughly 45–80 characters, and free of clickbait. Do NOT copy the source headline verbatim when it reads like a press-release or feed title. The goal is a headline a reader would pause on.
- "one_liner" is a single plaintext sentence, ~150–200 characters, stating the single most important fact about the article.
- Each "details" string is a plaintext paragraph about ~200 words covering context, specifics, and why it matters. No bullet prefixes, no lists inside the paragraph.
- Return exactly 3 details strings per article.
- "tags" MUST be the FULL set of user hashtags this article is genuinely about, not just one. A Cloudflare post about AI-powered code review must be tagged ["cloudflare", "ai"] — not just "cloudflare". An Azure zero-trust announcement must be tagged ["azure", "zero-trust", "cloud"]. Start from the candidate headline's "source_tags" (the authoritative set of tags the fan-out matched) and KEEP every entry the article is actually about. Only drop a source_tag when you are sure the article does not cover that topic. Never invent a tag the user did not provide.
- Aim for topical spread: across the returned articles, try to surface every user hashtag that has at least one real candidate in the input. If a particular hashtag has no decent candidate, it's fine to omit it — but don't stack 12 articles on one tag while starving the others when better candidates exist.
- All strings are plaintext: no HTML, no Markdown, no inline links.
- Skip duplicates, press releases with no substance, and pure advertising.
- If fewer than 15 good matches exist, return as many real matches as you have — do not pad with weak results.`;

/**
 * Build the user message for the digest call. User-controlled content
 * (hashtags, headlines) is fenced with triple backticks so the model treats
 * it as data; without fencing, a hostile headline's text could steer the
 * model's behaviour.
 */
export function digestUserPrompt(hashtags: string[], headlines: Headline[]): string {
  // Each candidate headline carries a `source_tags` array listing the
  // user hashtags that pulled it from a source. The LLM copies those
  // into the article's `tags` output, dropping any that the story
  // doesn't really cover. Pass the pruned headline shape explicitly
  // so the model doesn't see internal-only fields like `snippet`.
  const candidateHeadlines = headlines.map((h) => ({
    title: h.title,
    url: h.url,
    source_name: h.source_name,
    source_tags: h.source_tags ?? [],
  }));
  return `User interests (hashtags):
\`\`\`
${hashtags.join(', ')}
\`\`\`

Candidate headlines (JSON array). Each headline's "source_tags" field is
the authoritative list of user hashtags that matched the article during
fan-out — copy the relevant entries into the output "tags" field:
\`\`\`json
${JSON.stringify(candidateHeadlines)}
\`\`\`

Return between 15 and 30 articles in this JSON shape:
{
  "articles": [
    {
      "title": "punchy NYT-style headline you have written (roughly 45–80 characters)",
      "url": "URL from input, copied verbatim",
      "one_liner": "plaintext sentence, ~150–200 characters, the single most important fact",
      "details": ["paragraph ~200 words", "paragraph ~200 words", "paragraph ~200 words"],
      "tags": ["EVERY user hashtag this article is actually about — start from source_tags and keep all that apply, not just the most obvious one"]
    }
  ]
}

Each details entry is a full paragraph (~200 words) of plaintext prose — context, specifics, and why the story matters. No bullet prefixes, no lists, no code fences.`;
}

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
- "details" is a plaintext long-form body of 1–3 paragraphs, each paragraph roughly 40–300 characters, separated by a single newline. No Markdown, no HTML, no bullet prefixes.
- "tags" MUST be chosen ONLY from the tag allowlist in the user message. Do NOT invent tags. Do NOT include any tag that is not in the allowlist. Return the FULL set of allowlist tags that the article is genuinely about, not just one — an article about Cloudflare Workers AI must be tagged ["cloudflare", "workers", "ai"] if all three appear in the allowlist.
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
      "details": "1–3 paragraphs of plaintext prose, each 40–300 characters",
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
