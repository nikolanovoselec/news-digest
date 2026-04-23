// Shared types used across src/lib and src/pages modules.
// This file is imported read-only by every domain module — when a domain
// needs a new cross-cutting type, add it here rather than duplicating.

export interface AuthenticatedUser {
  id: string;
  email: string;
  gh_login: string;
  tz: string;
  digest_hour: number | null;
  digest_minute: number;
  hashtags_json: string | null;
  model_id: string | null;
  email_enabled: number;
  session_version: number;
}

export interface Headline {
  title: string;
  url: string;
  snippet?: string;
  source_name: string;
  /** User hashtags that produced this headline during fan-out. A single
   * canonical URL can match multiple tags (e.g. a Cloudflare blog post
   * that's relevant to both #cloudflare and #ai); dedupe unions the
   * tags so downstream the LLM sees every matching topic for the item.
   * Populated by fanOutForTags; extract() implementations don't need
   * to set it. */
  source_tags?: string[];
}

export interface GeneratedArticle {
  title: string;
  url: string;
  one_liner: string;
  details: string[];
  /** User hashtags this article belongs to. Returned by the LLM and
   * validated server-side against the user's current hashtag list. */
  tags: string[];
  /** Resolved from the dedupe headline map by canonicalized URL; `null` when
   * the LLM returned a URL not present in the fetched headlines (should be
   * rare — the prompt instructs the model to pick from the headline list). */
  source_name: string | null;
}

export interface DiscoveredFeed {
  name: string;
  url: string;
  kind: 'rss' | 'atom' | 'json';
}

export interface SourcesCacheValue {
  feeds: DiscoveredFeed[];
  discovered_at: number;
}
