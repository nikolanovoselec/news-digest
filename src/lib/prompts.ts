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
- Pick up to 6 headlines most relevant to the user's interests, ranked by relevance then recency.
- "title" MUST be a punchy, glance-ready New-York-Times-style headline of your own writing — concrete, specific, active voice, roughly 45–80 characters, and free of clickbait. Do NOT copy the source headline verbatim when it reads like a press-release or feed title. The goal is a headline a reader would pause on.
- "one_liner" is a single plaintext sentence, ~150–200 characters, stating the single most important fact about the article.
- Each "details" string is a plaintext paragraph about ~200 words covering context, specifics, and why it matters. No bullet prefixes, no lists inside the paragraph.
- Return exactly 3 details strings per article.
- "tags" MUST be a non-empty subset of the user's interest hashtags (provided below) that this article is genuinely about. Use the candidate headline's own "source_tags" field as the authoritative source of truth — copy those entries into "tags", dropping any that the story does not really cover. Never invent tags the user did not provide.
- All strings are plaintext: no HTML, no Markdown, no inline links.
- Skip duplicates, press releases with no substance, and pure advertising.
- If fewer than 6 good matches exist, return fewer — do not pad with weak results.`;

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

Return exactly this JSON shape:
{
  "articles": [
    {
      "title": "punchy NYT-style headline you have written (roughly 45–80 characters)",
      "url": "URL from input, copied verbatim",
      "one_liner": "plaintext sentence, ~150–200 characters, the single most important fact",
      "details": ["paragraph ~200 words", "paragraph ~200 words", "paragraph ~200 words"],
      "tags": ["subset of the user's hashtags this article is about"]
    }
  ]
}

Each details entry is a full paragraph (~200 words) of plaintext prose — context, specifics, and why the story matters. No bullet prefixes, no lists, no code fences.`;
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
