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

## Rate limiting (REQ-AUTH-003)

Auth endpoints (login, callback, refresh) use a fail-closed KV-backed sliding-window rate limiter. See `src/lib/rate-limit.ts` for bucket definitions and [`configuration.md`](configuration.md) for the `KV` namespace binding and key conventions.

---

## Related Documentation

- [`architecture.md`](architecture.md) — Component map and security-headers middleware
- [`configuration.md`](configuration.md) — KV namespace binding and rate-limit key conventions
- [`decisions/README.md`](decisions/README.md) — AD8 (cookie policy), AD11 (CSP unsafe-inline), AD13 (no non-essential cookies), AD23 (rate-limit fail-closed)
- [`../sdd/`](../sdd/) — REQ-OPS-003, REQ-AUTH-001, REQ-AUTH-002, REQ-AUTH-003
