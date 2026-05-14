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

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

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

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P0

**Dependencies:** [REQ-OPS-001](#req-ops-001-structured-json-logging)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-OPS-003: Content-Security-Policy on every response

**Intent:** The browser-enforced same-origin policy is tightened beyond the default so injected references, embedded frames, or third-party form submissions cannot escape the app's origin even if a future bug introduces user-controlled markup.

**Applies To:** User

**Acceptance Criteria:**
1. Every authenticated response carries a Content-Security-Policy header that restricts script execution to same-origin and blocks inline event handlers.
2. The Content-Security-Policy limits external image origins to those the app explicitly loads (Gravatar avatars) so an injected reference to an arbitrary third-party host cannot fetch images.
3. The Content-Security-Policy prevents the page from being embedded in an iframe and prevents forms from submitting to third-party origins.
4. Every response includes `X-Frame-Options: DENY` as defense-in-depth alongside `frame-ancestors 'none'`.
5. No inline script tags exist anywhere in the app; the CSP `script-src` is `'self'` only.

**Notes:** Exact CSP directive value is documented at [`documentation/security.md`](../documentation/security.md).

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P0

**Dependencies:** None

**Verification:** Integration test

**Status:** Implemented

---

### REQ-OPS-011: Transport and feature-policy headers on every response

**Intent:** Browser-enforced transport security and feature-permission policies travel on every response so the app's surface area for downgrade attacks, MIME-confusion attacks, referrer leakage, and unsolicited platform-feature access stays uniformly tight across pages and API responses.

**Applies To:** User

**Acceptance Criteria:**
1. Every response includes `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
2. Every response includes `X-Content-Type-Options: nosniff`.
3. Every response includes `Referrer-Policy: strict-origin-when-cross-origin`.
4. Every response includes `Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), clipboard-read=()`.

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P0

**Dependencies:** None

**Verification:** Integration test

**Status:** Implemented

---

### REQ-OPS-005: Admin force-refresh endpoint

**Intent:** The owner can trigger an out-of-band scrape tick when the regular every-four-hours cron has not yet fired and a manual top-up is wanted. Same work as the cron, no per-user state, no LLM cost difference. Behind the three-layer admin gate so other signed-in users cannot trigger it.

**Applies To:** Admin

**Acceptance Criteria:**
1. The endpoint accepts both POST and GET. Both methods do the same work, so callers can pick whichever fits their context (form submissions, JSON fetches, and direct URL visits all reach the same coordinator dispatch).
2. Triggering the endpoint starts a fresh scrape run with status running and sends one coordinator message — the same work the every-four-hours cron does.
3. If a run started by an earlier cron tick or a previous manual trigger is still running and started within the last two minutes, the endpoint reuses that run rather than starting a new one. This protects against accidental double-clicks and tab-restore replays.
4. The response is content-negotiated so browser callers land back on the settings surface with the run id visible and scripted callers can read the run id and reuse flag programmatically.
5. The endpoint is gated by all three admin layers per [REQ-AUTH-001](authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8: Cloudflare Access at the zone level (optionally audience-pinned), a valid worker session, and the session email matching the configured operator email; failure at any layer returns that layer's native deny response.

**Constraints:** [CON-AUTH-001](constraints.md#con-auth-001-custom-federated-oauthoidc-hmac-sha256-jwt), [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P2

**Dependencies:** [REQ-PIPE-001](generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-AUTH-001](authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider)

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

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

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
2. Integration deploys fire only on operator-initiated manual dispatch from GitHub Actions; no push to any branch auto-deploys to integration.
3. The manual trigger always deploys the current `develop` branch HEAD, regardless of which branch the dispatch was fired from in the GitHub UI.
4. The integration worker has no cron triggers — the scrape pipeline runs only when the operator hits the admin force-refresh endpoint. Production crons (every-four-hours scrape, daily cleanup, every-five-minutes email) do not fire on integration.
5. Schema migrations apply to a fresh D1 database on first deploy. No production data is copied across; integration starts empty and accumulates only what manual force-refresh runs produce.
6. Worker secrets are sourced from the same repo-level GitHub Actions secrets the production deploy uses, with GitHub-Environment-scoped overrides taking precedence when defined. The environment variable that anchors the public hostname (APP_URL) lives in the deployment manifest, not in secrets, so swapping environments doesn't require swapping secrets.
7. Promotion path is one-way: develop → integration smoke (manual) → develop merged to main → production auto-deploy. There is no path that pushes integration changes back to develop.

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P2

**Dependencies:** [REQ-OPS-005](#req-ops-005-admin-force-refresh-endpoint)

**Verification:** Manual check

**Status:** Implemented

**Notes:** Verification is the manual promotion checklist (develop -> integration smoke -> main). The deployment topology is exercised by [`.github/workflows/deploy-integration.yml`](../.github/workflows/deploy-integration.yml); the workflow's header comment carries the REQ-OPS-006 backlink for traceability.

---

### REQ-OPS-007: Public sitemap for crawler discovery

**Intent:** Search-engine crawlers find the public surface of the app via a discoverable sitemap. Authenticated routes are excluded so crawlers don't follow redirect chains into the OAuth flow.

**Applies To:** Public

**Acceptance Criteria:**
1. The sitemap endpoint returns an XML response carrying the standard sitemap content type.
2. The body is a well-formed sitemap containing only public surfaces (the landing page); authenticated routes are absent.
3. Each entry advertises a location, a last-modified date stamped to the day of the request, an update-frequency hint, and a relative priority per the sitemap protocol.
4. The response is cacheable by intermediate caches and crawlers for at least one hour.
5. The sitemap URL is advertised in the robots policy so crawlers find it without guessing.
6. The sitemap origin follows the request hostname, not a hardcoded one — a fork or staging deploy emits its own URLs, never the production origin.

**Constraints:** —

**Priority:** P3

**Dependencies:** —

**Verification:** Unit test

**Status:** Implemented

---

### REQ-OPS-008: Unified admin pipeline run trigger from the settings surface

**Intent:** An operator can run the complete cron-equivalent pipeline (scrape, embed any leftovers, then collapse cross-article duplicates) from the settings surface, instead of clicking separate admin actions in sequence and having to remember the right order. The wipe-and-re-embed pre-phase is governed by [REQ-OPS-010](#req-ops-010-wipe-and-re-embed-pre-phase-toggle).

**Applies To:** Admin

**Acceptance Criteria:**
1. The settings surface exposes one admin action inside an Administration section, labelled to the effect of "Refresh articles".
2. The action sequentially executes the optional wipe-and-re-embed pre-phase, a fresh scrape tick equivalent to the every-four-hours cron, a backfill of any embeddings the scrape did not land, and an oldest-first cross-article same-story sweep across the surviving pool.
3. Each phase only begins after the previous phase reports done; no phase fires speculatively or in parallel with its predecessor.
4. Every phase is gated by the same admin authentication used elsewhere in the admin surface ([REQ-AUTH-001](authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider)). An unauthenticated tab where the admin gate has lapsed surfaces the auth failure as a user-readable failed-status line rather than silently no-op'ing.

**Constraints:** [CON-AUTH-001](constraints.md#con-auth-001-custom-federated-oauthoidc-hmac-sha256-jwt), [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P2

**Dependencies:** [REQ-OPS-005](#req-ops-005-admin-force-refresh-endpoint), [REQ-PIPE-003](generation.md#req-pipe-003-same-story-dedupe-core-matching-contract), [REQ-AUTH-001](authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider), [REQ-OPS-010](#req-ops-010-wipe-and-re-embed-pre-phase-toggle)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-OPS-010: Wipe-and-re-embed pre-phase toggle

**Intent:** A toggle adjacent to the admin pipeline actions lets the operator opt into a corpus-wide wipe-and-re-embed pre-phase before the full pipeline run, so a change to the embedding model or input recipe can be rolled out across the whole surviving article pool on demand.

**Applies To:** Admin

**Acceptance Criteria:**
1. A toggle adjacent to the admin pipeline action lets the operator opt into the wipe-and-re-embed pre-phase before the scrape tick.
2. With the toggle off, the action skips the pre-phase and starts at the scrape tick.
3. With the toggle on, the action first wipes and re-embeds every surviving article, then proceeds to the scrape tick.

**Constraints:** [CON-AUTH-001](constraints.md#con-auth-001-custom-federated-oauthoidc-hmac-sha256-jwt)

**Priority:** P2

**Dependencies:** [REQ-OPS-008](#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-OPS-009: Admin pipeline run progress surface

**Intent:** Live progress of an in-flight admin pipeline run is visible while the run is in flight, survives navigation away from the surface so the operator can return mid-run, and persists terminal status across a freshness window so the outcome is still visible on the next visit rather than disappearing the moment it is rendered.

**Applies To:** Admin

**Acceptance Criteria:**
1. While either run kicked from [REQ-OPS-008](#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface) is in flight, both admin actions are disabled and a status line reports the current phase in user-readable prose; the status line updates as each phase advances, and both actions re-enable when the run finishes or errors.
2. The full pipeline run continues to completion irrespective of the operator's browser tab state, because every phase advance is driven server-side after activation; closing the tab, navigating away, or losing network mid-run does not interrupt the pipeline.
3. When the operator returns to the settings surface during an in-flight run, live progress is restored from the run's audit state.
4. If the operator navigates away while a run is in flight and returns within the last-thirty-minutes freshness window, the surface restores the most recent phase line.
5. When the underlying run completed while the operator was away, the restored status is annotated to indicate the run finished without their presence.
6. State older than the freshness window is forgotten and the surface paints fresh on return.
7. When a run reaches a terminal status (completed, denied by the auth gate, or kick-time error), the surface paints the terminal message and keeps it visible across reloads within the freshness window — replaced by the next kick or aged out by the freshness window in AC 6, never auto-cleared the moment it is rendered.

**Constraints:** [CON-AUTH-001](constraints.md#con-auth-001-custom-federated-oauthoidc-hmac-sha256-jwt), [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P2

**Dependencies:** [REQ-OPS-008](#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface)

**Verification:** Integration test

**Status:** Implemented
