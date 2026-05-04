// Implements REQ-OPS-003
//
// Astro middleware that stamps baseline browser security headers onto every
// response. The policy is intentionally tight — locked down to exactly what
// the app needs — so any drift (third-party CDN, inline script, remote form
// submission) surfaces as a CSP violation during review rather than silently
// widening attack surface in production.
//
// Registration: this middleware is re-exported from `src/middleware/index.ts`
// (Astro auto-discovers that file). Order matters in that file — security
// headers run LAST so that upstream handlers cannot strip or override the
// headers we add here.
//
// Why the CSP string lives here verbatim rather than being composed from
// parts: it is an exact contract (REQ-OPS-003 AC 1). Drift between the spec
// and the served header has historically been a production incident pattern;
// making the string a single literal that tests pin byte-for-byte is the
// cheapest way to keep them in sync.
//
// Implementation note: we deliberately avoid importing `defineMiddleware`
// from `astro:middleware` here. That virtual module is only resolvable
// during Astro's build, not under vitest's cloudflare workers pool — any
// import of it would break the test suite. At runtime `defineMiddleware`
// is an identity function (it only helps TypeScript infer parameter
// types), so skipping it costs nothing. The middleware signature used
// here — `(context, next) => Promise<Response>` — matches what Astro's
// integration expects to find exported as `onRequest`.

/** Exact Content-Security-Policy value required by REQ-OPS-003 AC 1.
 * Pinned byte-for-byte in tests — do not reformat or reorder directives.
 *
 * `style-src 'self' 'unsafe-inline'`: required by two architectural
 * patterns the codebase deliberately uses — the FLIP tag-railing
 * animation in `src/lib/tag-railing-flip.ts` writes per-frame
 * `chip.style.transform = translate(...)` values, and the
 * view-transition-name pre-flight in `src/scripts/page-effects.ts`
 * sets `link.style.setProperty('view-transition-name', card-${slug})`
 * before SPA navigation so the browser pairs the source and
 * destination during the morph. Both write dynamic, per-event values
 * that no hash- or nonce-source can cover at runtime, and Astro also
 * emits component-scoped CSS as inline `<style>` blocks. The full
 * security/architecture reasoning, alternatives considered, and
 * conditions under which this should be revisited are documented in
 * AD11 (`documentation/decisions/README.md#ad11`). `script-src 'self'`
 * remains strict — the actual XSS-prevention work happens there.
 *
 * `img-src` is narrowed to `'self' data: https://www.gravatar.com
 * https://secure.gravatar.com` — the only external image origin we
 * actually load is the Gravatar avatar. The prior blanket `https:`
 * allowed any HTTPS origin to be embedded as `<img>`, which leaks
 * referrers and widens the exfiltration surface for free.
 *
 * `form-action 'self'` — OAuth flows redirect via 302 from server-side
 * handlers, never via a `<form action="https://github.com/...">`. The
 * prior `https://github.com` allowance was a vestige of an earlier
 * design that submitted from the browser and is no longer needed.
 *
 * `frame-ancestors 'none'` is the modern equivalent of `X-Frame-
 * Options: DENY`; both are still emitted as defense-in-depth for older
 * UAs that don't respect `frame-ancestors`. */
// CF-019: this exact string is pinned by `tests/e2e/csp-policy.spec.ts`.
// `'unsafe-inline'` in `style-src` is intentional per AD11 (FLIP
// transforms + view-transition-name pre-flight write inline styles
// at runtime). Do NOT remove `'unsafe-inline'` without proposing a
// concrete alternative for those two patterns AND updating both AD11
// and the e2e spec; a "just drop it" PR will fail the e2e gate.
export const CSP_HEADER_VALUE =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.gravatar.com https://secure.gravatar.com; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

/** HSTS value required by REQ-OPS-003 AC 2 — two-year max-age, subdomains,
 * and opt-in to the HSTS preload list.
 *
 * Subdomain footprint (CF-036): `includeSubDomains; preload` instructs
 * browsers to apply HSTS to every `*.<apex>` host of the deployed origin.
 * Once a domain is on the preload list, removing the directive is
 * effectively irreversible — preload-list updates take months to
 * propagate and cached entries persist for the max-age window.
 * Operators MUST verify all current and planned subdomains of the
 * deployed apex serve HTTPS before this header reaches a new domain.
 * Audit on 2026-05-04 confirmed `news.novoselec.ch` and `news.graymatter.ch`
 * apexes serve HTTPS only; no HTTP-only sibling subdomains were found.
 * Forks deploying to a new apex MUST repeat this audit before first
 * production deploy. */
export const HSTS_HEADER_VALUE = 'max-age=63072000; includeSubDomains; preload';

/** Referrer-Policy value required by REQ-OPS-003 AC 3. */
export const REFERRER_POLICY_VALUE = 'strict-origin-when-cross-origin';

/** X-Content-Type-Options value required by REQ-OPS-003 AC 3. */
export const X_CONTENT_TYPE_OPTIONS_VALUE = 'nosniff';

/** X-Frame-Options as defense-in-depth — `frame-ancestors 'none'` in
 * the CSP is the modern equivalent and authoritative for compliant
 * UAs, but older browsers (Chrome ≤39, Firefox ≤32, IE) honour only
 * X-Frame-Options. Stamping both costs nothing. */
export const X_FRAME_OPTIONS_VALUE = 'DENY';

/** Permissions-Policy value required by REQ-OPS-003 AC 4. The app never uses
 * geolocation, microphone, camera, payment, or clipboard-read, so every
 * feature is explicitly denied with an empty allowlist. */
export const PERMISSIONS_POLICY_VALUE =
  'geolocation=(), microphone=(), camera=(), payment=(), clipboard-read=()';

/**
 * The five headers REQ-OPS-003 requires on every response, as a tuple list.
 * Exported for test pinning; the middleware applies these via `set()` to
 * clobber any upstream header of the same name.
 */
export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Content-Security-Policy', CSP_HEADER_VALUE],
  ['Strict-Transport-Security', HSTS_HEADER_VALUE],
  ['X-Content-Type-Options', X_CONTENT_TYPE_OPTIONS_VALUE],
  ['X-Frame-Options', X_FRAME_OPTIONS_VALUE],
  ['Referrer-Policy', REFERRER_POLICY_VALUE],
  ['Permissions-Policy', PERMISSIONS_POLICY_VALUE],
];

/**
 * Astro middleware that invokes downstream handlers, then stamps the five
 * REQ-OPS-003 security headers onto the resulting response.
 *
 * Uses `Headers.set()` (not `append()`) so that if a handler already emitted
 * one of these headers — for example a page-specific CSP — this middleware
 * normalises it back to the app-wide policy. REQ-OPS-003 AC 1-4 say EVERY
 * response carries these values; permitting downstream override would break
 * that invariant.
 */
export async function securityHeadersMiddleware(
  _context: unknown,
  next: () => Promise<Response>,
): Promise<Response> {
  const response = await next();
  for (const [name, value] of SECURITY_HEADERS) {
    response.headers.set(name, value);
  }
  return response;
}
