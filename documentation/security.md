# Security

**Audience:** Developers, Operators

Security controls implemented at the application layer. For threat model overview see [REQ-OPS-003](../sdd/observability.md#req-ops-003-security-headers-on-every-response) and [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider).

---

## Content-Security-Policy (REQ-OPS-003 AC 1)

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

**Notable choices (see [AD11](decisions/README.md#ad11-keep-style-src-unsafe-inline-runtime-stylex-writes-are-intentional) for rationale):**

- `style-src 'unsafe-inline'` — Astro emits component-scoped styles as inline `<style>` blocks; runtime FLIP animations write `.style.transform` directly. Both are intentional.
- `script-src 'self'` only — no eval, no inline scripts. Every client script is served as a static asset.
- `img-src` narrowed to Gravatar (the only external image origin).
- `form-action 'self'` — OAuth redirects are server-side; browsers never POST to a third party.

---

## HSTS (REQ-OPS-003 AC 2)

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

Two-year max-age with subdomain coverage and HSTS preload list eligibility.

---

## Auth cookie policy (REQ-AUTH-002 / REQ-AUTH-008)

| Cookie | Flags |
|--------|-------|
| `__Host-session` | `HttpOnly; Secure; SameSite=Lax; Path=/` |
| `__Host-refresh` | `HttpOnly; Secure; SameSite=Lax; Path=/` |

The `__Host-` prefix (RFC 6265bis) enforces Secure, Path=/, and no Domain attribute at the browser level — prevents subdomain hijacking of the session.

---

## Rate limiting (REQ-AUTH-001 AC 9)

Auth endpoints (login, callback, refresh) use a fail-closed KV-backed sliding-window rate limiter. See `src/lib/rate-limit.ts` for bucket definitions and [`configuration.md`](configuration.md) for the `KV` namespace binding and key conventions.

Admin side-effecting endpoints (force-refresh, pipeline-run) carry their own per-operator hourly buckets (REQ-AUTH-001 AC 9g). A rate-limited admin click surfaces a `429` with `Retry-After` back to the operator's settings surface rather than silently dropping the request.

---

## Admin gate and JWT exp validation (REQ-AUTH-001 AC 8, AC 8a — AD44)

The admin gate in `src/middleware/admin-auth.ts` enforces two layers in order:

1. **Optional Layer 0** (when `CF_ACCESS_AUD` is set): the request must carry a Cloudflare Access assertion whose `aud` claim matches the configured audience tag. The `exp` claim on the Access JWT is validated server-side — an expired assertion is rejected even if the perimeter would ordinarily have caught it first (defence-in-depth against long-lived stolen tokens and synthetic non-Access payloads). Signature verification stays at the Access perimeter per [AD29](decisions/README.md#ad29-cloudflare-access-as-opt-in-additive-perimeter-not-security-boundary) and [AD44](decisions/README.md#ad44-cloudflare-access-jwt-exp-validation-signature-still-trusted-from-the-perimeter).
2. **Baseline** (always): valid session cookie + `ADMIN_EMAIL` match (case-insensitive).

---

## Wipe-mode POST guard (REQ-AUTH-001 AC 8d)

The destructive wipe-and-re-embed pipeline mode (`mode=wipe`) is only reachable via an explicit `POST` to `/api/admin/pipeline-run`. A `GET` request with `?mode=wipe` returns `405 Method Not Allowed` with `Allow: POST`, preventing cross-origin GET vectors (image tags, bookmarks, link previews) from triggering a corpus-wide re-embed. The idempotent `full` mode remains reachable via either method.

---

## Google id_token RS256 verification (REQ-AUTH-001)

The Google OAuth callback verifies the `id_token` signature using RS256 against Google's published JWKS endpoint (`https://www.googleapis.com/oauth2/v3/certs`). Implemented in `src/lib/google-jwks.ts`. The keys are cached for 1 hour in KV under `oidc:jwks:google` so a stale-key scenario after a Google JWKS rotation self-heals within the hour. Prior to this (CF-013), claims were decoded without signature verification, relying solely on the TLS channel to the token endpoint.

---

## Admin POST endpoints: Origin check with Bearer bypass (REQ-AUTH-001)

Admin POST endpoints (`embed-backfill`, `force-refresh`, `historical-dedup`) enforce an Origin check on browser-driven calls. Requests presenting an `Authorization: Bearer ...` header bypass the Origin check — scripted curl flows and dev-bypass sessions carry no session cookie and are not a CSRF surface. A browser-driven POST without a Bearer header must present an `Origin` matching `APP_URL` or receive `403 forbidden_origin`. See [`api-reference-admin.md`](api-reference-admin.md) for per-endpoint auth notes.

---

## Dev-bypass prod guard (REQ-AUTH-001 AC 10)

Routes under `/api/dev/*` return `404` on any deployment where the `IS_PRODUCTION` Worker var is `"true"` (see [`configuration.md`](configuration.md#worker-vars-non-secret)). The guard is fail-closed: a missing or unrecognised value is treated as production. `DEV_BYPASS_TOKEN` being set does not override this gate. Integration deployments set `IS_PRODUCTION = "false"`; see the [Dev-bypass runbook](deployment.md#dev-bypass-runbook-integration-only) for integration usage.

---

## Related Documentation

- [`architecture.md`](architecture.md) — Component map and security-headers middleware
- [`configuration.md`](configuration.md) — KV namespace binding and rate-limit key conventions
- [`decisions/README.md`](decisions/README.md) — AD8 (cookie policy), AD11 (CSP unsafe-inline), AD13 (no non-essential cookies), AD23 (rate-limit fail-closed), AD29 (Access as additive perimeter), AD44 (JWT exp validation)
- [`../sdd/`](../sdd/) — REQ-OPS-003, REQ-AUTH-001, REQ-AUTH-002, REQ-AUTH-003
