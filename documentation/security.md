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

**Notable choices (see AD11 for rationale):**

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

## Rate limiting (REQ-AUTH-003)

Auth endpoints (login, callback, refresh) use a fail-closed KV-backed sliding-window rate limiter. See `src/lib/rate-limit.ts` for bucket definitions and `documentation/configuration.md` for the `RATE_LIMIT_KV` binding.
