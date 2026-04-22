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
}

export interface GeneratedArticle {
  title: string;
  url: string;
  one_liner: string;
  details: string[];
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
