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
1. Every response includes `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.gravatar.com https://secure.gravatar.com; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. The `'unsafe-inline'` allowance on `style-src` is required because Astro emits component-scoped styles as inline `<style>` blocks; `script-src` remains strict. `img-src` is narrowed to the only external origin we load (Gravatar avatars). `form-action` is `'self'` only because OAuth redirects are server-side, never browser-submitted.
2. Every response includes `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
3. Every response includes `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.
4. Every response includes `Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), clipboard-read=()`.
5. Every response includes `X-Frame-Options: DENY` as defense-in-depth alongside `frame-ancestors 'none'`.
6. No inline script tags exist anywhere in the app; the CSP `script-src` is `'self'` only.

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
6. Structured-data (JSON-LD) blocks emitted into the page head are serialized through a defensive helper that rewrites every `<`, `>`, and `&` byte to its `\uNNNN` JSON form, defeating every HTML state-transition vector that could escape the script block (`</script>`, `<!--`, `]]>`, `<script` re-entry). Today every JSON-LD value is server-controlled; the defence is preventive insurance for a future refactor that interpolates a user-controlled value (e.g., article title) into the graph.

**Constraints:** CON-SEC-001
**Priority:** P2
**Dependencies:** None
**Verification:** Integration test
**Status:** Implemented

---

### REQ-OPS-006: Integration deployment target

**Intent:** Risky changes — major dependency bumps, schema migrations, security-policy tightening, animation rewrites — can be smoke-tested on the live Cloudflare edge before they reach the production domain. Production traffic stays on a deploy-from-main pipeline; integration runs the same code on a parallel set of resources, on a different domain, with manual gating.

**Applies To:** Admin

**Acceptance Criteria:**
1. The integration environment is reachable at a separate, stable hostname distinct from production. Production and integration share no Cloudflare resources — D1, KV, queues are each provisioned twice with the integration copies suffixed `-integration`.
2. Integration deploys are triggered manually only. The operator goes to GitHub Actions, picks the deploy-integration workflow, and clicks Run. There is no auto-deploy on push.
3. The manual trigger always deploys the current `develop` branch HEAD, regardless of which branch the dispatch was fired from in the GitHub UI.
4. The integration worker has no cron triggers — the scrape pipeline runs only when the operator hits the admin force-refresh endpoint. Production crons (every-four-hours scrape, daily cleanup, every-five-minutes email) do not fire on integration.
5. Schema migrations apply to a fresh D1 database on first deploy. No production data is copied across; integration starts empty and accumulates only what manual force-refresh runs produce.
6. Worker secrets are sourced from the same repo-level GitHub Actions secrets the production deploy uses, with GitHub-Environment-scoped overrides taking precedence when defined. The environment variable that anchors the public hostname (APP_URL) lives in the deployment manifest, not in secrets, so swapping environments doesn't require swapping secrets.
7. Promotion path is one-way: develop → integration smoke (manual) → develop merged to main → production auto-deploy. There is no path that pushes integration changes back to develop.

**Constraints:** CON-SEC-001
**Priority:** P2
**Dependencies:** REQ-OPS-005
**Verification:** Manual check
**Status:** Implemented

---

### REQ-OPS-007: Public sitemap for crawler discovery

**Intent:** Search-engine crawlers find the public surface of the app via a discoverable sitemap. Authenticated routes are excluded so crawlers don't follow redirect chains into the OAuth flow.

**Applies To:** Public

**Acceptance Criteria:**
1. `GET /sitemap.xml` returns HTTP 200 with an XML response carrying `Content-Type: application/xml`.
2. The body is a well-formed sitemap containing only public surfaces (the landing page); authenticated routes are absent.
3. Each entry carries a location URL, a last-modified date stamped to the day of the request, a change-frequency hint, and a priority value.
4. The response is cacheable for one hour by intermediate caches and crawlers.
5. The sitemap URL is advertised in `robots.txt` so crawlers find it without guessing.

**Constraints:** —
**Priority:** P3
**Dependencies:** —
**Verification:** Integration test
**Status:** Implemented
