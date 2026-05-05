// Implements REQ-AUTH-001
// Implements REQ-PIPE-001
//
// Shared types used across src/lib and src/pages modules.
// CF-027: each export carries a JSDoc comment so callers can orient
// themselves without opening this file.
// This file is imported read-only by every domain module — when a domain
// needs a new cross-cutting type, add it here rather than duplicating.

/** Full authenticated-user record returned by a successful `loadSession`
 * call. Stored in `Astro.locals.user` by the middleware. */
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

/** A single article candidate emitted by a source adapter. Carries
 * the raw feed-entry fields; the coordinator adds `source_tags` and
 * the chunk consumer writes the summarised version to D1. */
export interface Headline {
  title: string;
  url: string;
  snippet?: string;
  source_name: string;
  /** Tags relevant to this headline. Populated by the coordinator via
   * the discovered-tag KV cache (`sources:{tag}` reverse-indexed) and
   * by curated-source registry entries; the LLM sees every matching
   * topic for the item. Extract() implementations don't need to set
   * it — the coordinator stamps the field after fetch. */
  source_tags?: string[];
  /** Unix-seconds publication timestamp parsed from the feed entry
   * (RSS `<pubDate>`, Atom `<published>`/`<updated>`, JSON Feed
   * `date_published`). Omitted when the feed did not supply a date
   * or when parsing failed — the coordinator falls back to ingestion
   * time so the article still lands with a usable value. */
  published_at?: number;
}

/** A feed URL discovered by the LLM-assisted source discovery pass
 * (REQ-DISC-001) and persisted to `sources:{tag}` in KV. */
export interface DiscoveredFeed {
  name: string;
  url: string;
  kind: 'rss' | 'atom' | 'json';
}

/** Shape of the `sources:{tag}` KV entry written by the discovery
 * pipeline and consumed by the coordinator fan-out. */
export interface SourcesCacheValue {
  feeds: DiscoveredFeed[];
  discovered_at: number;
}
