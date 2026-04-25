// Implements REQ-SET-002 (default hashtag seed for new accounts)
// Implements REQ-AUTH-001 (new-account seed for the global-feed rework)
//
// Canonical list of hashtags that a newly-created user starts with.
// Every entry is already in the storage-canonical form (lowercase,
// `[a-z0-9-]+` only, no leading `#`) so callers can JSON.stringify and
// persist directly. A separate `RESTORE_DEFAULTS_LABEL` is exported so
// both the UI button and the test suite share a single string source.

export const DEFAULT_HASHTAGS: readonly string[] = [
  'cloudflare',
  'mcp',
  'ai-agents',
  'generative-ai',
  'aws',
  'serverless',
  'azure',
  'zero-trust',
  'kubernetes',
  'devsecops',
  'threat-intel',
  'appsec',
  'coding-agents',
  'docker',
  'iam',
  'siem',
  'pqc',
  'openziti',
  'supply-chain-security',
  'gcp'
] as const;

/** Label used by the settings-page restore button. Single-source-of-
 * truth so UI + tests never drift. */
export const RESTORE_DEFAULTS_LABEL = 'Restore initial tags';

/** Label used by the settings-page clear-tags button. Clears the
 * user's entire tag list in one click — the typical use case is "I
 * want a completely custom tag set, not the 20 defaults I was seeded
 * with" and the alternative was removing 20 chips one-by-one via the
 * tag strip. Visible whenever the user has at least one tag; hidden
 * when the list is already empty. */
export const DELETE_ALL_TAGS_LABEL = 'Delete all tags';
