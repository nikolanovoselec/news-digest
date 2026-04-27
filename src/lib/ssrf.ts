// Implements REQ-DISC-005
// SSRF-safe URL validator for LLM-suggested feed URLs and user-provided
// article references. Pure string/IP parsing — no network calls.
//
// Rejection rules:
//   - Scheme must be https:
//   - No userinfo component (`@` in the URL)
//   - Hostname may not be `localhost` or begin with `metadata.`
//   - IPv4 hostname may not fall inside loopback (127/8), private (10/8,
//     172.16/12, 192.168/16), link-local (169.254/16), or CGNAT /
//     Cloudflare internal (100.64.0.0/10) ranges
//   - IPv6 hostname may not be loopback (::1) or link-local (fe80::/10)
//   - Unparseable URLs are unsafe by default
//
// This runs BEFORE any fetch — a malicious LLM suggestion cannot bypass it.

/**
 * Return true iff {@link url} is safe to fetch from the Workers runtime.
 * Defensive: any uncertainty → false.
 */
export function isUrlSafe(url: string): boolean {
  // Reject the user-info shortcut up front; some URL parsers silently
  // move the `@`-prefix segment into `username`, which still would not
  // reach our hostname check otherwise.
  if (url.includes('@')) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') {
    return false;
  }

  // Belt-and-suspenders: URL parser already places userinfo in
  // `username`/`password`, but we also bailed on `@` above.
  if (parsed.username !== '' || parsed.password !== '') {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === '') {
    return false;
  }

  if (hostname === 'localhost') {
    return false;
  }
  // Matches AWS IMDS (metadata.aws.amazon.com), GCP IMDS
  // (metadata.google.internal), and any user-chosen metadata host.
  if (hostname.startsWith('metadata.')) {
    return false;
  }

  // WHATWG URL renders IPv6 literals with their surrounding `[...]`.
  // Detect via the bracket form, then strip before passing to the classifier.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const inner = hostname.slice(1, -1);
    return !isPrivateIpv6(inner);
  }

  if (isIpv4Literal(hostname)) {
    return !isPrivateIpv4(hostname);
  }

  // Normal DNS hostname — not covered by the literal-IP rejection rules.
  // DNS rebinding is out of scope for this static check.
  return true;
}

/** True iff {@link host} is an IPv4 literal (four numeric octets). */
function isIpv4Literal(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) {
    return false;
  }
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) {
      return false;
    }
    if (!/^\d+$/.test(part)) {
      return false;
    }
    const n = Number(part);
    if (n < 0 || n > 255) {
      return false;
    }
  }
  return true;
}

/** True iff {@link host} (IPv4 dotted quad) falls in a private/reserved range. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => Number(p));
  // isIpv4Literal guarantees 4 numeric octets; guards for the type narrower.
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;

  // Loopback 127.0.0.0/8
  if (a === 127) return true;
  // Private 10.0.0.0/8
  if (a === 10) return true;
  // Private 172.16.0.0/12 — second octet 16..31
  if (a === 172 && b >= 16 && b <= 31) return true;
  // Private 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // Link-local 169.254.0.0/16
  if (a === 169 && b === 254) return true;
  // CGNAT / Cloudflare internal 100.64.0.0/10 — second octet 64..127
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 0.0.0.0/8 — "this network"
  if (a === 0) return true;

  return false;
}

/**
 * True iff {@link host} (IPv6 literal without `[]` brackets) is loopback
 * or link-local. The WHATWG URL parser normalises IPv6 to the canonical
 * short form, so we can match on the resulting prefixes.
 */
function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();

  // Loopback ::1 — the URL parser renders this verbatim.
  if (normalized === '::1') return true;

  // Link-local fe80::/10 — the first 10 bits are `1111 1110 10`, which
  // covers fe80..febf as the leading hextet. Matching the textual prefix
  // is enough because the parser emits lowercase hex.
  if (/^fe[89ab][0-9a-f]?:/.test(normalized)) return true;

  // Unique local fc00::/7 (fc00..fdff) — treat as private for defence in depth.
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;

  // IPv4-mapped ::ffff:10.0.0.1 style — reject if mapped to a private IPv4.
  const mapped = normalized.match(/^::ffff:([0-9.]+)$/);
  if (mapped && mapped[1] !== undefined && isIpv4Literal(mapped[1])) {
    return isPrivateIpv4(mapped[1]);
  }

  return false;
}
