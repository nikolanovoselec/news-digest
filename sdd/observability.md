# Observability

Structured JSON logging as the single operational surface — no external observability service, no Analytics Engine. Every error code surfaced to users is sanitized. Security headers are applied uniformly on every response.

---

### REQ-OPS-001: Structured JSON logging

**Intent:** Every operational event is queryable through Cloudflare Logs without deploying a separate observability service.

**Applies To:** User (via operator investigation)

**Acceptance Criteria:**
1. Log lines are emitted via `console.log(JSON.stringify({ ts, level, event, user_id?, ...fields }))` so Cloudflare Logs parses them as structured records.
2. The following events are logged: `auth.login`, `digest.generation`, `source.fetch.failed`, `refresh.rejected`, `email.send.failed`.
3. Each event carries a fixed set of fields documented in the observability implementation notes; new events are added by extending this enum.
4. Raw exception messages and external API response bodies are logged at `level: 'error'` but never stored in D1 and never returned to clients.

**Constraints:** CON-SEC-001
**Priority:** P1
**Dependencies:** None
**Verification:** Manual check
**Status:** Implemented

---

### REQ-OPS-002: Sanitized error surfaces

**Intent:** User-visible error messages never leak internal details that would aid an attacker or confuse a user.

**Applies To:** User

**Acceptance Criteria:**
1. The `digests.error_code` column uses a short sanitized enum: `llm_invalid_json`, `llm_failed`, `all_sources_failed`, `generation_stalled`, `user_cancelled`.
2. API error responses carry the code and a generic user-facing message; raw error details appear only in server logs.
3. The failure page on `/digest` displays the `error_code` in a muted monospace footer, never prose from the original error.
4. OAuth error codes follow a parallel allowlist (`access_denied`, `no_verified_email`, `invalid_state`, `oauth_error`) and any value not on the list is normalized to `oauth_error` before being put in a URL.

**Constraints:** CON-SEC-001
**Priority:** P0
**Dependencies:** REQ-OPS-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-OPS-003: Security headers on every response

**Intent:** Baseline browser protections apply uniformly, locked down to exactly what this app needs.

**Applies To:** User

**Acceptance Criteria:**
1. Every response includes `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://github.com`.
2. Every response includes `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
3. Every response includes `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.
4. Every response includes `Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), clipboard-read=()`.
5. No inline script tags exist anywhere in the app; the CSP `script-src` is `'self'` only.

**Constraints:** CON-SEC-001
**Priority:** P0
**Dependencies:** None
**Verification:** Integration test
**Status:** Implemented
