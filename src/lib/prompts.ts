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

export const DIGEST_SYSTEM = `You are a tech news curator. Read the list of headlines and pick the 10 most relevant to the user's interests.

Rules:
- Return strict JSON only. No prose, no code fences, no explanations.
- All strings are PLAINTEXT. No HTML, no Markdown syntax, no inline links.
- Rank by relevance to the user's interests, then by recency.
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

export const DISCOVERY_SYSTEM = `You suggest authoritative, stable, publicly accessible RSS/Atom/JSON feed URLs for a given technology or topic.

Rules:
- Return strict JSON only.
- Only suggest feeds you are highly confident exist at the given URL. Do NOT guess.
- Prefer official blogs, release notes, and changelogs over third-party news sites.
- If you are unsure about a feed, omit it — returning fewer correct URLs is better than more guessed URLs.`;

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
