// Implements REQ-GEN-005, REQ-DISC-001, REQ-DISC-005
//
// Centralised LLM prompts for the two calls the product makes:
//   1. Digest generation — rank + summarise up to 300 candidate headlines.
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
 * - `max_tokens: 4096` — hard cap to prevent runaway generation.
 * - `response_format` — force JSON output on models that support it.
 */
export const LLM_PARAMS = {
  temperature: 0.2,
  max_tokens: 4096,
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
{"articles":[{"title":"string","url":"string","one_liner":"string","details":["string","string","string"]}]}

Curation rules:
- Pick up to 10 headlines most relevant to the user's interests, ranked by relevance then recency.
- All strings are plaintext: no HTML, no Markdown, no inline links, no bullet prefixes.
- Skip duplicates, press releases with no substance, and pure advertising.
- If fewer than 10 good matches exist, return fewer — do not pad with weak results.`;

/**
 * Build the user message for the digest call. User-controlled content
 * (hashtags, headlines) is fenced with triple backticks so the model treats
 * it as data; without fencing, a hostile headline's text could steer the
 * model's behaviour.
 */
export function digestUserPrompt(hashtags: string[], headlines: Headline[]): string {
  return `User interests (hashtags):
\`\`\`
${hashtags.join(', ')}
\`\`\`

Candidate headlines (JSON array):
\`\`\`json
${JSON.stringify(headlines)}
\`\`\`

Return exactly this JSON shape:
{
  "articles": [
    {
      "title": "plaintext title, copy as-is from input",
      "url": "URL from input",
      "one_liner": "plaintext, max 120 chars, the single most important fact",
      "details": ["bullet 1", "bullet 2", "bullet 3"]
    }
  ]
}

Each bullet is a complete plaintext sentence covering a critical point. Exactly 3 bullets per article, no leading "- " or "•" characters.`;
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
