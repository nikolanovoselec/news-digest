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
 * `style-src 'self' 'unsafe-inline'`: Astro emits component-scoped CSS
 * (the `data-astro-cid-*` mechanism) as inline `<style>` blocks at the
 * end of the head, NOT as external `.css` files. The first deploy of
 * `style-src 'self'` (no `'unsafe-inline'`) broke every page in
 * production: scoped styles for the landing page, the digest grid, the
 * tag railing, and every component-scoped animation were blocked. The
 * `'unsafe-inline'` allowance is the only viable policy until Astro
 * supports per-block nonce attribution for compiled scoped styles
 * (tracked upstream — no current workaround). `script-src 'self'`
 * remains strict. */
export const CSP_HEADER_VALUE =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://github.com";

/** HSTS value required by REQ-OPS-003 AC 2 — two-year max-age, subdomains,
 * and opt-in to the HSTS preload list. */
export const HSTS_HEADER_VALUE = 'max-age=63072000; includeSubDomains; preload';

/** Referrer-Policy value required by REQ-OPS-003 AC 3. */
export const REFERRER_POLICY_VALUE = 'strict-origin-when-cross-origin';

/** X-Content-Type-Options value required by REQ-OPS-003 AC 3. */
export const X_CONTENT_TYPE_OPTIONS_VALUE = 'nosniff';

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
