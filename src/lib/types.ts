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
  /** Unix-seconds publication timestamp parsed from the feed entry
   * (RSS `<pubDate>`, Atom `<published>`/`<updated>`, JSON Feed
   * `date_published`). Omitted when the feed did not supply a date
   * or when parsing failed — the coordinator falls back to ingestion
   * time so the article still lands with a usable value. */
  published_at?: number;
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
