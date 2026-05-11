// CF-028: shared helper for stamping error details into structured
// logs / DB columns. Strips stack frames, file path prefixes, and
// token-shaped substrings (`Bearer ...`, anything that resembles a
// URL with credentials, hex blobs ≥40 chars). The output is suitable
// for surfacing to operators via wrangler tail or admin dashboards
// without leaking the worker's filesystem layout or any secret
// material that an exception accidentally captured.
//
// Length-bounded so the caller doesn't need to slice again — D1's
// TEXT columns have no hard cap but `wrangler tail` truncates long
// lines, and downstream parsers like the settings dashboard render
// errors inline.

/** Maximum characters returned by sanitizeErrorDetail. Matches the
 *  per-line log payload budget used elsewhere in the codebase. */
const MAX_CHARS = 500;

/** Stack-frame line: `    at ...` (Node) or `... at file:///...` (V8). */
const STACK_FRAME_RE = /^\s*at\s.+$/gm;

/** `Bearer <token>` (case-insensitive). */
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

/** Hex blobs of ≥40 chars (covers SHA-1+ digests and token prefixes). */
const HEX_BLOB_RE = /\b[0-9a-fA-F]{40,}\b/g;

/** `proto://user:pass@host` URL credentials. */
const URL_CREDS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/** Absolute filesystem paths (Unix + Windows). */
const FS_PATH_RE = /(?:^|\s)((?:\/[^\s/:]+){2,}|[A-Za-z]:\\[^\s]+)/g;

export function sanitizeErrorDetail(err: unknown): string {
  let detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  detail = detail
    .replace(STACK_FRAME_RE, '')
    .replace(BEARER_TOKEN_RE, 'Bearer <redacted>')
    .replace(HEX_BLOB_RE, '<redacted-hex>')
    .replace(URL_CREDS_RE, '$1<redacted>@')
    .replace(FS_PATH_RE, ' <path>')
    .replace(/\s+/g, ' ')
    .trim();
  if (detail.length > MAX_CHARS) detail = detail.slice(0, MAX_CHARS);
  return detail;
}
