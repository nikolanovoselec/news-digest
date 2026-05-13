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

### REQ-OPS-003: Security headers on every response

**Intent:** Baseline browser protections apply uniformly, locked down to exactly what this app needs.

**Applies To:** User

**Acceptance Criteria:**
1. Every authenticated response carries a Content-Security-Policy header that restricts script execution to same-origin only and blocks inline event handlers. External image origins are limited to those the app explicitly loads (Gravatar avatars). The page cannot be embedded in an iframe and forms cannot submit to third-party origins. See `documentation/security.md` for the exact CSP directive value.
2. Every response includes `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
3. Every response includes `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.
4. Every response includes `Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), clipboard-read=()`.
5. Every response includes `X-Frame-Options: DENY` as defense-in-depth alongside `frame-ancestors 'none'`.
6. No inline script tags exist anywhere in the app; the CSP `script-src` is `'self'` only.

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
4. The response is content-negotiated. Browsers and direct URL visits get a `303 See Other` redirect to `/settings?force_refresh=ok&run_id=...`. Operator scripts that send `Accept: application/json` get `200 OK` with `{ ok: true, scrape_run_id, reused }`.
5. The endpoint is gated by all three admin layers per REQ-AUTH-001 AC 8: Cloudflare Access at the zone level (optionally audience-pinned via `CF_ACCESS_AUD`), a valid worker session, and the session email matching the configured operator email. Failure at any layer returns the layer's native deny response (Access challenge, 401 unauthorized, or 403 forbidden).

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
2. Integration deploys are triggered manually only. The operator goes to GitHub Actions, picks the deploy-integration workflow, and clicks Run. There is no auto-deploy on push.
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

### REQ-OPS-008: Unified admin pipeline run from the settings surface

**Intent:** An operator can run the complete cron-equivalent pipeline (scrape, embed any leftovers, then collapse cross-article duplicates) or just the scrape step in isolation from the settings surface, instead of clicking separate admin actions in sequence and having to remember the right order. An optional pre-phase wipes and re-embeds the entire surviving article pool so a change to the embedding model or input recipe can be rolled out across the whole corpus on demand. Live progress is visible while the run is in flight, and progress survives navigation away from the surface so the operator can return mid-run and see where the pipeline currently is rather than a blank surface.

**Applies To:** Admin

**Acceptance Criteria:**
1. The settings surface exposes two adjacent admin actions inside an Administration section: a primary action labelled to the effect of "Full pipeline run" that, when activated, sequentially executes an optional wipe-and-re-embed of the entire surviving article pool, a fresh scrape tick equivalent to the every-four-hours cron, a backfill of any embeddings the scrape did not land, and an oldest-first cross-article same-story sweep across the surviving pool; and a sibling action labelled to the effect of "Refresh feeds" that runs only the scrape tick (the same work a single 4-hourly cron tick does) and reports completion when the scrape itself finishes, leaving the queue-driven embed and dedup work to proceed in the background. Each phase of the full run only begins after the previous phase reports done.
2. A toggle adjacent to the actions lets the operator opt into the wipe-and-re-embed pre-phase for the full run. The toggle has no effect on the refresh-feeds action. With the toggle off, the full run skips the pre-phase and starts at the scrape tick. With the toggle on, the full run first wipes and re-embeds every surviving article, then proceeds to the scrape tick.
3. While either run is in flight both actions are disabled and a status line reports the current phase in user-readable prose. The status line updates as each phase advances; both actions re-enable when the run finishes or errors.
4. The full pipeline run continues to completion irrespective of the operator's browser tab state. Once the operator activates the run, every subsequent phase advance is driven server-side; closing the tab, navigating away, or losing network mid-run does not interrupt the pipeline. When the operator returns to the settings surface, live progress is restored from the run's audit state.
5. If the operator navigates away from the surface while a run is in flight and returns within the last-thirty-minutes freshness window, the surface restores the most recent phase line. When the underlying run has completed in the meantime, the restored status is annotated to indicate the run finished while the operator was away. State older than the freshness window is forgotten and the surface paints fresh on return.
6. When a run reaches a terminal status (completed, denied by the auth gate, or kick-time error), the surface paints the terminal message and keeps it visible across reloads within the freshness window so the operator can see the outcome on return. The persisted terminal state is replaced by the next kick or aged out by the freshness window in AC 5; it is not auto-cleared the moment it is rendered.
7. Every phase is gated by the same admin authentication used elsewhere in the admin surface (REQ-AUTH-001). An unauthenticated tab where the admin gate has lapsed surfaces the auth failure as a user-readable failed-status line rather than silently no-op'ing.

**Constraints:** [CON-AUTH-001](constraints.md#con-auth-001-custom-federated-oauthoidc-hmac-sha256-jwt), [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P2

**Dependencies:** [REQ-OPS-005](#req-ops-005-admin-force-refresh-endpoint), [REQ-PIPE-003](generation.md#req-pipe-003-same-story-dedupe-core-matching-contract), [REQ-AUTH-001](authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider)

**Verification:** Integration test

**Status:** Implemented
