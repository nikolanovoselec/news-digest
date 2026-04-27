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

---

### REQ-OPS-005: Admin force-refresh endpoint

**Intent:** The owner can trigger an out-of-band scrape tick when the regular every-four-hours cron has not yet fired and a manual top-up is wanted. Same work as the cron, no per-user state, no LLM cost difference. Behind the three-layer admin gate so other signed-in users cannot trigger it.

**Applies To:** Admin

**Acceptance Criteria:**
1. The endpoint accepts both POST (from the Settings page button) and GET (for direct URL visits and operator scripts). Both methods do the same work.
2. Triggering the endpoint starts a fresh scrape run with status running and sends one coordinator message — the same work the every-four-hours cron does.
3. If a run started by an earlier cron tick or a previous manual trigger is still running and started within the last two minutes, the endpoint reuses that run rather than starting a new one. This protects against accidental double-clicks and tab-restore replays.
4. The response is content-negotiated. Browsers and direct URL visits get a `303 See Other` redirect to `/settings?force_refresh=ok&run_id=...`. Operator scripts that send `Accept: application/json` get `200 OK` with `{ ok: true, scrape_run_id, reused }`.
5. The endpoint is gated by all three admin layers per REQ-AUTH-001 AC 8: Cloudflare Access at the zone level (optionally audience-pinned via `CF_ACCESS_AUD`), a valid worker session, and the session email matching the configured operator email. Failure at any layer returns the layer's native deny response (Access challenge, 401 unauthorized, or 403 forbidden).

**Constraints:** CON-AUTH-001, CON-SEC-001
**Priority:** P2
**Dependencies:** REQ-PIPE-001, REQ-AUTH-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-OPS-004: Crawler policy and public-surface discoverability

**Intent:** The landing page is the only public surface and should be cleanly indexable; every authenticated surface is explicitly hidden from crawlers. Well-behaved AI training crawlers are denied across the whole site. SEO metadata, a sitemap, a machine-readable crawling policy, and search-engine friendly error pages round out the contract so the one public URL is discoverable without leaking user content or feeding model training.

**Applies To:** User (via operator setup)

**Acceptance Criteria:**
1. The landing page carries title, description, canonical, and Open Graph metadata suitable for a search result card.
2. A crawler policy file declares the landing page and public assets as allowed, every authenticated surface and the API as disallowed, and blocks known AI training user agents.
3. A machine-readable agents policy file describes what the product is, what is public, and an explicit request not to train on content behind the login.
4. A sitemap is served from a stable URL, lists only public URLs, and is referenced from the crawler policy file.
5. Error pages served for not-found and server-error conditions are flagged no-index so crawler spaces stay clean.

**Constraints:** CON-SEC-001
**Priority:** P2
**Dependencies:** None
**Verification:** Integration test
**Status:** Implemented
