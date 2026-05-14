# Security

**Audience:** Developers, Operators

Security controls implemented at the application layer. Each section follows the per-item shape from `documentation-discipline.md` Pass 5: a short prose description of the control, then bolded `**Threat:** / **Mitigation:** / **Verification:** / **Implements:**` fields naming the attacker capability, the application-layer response, the test that exercises it, and the REQ(s) that own the contract.

For threat-model overview see [REQ-OPS-003](../sdd/observability.md#req-ops-003-content-security-policy-on-every-response) and [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider).

## Contents

- [Content-Security-Policy](#content-security-policy)
- [HSTS](#hsts)
- [Auth cookie policy](#auth-cookie-policy)
- [Rate limiting](#rate-limiting)
- [Admin gate and JWT exp validation](#admin-gate-and-jwt-exp-validation)
- [Wipe-mode POST guard](#wipe-mode-post-guard)
- [Google id_token RS256 verification](#google-id_token-rs256-verification)
- [Admin endpoint cross-site guards](#admin-endpoint-cross-site-guards)
- [Dev-bypass prod guard](#dev-bypass-prod-guard)
- [Related Documentation](#related-documentation)

---

## Content-Security-Policy

Every response carries the following CSP directive:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https://www.gravatar.com https://secure.gravatar.com;
  connect-src 'self';
  font-src 'self' data:;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self'
```

Notable choices (see [AD11](decisions/README.md#ad11-keep-style-src-unsafe-inline-runtime-stylex-writes-are-intentional) for rationale):

- `style-src 'unsafe-inline'` — Astro emits component-scoped styles as inline `<style>` blocks; runtime FLIP animations write `.style.transform` directly. Both are intentional.
- `script-src 'self'` only — no eval, no inline scripts. Every client script is served as a static asset.
- `img-src` narrowed to Gravatar (the only external image origin).
- `form-action 'self'` — OAuth redirects are server-side; browsers never POST to a third party.

**Threat:** Reflected or stored XSS that injects an inline `<script>` or loads a malicious third-party script tag.
**Mitigation:** Browser refuses to execute scripts outside the listed sources, refuses inline scripts entirely, and refuses to load images / fonts / form posts outside the named origins.
**Verification:** `tests/observability/security-headers.test.ts` + `tests/e2e/csp-policy.spec.ts` + `tests/e2e/csp-violation.spec.ts` (Playwright listener catches violations in production-shape pages).
**Implements:** [REQ-OPS-003 AC 1](../sdd/observability.md#req-ops-003-content-security-policy-on-every-response)

---

## HSTS

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

Two-year max-age with subdomain coverage and HSTS preload list eligibility.

**Threat:** Active network attacker performs SSL stripping or a downgrade to plaintext HTTP on the first request from a new client.
**Mitigation:** Browser refuses non-HTTPS connections to the canonical host and every subdomain for two years; preload list entry covers the first-visit gap.
**Verification:** `tests/observability/security-headers.test.ts`.
**Implements:** [REQ-OPS-011 AC 1](../sdd/observability.md#req-ops-011-transport-and-feature-policy-headers-on-every-response)

---

## Auth cookie policy

| Cookie | Flags |
|--------|-------|
| `__Host-session` | `HttpOnly; Secure; SameSite=Lax; Path=/` |
| `__Host-refresh` | `HttpOnly; Secure; SameSite=Lax; Path=/` |

The `__Host-` prefix (RFC 6265bis) enforces Secure, Path=/, and no Domain attribute at the browser level — prevents subdomain hijacking of the session.

**Threat:** Session theft via XSS reading `document.cookie`, or a malicious subdomain setting a cookie that shadows the production session.
**Mitigation:** `HttpOnly` makes the cookie unreadable from JS; `__Host-` prefix forbids `Domain=` so a subdomain cannot scope a cookie to the parent; `SameSite=Lax` blocks cross-site sub-resource sends of the cookie.
**Verification:** `tests/auth/middleware.test.ts`, `tests/auth/refresh-tokens.test.ts`, `tests/auth/logout.test.ts` (assert cookie attributes on issuance, rotation, and clear).
**Implements:** [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-session-lifecycle), [REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation)

---

## Rate limiting

Auth endpoints (login, callback, refresh) use a fail-closed KV-backed sliding-window rate limiter. See `src/lib/rate-limit.ts` for bucket definitions and [`configuration.md`](configuration.md) for the `KV` namespace binding and key conventions.

Admin side-effecting endpoints (force-refresh, pipeline-run) carry their own per-operator hourly buckets (REQ-AUTH-001 AC 9g). A rate-limited admin click surfaces a `429` with `Retry-After` back to the operator's settings surface rather than silently dropping the request.

**Threat:** Brute-force credential stuffing on `/api/auth/*`, runaway loops by a compromised admin session, or refresh-token replay flooding.
**Mitigation:** Per-bucket sliding-window counter in KV; unauthenticated buckets keyed by IP, mutation buckets by user id, admin buckets by operator id; exhaustion returns 429 with `Retry-After`. Auth-login fails open on KV outage (so a backing-store hiccup never locks legitimate users out); refresh-token rules fail closed (so a stolen refresh cookie cannot exploit the outage). See [AD23](decisions/README.md#ad23-rate-limit-fail-policy-asymmetry).
**Verification:** `tests/lib/rate-limit.test.ts`, `tests/auth/rate-limited-format.test.ts`, plus the `tests/auth/*` suite that exercises each bucket boundary.
**Implements:** [REQ-AUTH-001 AC 9](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider)

---

## Admin gate and JWT exp validation

The admin gate in `src/middleware/admin-auth.ts` enforces two layers in order:

1. **Optional Layer 0** (when `CF_ACCESS_AUD` set): request must carry a Cloudflare Access assertion whose `aud` and `exp` claims are valid. Expired assertions are rejected server-side. Signature stays at the Access perimeter ([AD29](decisions/README.md#ad29-cloudflare-access-as-opt-in-additive-perimeter-not-security-boundary), [AD44](decisions/README.md#ad44-cloudflare-access-jwt-exp-validation-signature-still-trusted-from-the-perimeter)).
2. **Baseline** (always): valid session cookie + `ADMIN_EMAIL` match (case-insensitive).

**Threat:** Privileged action by a non-operator — either a stolen Access assertion that has since expired, a synthetic non-Access payload spoofing the header, or an authenticated non-admin user reaching an admin route.
**Mitigation:** Layer 0 rejects assertions whose `aud` does not match or whose `exp` is missing/past; baseline rejects any session cookie whose user email differs from `ADMIN_EMAIL`. A request that fails either layer is rejected before any side effect.
**Verification:** `tests/auth/middleware.test.ts` (baseline gate + email match), `tests/admin/*` (per-endpoint admin gate enforcement).
**Implements:** [REQ-AUTH-001 AC 8](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider), [AC 8a](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider)

---

## Wipe-mode POST guard

The destructive wipe-and-re-embed pipeline mode (`mode=wipe`) is only reachable via an explicit `POST` to `/api/admin/pipeline-run`. A `GET` request with `?mode=wipe` returns `405 Method Not Allowed` with `Allow: POST`, preventing cross-origin GET vectors (image tags, bookmarks, link previews) from triggering a corpus-wide re-embed. The idempotent `full` mode remains reachable via either method.

**Threat:** A logged-in operator opening an attacker-controlled page whose `<img src=".../pipeline-run?mode=wipe">` or similar GET vector triggers a corpus-wide re-embed (cost-amplification + temporary corpus rebuild).
**Mitigation:** The wipe branch enforces `request.method === 'POST'` before any side effect; GET-with-wipe returns 405. Browsers cannot send a same-site POST from a cross-origin context without a form submission, which the Origin check (next section) then catches.
**Verification:** `tests/queue/pipeline-consumer.test.ts` + admin-route tests covering the 405 branch.
**Implements:** [REQ-AUTH-001 AC 8d](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider)

---

## Google id_token RS256 verification

The Google OAuth callback verifies the `id_token` signature using RS256 against Google's published JWKS endpoint (`https://www.googleapis.com/oauth2/v3/certs`). Implemented in `src/lib/google-jwks.ts`. The keys are cached for 1 hour in KV under `oidc:jwks:google` so a stale-key scenario after a Google JWKS rotation self-heals within the hour. Prior to this (CF-013), claims were decoded without signature verification, relying solely on the TLS channel to the token endpoint.

The gate is fail-closed in production: if KV is unbound or the JWKS endpoint is unreachable, the `id_token` claims are discarded and the callback falls through to the userinfo endpoint as the authoritative source. On integration and test deployments (`IS_PRODUCTION = "false"`) the skip path is tolerated so a stubbed KV does not block sign-in. The `isProduction` flag is derived from `IS_PRODUCTION` in `callback.ts` and threaded into `ProfileFetcher` — see [`configuration.md`](configuration.md#worker-vars-non-secret).

**Threat:** Forged `id_token` from a man-in-the-middle on the token-endpoint TLS path, or a Google JWKS-rotation lag that lets an attacker re-use a retired key signature.
**Mitigation:** RS256 signature verified against the live JWKS for every callback; KV cache TTL kept short (1 hour) so a real rotation self-heals; production fails closed to the userinfo fallback rather than trusting unverified claims.
**Verification:** `tests/auth/callback-google.test.ts` (signature-pass and signature-fail paths), `tests/auth/callback.test.ts` (full callback flow with stubbed JWKS).
**Implements:** [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider)

---

## Admin endpoint cross-site guards

Admin POST endpoints (`embed-backfill`, `force-refresh`, `historical-dedup`) enforce an Origin check on browser-driven calls. Requests presenting an `Authorization: Bearer ...` header bypass the Origin check — scripted curl flows and dev-bypass sessions carry no session cookie and are not a CSRF surface. A browser-driven POST without a Bearer header must present an `Origin` matching `APP_URL` or receive `403 forbidden_origin`.

The GET `/api/admin/force-refresh` endpoint additionally enforces a `Sec-Fetch-Site` guard (defense-in-depth): `same-origin` and `none` are allowed; any other value (cross-site or cross-origin initiator) receives `403 "Cross-site request denied"`. This preserves the AD38 top-level-navigation pattern (post-SSO redirects from `cloudflareaccess.com` carry `Sec-Fetch-Site: none`) while closing the same-browser CSRF gap on the GET path. See [`api-reference-admin.md`](api-reference-admin.md) for per-endpoint auth notes.

**Threat:** Same-browser CSRF where an authenticated operator opens an attacker-controlled page that issues a state-changing fetch (POST embed-backfill, GET force-refresh) using ambient cookies.
**Mitigation:** POST endpoints reject any browser-driven request whose `Origin` does not match `APP_URL` (Bearer callers bypass since they carry no cookies); admin GETs additionally reject `Sec-Fetch-Site` values outside `same-origin` and `none`. AD38 preserves the top-level-navigation case so SSO callbacks and operator bookmarks still work.
**Verification:** `tests/pipeline/force-refresh.test.ts` (POST Origin gate, GET Sec-Fetch-Site matrix including the AD38 `none` case), plus the admin-route tests for each endpoint.
**Implements:** [REQ-AUTH-001 AC 8](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider), [AC 8e](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider)

---

## Dev-bypass prod guard

Routes under `/api/dev/*` return `404` on any deployment where the `IS_PRODUCTION` Worker var is `"true"` (see [`configuration.md`](configuration.md#worker-vars-non-secret)). The guard is fail-closed: a missing or unrecognised value is treated as production. `DEV_BYPASS_TOKEN` being set does not override this gate. Integration deployments set `IS_PRODUCTION = "false"`; see the [Dev-bypass runbook](deployment.md#dev-bypass-runbook-integration-only) for integration usage.

**Threat:** A `DEV_BYPASS_TOKEN` accidentally promoted from integration to production (via shared `wrangler.toml`, `gh secret set` typo, or environment-variable inheritance) exposes the test-only authentication backdoor on a public production hostname.
**Mitigation:** Every `/api/dev/*` handler short-circuits to a 404 when `IS_PRODUCTION === "true"`, before any token comparison. Missing or unrecognised `IS_PRODUCTION` values are treated as production (fail-closed), so an unset variable cannot accidentally enable the surface.
**Verification:** `tests/auth/*` covers the production-hostname 404 path; the dev-bypass runbook in `deployment.md` documents the integration-only usage shape.
**Implements:** [REQ-AUTH-001 AC 10](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider)

---

## Related Documentation

- [`architecture.md`](architecture.md) - Component map and security-headers middleware
- [`configuration.md`](configuration.md) - KV namespace binding and rate-limit key conventions
- [`api-reference-admin.md`](api-reference-admin.md) - Per-endpoint auth notes for the admin surface
- [`observability.md`](observability.md) - Rate-limiter atomicity, refresh fail-mode log fields, fingerprint-drift rationale
- [`decisions/README.md`](decisions/README.md) - AD8 (cookie policy), AD11 (CSP unsafe-inline), AD13 (no non-essential cookies), AD23 (rate-limit fail-closed), AD29 (Access as additive perimeter), AD38 (Sec-Fetch-Site none for SSO callbacks), AD44 (JWT exp validation)
- [`../sdd/`](../sdd/) - REQ-OPS-003, REQ-AUTH-001, REQ-AUTH-002, REQ-AUTH-003, REQ-AUTH-008
