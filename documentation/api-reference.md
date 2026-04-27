# API Reference

All public and internal API endpoints.

**Audience:** Developers

Every mutating endpoint requires a valid session cookie and an `Origin` header matching the app's canonical origin (see [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)). All JSON responses use the shape `{ error: string, code: string, ...extras }` for errors.

---

## Pages

### GET /

Returns the landing page.

- **Anonymous:** `200` — renders the landing page with sign-in buttons for each configured provider.
- **Authenticated:** `303` → `/digest` — redirects authenticated users directly to their digest.

**Implements:** [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider)

### GET /404

Catch-all not-found page. Rendered by Astro for any URL that no route file claims. Carries `noindex=true` so stale bookmarks and mistyped URLs do not contaminate search engine indexes. Presents a calm headline ("Page not found") and a "Back to home" link.

**Implements:** [REQ-READ-006](../sdd/reading.md#req-read-006-empty-error-and-offline-pages) AC 5

### GET /500

Generic server-error fallback. Shown when an uncaught exception bubbles up to Astro's error-page handler. Carries `noindex=true`. Presents "Something went wrong" with a "Back to home" link.

**Implements:** [REQ-READ-006](../sdd/reading.md#req-read-006-empty-error-and-offline-pages) AC 5

---

## Authentication

### POST /api/auth/{provider}/login (also GET)

Initiates the OAuth/OIDC authorization-code flow for a configured provider. The dynamic `{provider}` segment matches entries in the provider registry (`github`, `google`); unknown names return 404. Generates random `state`, sets a per-provider `news_digest_oauth_state_{provider}` cookie (HttpOnly, 10-min TTL), redirects to the provider's authorize URL.

`POST` is the canonical entry point — the landing page submits a same-origin form to avoid mobile-browser prefetch races that regenerate the state cookie before the provider's callback returns. `GET` is retained for direct URL access (bookmarks, test tooling). Both methods are exempt from the Origin check per [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints) AC 4.

**Rate limit:** 10 requests / 60 seconds per IP (`auth_login` rule). Exhausted → `429 Too Many Requests` with `Retry-After` header. Fails open on KV errors so a backing-store outage cannot block sign-in.

**Implements:** [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9, [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

### GET /api/auth/{provider}/callback

Handles the provider's OAuth redirect. Validates the per-provider `state` cookie, exchanges the code for an access token (and id_token when the provider issues one), extracts a stable provider-specific user identifier plus a verified primary email.

Resolves `user_id` via the three-path `auth_links` lookup (implements [REQ-AUTH-007](../sdd/authentication.md#req-auth-007-cross-provider-account-dedup)):
- **Path A** — `(provider, provider_sub)` found in `auth_links` → reuse the linked `user_id`. Steady-state login for any returning user.
- **Path B** — no `auth_links` row yet, but a `users` row with the same verified email exists → insert a new `auth_links` alias pointing at that `user_id`. Prevents duplicate accounts when the same person signs in via a second provider.
- **Path C** — neither lookup matches → create a new `users` row keyed by `userIdFor(provider, sub)` (GitHub: bare numeric for legacy compatibility; Google: `google:<sub>`) and insert the first `auth_links` row in tandem.

Sets the session cookie and redirects to `/digest` for all users.

New accounts are inserted with complete onboarding defaults at the moment of first login — 20 seeded hashtags (`DEFAULT_HASHTAGS`), `digest_hour=8`, `digest_minute=0`, and `email_enabled=1`. The browser auto-corrects timezone on first `/digest` load via a client-side POST to `/api/auth/set-tz`. No `/settings` detour is required for new users.

**Rate limit:** 20 requests / 60 seconds per IP (`auth_callback` rule). Exhausted → `429 Too Many Requests` with `Retry-After` header. Fails open on KV errors.

**Implements:** [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9, [REQ-AUTH-004](../sdd/authentication.md#req-auth-004-oauth-error-surfacing), [REQ-AUTH-007](../sdd/authentication.md#req-auth-007-cross-provider-account-dedup)

**Error responses:**
- `access_denied`, `no_verified_email`, `oauth_error` — 3xx redirect to `/?error={code}&provider={name}`. The provider name lets the landing page surface a precise message ("Google did not return a verified email" instead of guessing).
- `invalid_state` (CSRF state mismatch) — HTTP 403 with an HTML body that meta-refreshes to `/?error=invalid_state`. Browsers do not auto-follow `Location` on 4xx responses, so the redirect is delivered via `<meta http-equiv="refresh">` in the body. The origin value interpolated into the body is HTML-escaped.

### POST /api/auth/refresh

Force-rotates the refresh-token row and mints a new 5-minute access JWT. Used by long-running tabs that need a fresh access JWT before issuing a state-changing XHR (the inline middleware refresh cannot safely rotate on the same POST that mutates state).

**Auth:** Requires the `__Host-news_digest_refresh` refresh cookie (the access JWT need not be valid). Origin check applies.

**Rate limit:** 10 requests / 60 seconds per IP (`auth_refresh` rule). Exhausted → `429 Too Many Requests` with `Retry-After` header.

**Response (success):** `200` with both `Set-Cookie` headers (new access JWT + rotated refresh cookie).

**Response (concurrent-rotation collision within 30 s grace window):** `200` with a new access JWT only; the refresh row is not re-rotated (concurrent call already won the race — this is a benign collision per [REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection) AC 4).

**Response (failure — missing/invalid/expired refresh cookie, reuse detected, fingerprint mismatch):** `401` with both cookies cleared, so a half-cleared session cannot persist.

**Error codes:** `unauthorized`, `forbidden_origin`

**Implements:** [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation) AC 5, [REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection)

### POST /api/auth/logout

Provider-agnostic. Bumps `session_version`, revokes the active refresh-token row (single-device-only — does not sign the user out of other devices), clears both the access and refresh cookies, redirects to `/?logged_out=1`.

**Auth:** Requires a valid session (access JWT or inline-refreshed via refresh cookie). Origin check applies.

**Rate limit:** 5 requests / 60 seconds per IP (`auth_logout` rule). Exhausted → `429 Too Many Requests` with `Retry-After` header.

**Response:** `303` redirect to `/?logged_out=1`

**Error codes:** `unauthorized`, `forbidden_origin`

**Implements:** [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation) AC 3, [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints), [REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection) AC 3

### POST /api/auth/set-tz

**Request:** `{ tz: string }` (IANA timezone — validated via `Intl.supportedValuesOf('timeZone')`)

**Response:** `200 { ok: true, tz: string }` | `400 invalid_tz` | `401 unauthorized` | `403 forbidden_origin`

Session near-expiry triggers a `Set-Cookie` refresh in the same response.

**Implements:** [REQ-SET-007](../sdd/settings.md#req-set-007-timezone-change-detection), [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

### DELETE /api/auth/account

**Request:** JSON body `{ confirm: "DELETE" }`

**Response:** `200 { ok: true, redirect: "/?account_deleted=1" }` (session cookie cleared, FK cascade deletes all user data, KV entries under `user:{id}:*` deleted best-effort) | `400 bad_request` (missing/unparseable body) | `400 confirmation_required` | `401 unauthorized` | `403 forbidden_origin`

**Implements:** [REQ-AUTH-005](../sdd/authentication.md#req-auth-005-account-deletion), [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

### POST /api/auth/account

Native-form transport path for account deletion. Accepts a `application/x-www-form-urlencoded` body with field `confirm=DELETE`. Intended for browsers that do not reliably fire the JS intercept layer (Samsung Browser, some in-app webviews). Enforces the same Origin check, session requirement, and confirmation contract as the DELETE path.

**Request:** form-encoded body `confirm=DELETE`

**Response:** `303` redirect to `/?account_deleted=1` (session cookie cleared, same cascade as DELETE) | `400 bad_request` (empty body or `Content-Length: 0`) | `400 confirmation_required` | `401 unauthorized` | `403 forbidden_origin`

**Implements:** [REQ-AUTH-005](../sdd/authentication.md#req-auth-005-account-deletion), [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

---

## Settings

### GET /api/settings

**Response:** `{ hashtags: string[], digest_hour: int, digest_minute: int, tz: string, model_id: string, email_enabled: bool, first_run: bool }`

**Implements:** [REQ-SET-001](../sdd/settings.md#req-set-001-unified-first-run-and-edit-flow)

### PUT /api/settings

**Request (JSON):** `{ hashtags: string[], digest_hour: int, digest_minute: int, model_id: string, email_enabled: bool }`

**Response:** `200 { ok: true, discovering: string[] }` — `discovering` lists any newly-added tags that will trigger discovery on the next cron.

**Error codes:** `invalid_hashtags`, `invalid_time`, `invalid_model_id`, `invalid_email_enabled`.

**Implements:** [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation), [REQ-SET-003](../sdd/settings.md#req-set-003-scheduled-digest-time-with-timezone), [REQ-SET-004](../sdd/settings.md#req-set-004-model-selection) *(Deprecated 2026-04-24)*, [REQ-SET-005](../sdd/settings.md#req-set-005-email-notification-preference)

### POST /api/settings

Native form-encoded fallback for the same settings update. Used when the JS fetch handler does not bind (Samsung Browser, in-app webviews, JS disabled). The `/settings` form declares `method="post" action="/api/settings"`.

**Request:** `application/x-www-form-urlencoded` — same fields as PUT.

**Response:** `303` redirect to `/settings` on success. On validation failure, redirects to `/settings?error=<code>` where `<code>` is one of `invalid_hashtags`, `invalid_time`, `invalid_email_enabled`; the settings page renders an inline error message next to the Save button from the query param; the param is stripped from the URL after display so a refresh does not re-show stale text.

**Implements:** [REQ-SET-001](../sdd/settings.md#req-set-001-unified-first-run-and-edit-flow), [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation), [REQ-SET-003](../sdd/settings.md#req-set-003-scheduled-digest-time-with-timezone), [REQ-SET-005](../sdd/settings.md#req-set-005-email-notification-preference)

---

## Digests

### GET /api/digest/today

**Response:**
```json
{
  "articles": [
    {
      "id": "string",
      "title": "string",
      "details": ["string"],
      "primary_source_name": "string",
      "primary_source_url": "string",
      "published_at": "ISO-8601",
      "tags": ["string"],
      "alt_source_count": 0,
      "starred": false,
      "read": false
    }
  ],
  "last_scrape_run": { "id": "string", "started_at": 0, "finished_at": 0, "status": "ready" } | null,
  "next_scrape_at": 1234567890 | null
}
```

Returns up to 29 articles from the global pool filtered by the session user's active hashtags, ordered by `ingested_at DESC, published_at DESC` — newest ingest wins so a fresh scrape always bubbles its articles to the top of the dashboard. The 30th position in the digest grid is always the "see today" tile (a fixed icon card that deep-links to `/history?date=YYYY-MM-DD`). `last_scrape_run` is the most recent completed `scrape_runs` row; `next_scrape_at` is `started_at + 14400` (unix seconds — the cron fires every 4 hours). The pool is always populated — no `live` flag or skeleton state.

**Implements:** [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest) AC 5

### GET /api/digest/:id

**Response:** Same article shape as `/today` for a single article by ID from the global article pool. Returns 404 if not found.

**Implements:** [REQ-READ-002](../sdd/reading.md#req-read-002-article-detail-view)

### GET /api/scrape-status

**Auth:** Required (session cookie).

**Response (idle):**
```json
{ "running": false }
```

**Response (in progress):**
```json
{
  "running": true,
  "id": "string",
  "started_at": 1234567890,
  "chunks_remaining": 3,
  "chunks_total": 12,
  "articles_ingested": 47
}
```

`chunks_remaining` and `chunks_total` are `null` when the coordinator has not yet written the chunk count to KV. `articles_ingested` defaults to `0`.

Reads one `scrape_runs` row (most recent by `started_at DESC`) plus one KV key (`scrape_run:{id}:chunks_remaining`). No LLM cost.

The KV `chunks_remaining` value is a **display mirror only** — it is decremented by chunk consumers for the live progress display, not the authoritative completion gate. The completion gate moved to D1 (`scrape_chunk_completions`, migration 0007) and the finalize lock to `scrape_runs.finalize_enqueued` (migration 0008) to eliminate the TOCTOU race window. When debugging a stuck run, inspect the D1 tables — the KV counter can lag without indicating a real stall.

Both the `running: false` and `running: true` responses carry a `Set-Cookie` refresh when the session is within 5 minutes of expiry, matching the behaviour of page-route handlers. This prevents repeated polling during a long scrape run from inadvertently expiring a user's session.

**Callers:**
- `/digest` — swaps the "Next update in Xm" countdown for "Update in progress" while `running=true`.
- `/settings` Force Refresh section — polls every 5s after form submission to show live `articles_ingested` and `chunks_remaining`.

**Implements:** [REQ-PIPE-006](../sdd/generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress), [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation) AC 4, [REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection)

---

## Discovery

### GET /api/discovery/status

**Response:** `{ pending: string[] }` — tags this user is waiting on for discovery.

**Implements:** [REQ-DISC-002](../sdd/discovery.md#req-disc-002-discovery-progress-visibility) *(Deprecated 2026-04-24)*

### POST /api/admin/discovery/retry

Verifies the submitted tag is in the session user's `hashtags_json`, clears `sources:{tag}` and `discovery_failures:{tag}` KV entries, then inserts a fresh `pending_discoveries` row so the next 5-minute discovery cron repopulates the tag.

**Access control:** `/api/admin/*` is protected by two independent layers — Cloudflare Access (zone-level JWT assertion header) and a Worker-side gate (`src/middleware/admin-auth.ts`) that also requires a valid session cookie and an `ADMIN_EMAIL` match. See [Deployment: Admin-only routes](deployment.md#admin-only-routes-cloudflare-access-gating). Implements [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8.

**Content-type: application/json**

**Request:** `{ "tag": "<tag>" }`

**Response:** `200 { "ok": true }` | `400 bad_request` | `400 unknown_tag` | `401 unauthorized` | `403 forbidden_origin`

**Content-type: application/x-www-form-urlencoded**

**Request:** form field `tag=<tag>` (native HTML form POST from the Stuck tags fieldset on `/settings`)

**Response:** `303` redirect to `/settings?rediscover=ok&tag=<tag>` — returns the operator to the settings page with a visible confirmation banner. Error responses are identical in status code to the JSON path; the redirect is only issued on success.

**Implements:** [REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover)

### POST /api/admin/discovery/retry-bulk (also GET)

Re-queues every "stuck" tag for the session user in one shot. A tag is stuck when its `sources:{tag}` KV entry has an explicitly empty `feeds` array (REQ-DISC-001 exhaustion path or REQ-DISC-003 self-healing eviction). Brand-new tags (no entry yet) are not queued — they are still discovering, not stuck. Backs the **Discover missing sources** button on `/settings`.

**Access control:** `/api/admin/*` is protected by two independent layers — Cloudflare Access (zone-level JWT assertion header) and a Worker-side gate (`src/middleware/admin-auth.ts`) that also requires a valid session cookie and an `ADMIN_EMAIL` match. See [Deployment: Admin-only routes](deployment.md#admin-only-routes-cloudflare-access-gating). Implements [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8.

**POST — canonical form submit path:**

**Content-type: application/x-www-form-urlencoded** (no body fields required)

**Response:** `303` redirect to `/settings?rediscover=ok&count=<N>` where `<N>` is the number of tags re-queued (`0` is a valid no-op success). Error responses: `401 unauthorized` | `403 forbidden_origin` | `500 internal_error`.

**GET — Cloudflare Access post-auth callback path:**

When Cloudflare Access intercepts the form's POST, bounces the user through SSO, and returns them via a GET to the original URL, this handler ensures they land on `/settings` with the correct outcome banner rather than seeing a 404. Clients that send `Accept: application/json` receive a JSON response instead of a redirect (for scripted callers).

**Response (browser, no `Accept: application/json`):** `303` redirect to `/settings?rediscover=ok&count=<N>` on success; `303` redirect to `/settings?rediscover=error` on session or internal error.

**Response (`Accept: application/json`):** `200 { ok: true, count: N }` on success | `401 unauthorized` | `500 { ok: false, error: "internal_error" }`.

No `Origin` check on GET — Cloudflare Access is the sole authentication gate for this path.

**Implements:** [REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover)

---

## Stars

### POST /api/articles/:id/star

Stars an article. Optimistic — the UI flips the icon before the response returns. Protected by the Origin check.

**Rate limit:** 60 requests / 60 seconds per user id (`article_star` rule). Exhausted → `429 Too Many Requests` with `Retry-After` header.

**Response:** `200 { ok: true, starred: true }` | `401 unauthorized` | `403 forbidden_origin` | `404 not_found` | `429 rate_limit_exceeded`

**Implements:** [REQ-STAR-001](../sdd/reading.md#req-star-001-star-and-unstar-articles), [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9

### DELETE /api/articles/:id/star

Unstars an article. Same auth, Origin, rate-limit, and error contract as POST.

**Response:** `200 { ok: true, starred: false }` | `401` | `403` | `404` | `429`

**Implements:** [REQ-STAR-001](../sdd/reading.md#req-star-001-star-and-unstar-articles), [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9

### GET /api/starred

**Response:** `{ articles: WireArticle[] }` — the session user's starred articles, newest star first, limit 60. Same article shape as `/api/digest/today`.

**Implements:** [REQ-STAR-002](../sdd/reading.md#req-star-002-starred-articles-page)

---

## Tags

### PUT /api/tags

Add or remove a single hashtag from the user's tag list. Persists immediately — no form submit required. Normalises to lowercase, strips `#`, rejects characters outside `[a-z0-9-]`, enforces 2–32 char length and max 25 tags.

**Rate limit:** 30 requests / 60 seconds per user id (`tags_mutation` rule). Shared with `POST /api/tags/restore`. Exhausted → `429 Too Many Requests` with `Retry-After` header.

**Request:** `{ tag: string, action: "add" | "remove" }`

**Response:** `200 { ok: true, hashtags: string[] }` | `400 invalid_tag` | `400 max_tags_reached` | `401` | `429 rate_limit_exceeded`

**Implements:** [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation), [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9

### POST /api/tags/restore

Replaces the user's hashtag list with the curated default seed from `DEFAULT_HASHTAGS`.

**Rate limit:** 30 requests / 60 seconds per user id (`tags_mutation` rule). Shared with `PUT /api/tags`.

**Response:** `200 { ok: true, hashtags: string[] }` | `401` | `429 rate_limit_exceeded`

**Implements:** [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation) AC 8, [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9

---

### POST /api/tags/delete-initial

Clears the new-user "would you like our suggested tags?" seed prompt by writing an empty `hashtags_json = '[]'` for the calling user. The settings page checks `hashtags_json IS NULL` to decide whether to show the seed prompt; setting it to a JSON empty array dismisses the prompt without committing the user to any tags.

**Auth:** Required (session cookie). Origin check applies — the form submits as `application/x-www-form-urlencoded` from `/settings` with the same-origin Origin header.

**Rate limit:** 30 requests / 60 seconds per user id (`tags_mutation` rule).

**Response:** `303 → /digest` on success | `401` if unauthenticated | `403 origin_mismatch` | `429 rate_limit_exceeded` | `500 { ok: false, error: "db_failed" }`

**Implements:** [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation), [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9

---

## Developer Tools

### POST /api/dev/login

Dev-only session minter. Bypasses the OAuth round-trip and writes a pre-baked session cookie for the synthetic e2e user (or `DEV_BYPASS_USER_ID` when set). Used by `scripts/e2e-test.sh` and local Playwright runs to skip browser-based sign-in.

**Access control:** Endpoint returns `404` when `DEV_BYPASS_TOKEN` is unset OR when the request's `Authorization: Bearer <token>` doesn't timing-safe-match it. The endpoint deliberately does not distinguish "wrong token" from "not found" — this avoids enumeration of dev-mode deployments. Endpoint also returns `404` if `OAUTH_JWT_SECRET` is missing (no JWT can be minted).

**Default user:** When `DEV_BYPASS_USER_ID` is unset the endpoint mints a session for `__e2e__` (the synthetic row from `migrations/0006_e2e_user.sql`), so e2e flows never mutate the operator's own account. Setting `DEV_BYPASS_USER_ID` to a real user id impersonates that user — only set this manually on staging.

**Response (success):** `204` with `Set-Cookie: oauth_session=...` (HttpOnly, Secure, SameSite=Lax). `401` if Bearer header is missing/malformed. `404` if disabled or token mismatch.

**Implements:** No product REQ — this endpoint is a dev/e2e test scaffold gated by `DEV_BYPASS_TOKEN`. Production deployments leave the secret unset, which makes the endpoint return 404. Documented here so operators forking the repo know it exists.

---

### POST /api/dev/trigger-scrape

Dev-only pipeline trigger. Kicks a real global-feed scrape (coordinator → chunks → LLM → D1) without waiting for the every-4-hours cron or needing Cloudflare Access.

**Access control:** Endpoint 404s when `DEV_BYPASS_TOKEN` is not configured. When the secret is set, the request must carry `Authorization: Bearer <DEV_BYPASS_TOKEN>` (timing-safe comparison). Any mismatch or missing header also returns `404` — the endpoint does not distinguish "wrong token" from "not found" to avoid enumeration.

**Response (success):** `202`
```json
{
  "ok": true,
  "scrape_run_id": "string",
  "status_url": "/api/scrape-status"
}
```

The pipeline runs asynchronously via Queues. Poll `GET /api/scrape-status` to watch progress; the run transitions to `status='ready'` with `articles_ingested > 0` when complete.

**Error responses:** `500 { ok: false, error: "start_run_failed" | "enqueue_failed" }` — if the D1 insert or queue send throws.

**Used by:** `scripts/e2e-test.sh` full-cycle scrape section — triggers the real pipeline and asserts that at least one article is ingested and that the first article's `details` field is ≥ 150 words (target contract: 150–200 words, 2–3 paragraphs per [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract) AC 3).

---

## Operator Tools

### POST /api/admin/force-refresh (also GET)

Operator-only endpoint that kicks the global-feed coordinator on demand — identical to what the `0 */4 * * *` cron fires automatically (every 4 hours at 00/04/08/12/16/20 UTC). Creates a fresh `scrape_runs` row with `status='running'` and sends a `SCRAPE_COORDINATOR` queue message.

**Access control:** `/api/admin/*` is protected by two independent layers — Cloudflare Access (zone-level JWT assertion header) and a Worker-side gate (`src/middleware/admin-auth.ts`) that also requires a valid session cookie and an `ADMIN_EMAIL` match. `POST` additionally enforces the standard Origin check ([REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)) as defence-in-depth against CSRF. `GET` is exempt from the Origin check so operators can trigger from a bookmark or `curl`. See [Deployment: Admin-only routes](deployment.md#admin-only-routes-cloudflare-access-gating). Implements [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8.

**Concurrency guard (120-second reuse window):** Before creating a new run, the handler queries for any `scrape_runs` row with `status='running'` started within the last 120 seconds. If one is found it is reused instead of dispatching a second coordinator. This absorbs double-clicks and link-preview bot refetches. Note: two truly concurrent requests can both pass the SELECT before either INSERT commits — the ULIDs are unique so no PK collision collapses the race; for an operator-only endpoint the tradeoff is acceptable.

**POST response:** `303` redirect to `/settings?force_refresh=ok` (new run) or `/settings?force_refresh=reused` (concurrency guard hit). The `/settings` page reads `?force_refresh=` in `init()` and renders the result in `[data-scrape-progress]`.

**GET response (content-negotiated):**
- Browser (no `Accept: application/json`) — admin gate passes → `303` redirect to `/settings?force_refresh={ok|reused}`.
- Browser (no `Accept: application/json`) — admin gate fails → `303` redirect to `/settings?force_refresh=denied`. Browsers never see a bare 403 body on the GET path.
- `Accept: application/json` — admin gate passes → `200 { ok: true, scrape_run_id: string, reused: bool }`.
- `Accept: application/json` — admin gate fails → `401 unauthorized` or `403 forbidden`.

Scripts and `curl` callers must send `Accept: application/json` to receive the JSON payload; omitting it triggers a redirect on both success and auth failure.

**Error response (both methods):** `500 "Failed to dispatch coordinator"` when the D1 INSERT or queue send throws.

**Implements:** [REQ-OPS-005](../sdd/observability.md#req-ops-005-admin-force-refresh-endpoint), [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence)

---

## SEO and Crawler Policy

### GET /sitemap.xml

Dynamic XML sitemap. Lists only the public landing page (`/`). `changefreq=daily`, `priority=1.0`, `lastmod` set to the current date at request time. `Cache-Control: public, max-age=3600`. Referenced from `robots.txt`.

**Implements:** [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability) AC 4

### GET /robots.txt

Static file served from `public/robots.txt`. Allows crawlers access to the landing page and public assets; explicitly disallows `/api/`, `/digest`, `/starred`, `/history`, `/settings`. Blocks known AI training user agents (GPTBot, anthropic-ai, ClaudeBot, Google-Extended, CCBot, PerplexityBot) with a blanket `Disallow: /`. References the sitemap URL.

**Implements:** [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability) AC 2

### GET /llms.txt

Static machine-readable agents policy (served from `public/llms.txt`). Describes the product, what is public, that every surface beyond the landing page requires a federated OAuth session (GitHub or Google), and an explicit request not to train on content behind the login. Links to the sitemap and `robots.txt`.

**Implements:** [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability) AC 3

### GET /llms-full.txt

Extended machine-readable agents policy (`public/llms-full.txt`). Superset of `llms.txt` — adds technology stack detail, storage layer, and GDPR basis for withholding per-user content.

**Implements:** [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability) AC 3

---

## History and Stats

### GET /api/history

**Query parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `date` | string (`YYYY-MM-DD`) | No | When present, filters to the single matching local day. Used for the "see today" deep-link from the digest grid. |

**Response:** `{ days: [...] }` — up to 14 day-groups keyed by the user's local timezone (users.tz), sorted `local_date DESC`. Empty days (no articles, no scrape ticks) are omitted. Each day group includes `local_date`, `article_count`, `articles[]` (articles from the global pool matching the user's active tags on that day), `ticks[]` (scrape_runs rows whose `started_at` falls in that day), and per-day aggregates: `day_tokens_in`, `day_tokens_out`, `day_cost_usd`, `day_articles_ingested`. Each tick entry includes `id`, `started_at`, `finished_at`, `articles_ingested`, `tokens_in`, `tokens_out`, `estimated_cost_usd`, and `status`.

The `/history` page also reads `?q=` (search query, ≥3 chars) and `?tags=` (comma-separated tag list) from the URL client-side to restore the exact filter state when the user returns via the browser back button from an opened article. These parameters are written to the URL via `replaceState` — they are not sent to `/api/history` on the server; the page filters the already-rendered cards in the browser.

**Implements:** [REQ-HIST-001](../sdd/history.md#req-hist-001-day-grouped-article-history) AC 4, AC 5

### GET /api/stats

**Response:** `{ digests_generated: int, articles_read: int, articles_total: int, tokens_consumed: int, cost_usd: number }`

After the global-feed rework `digests_generated`, `tokens_consumed`, and `cost_usd` are global (sourced from `scrape_runs`) — one tick represents one generation event shared across every user. `articles_total` and `articles_read` are per-user: they count articles in the global pool whose tags intersect the session user's currently-active tag list, and reads in `article_reads` scoped to that same pool. Reads on articles whose only tag the user has since deselected drop out of both numerator and denominator, so the ratio always describes "of the articles you can see right now, how many have you read" (see [REQ-HIST-002](../sdd/history.md#req-hist-002-user-stats-widget) AC 3). Queries run in parallel via `Promise.all`. Defaults to `0` for each field if no data exists.

**Implements:** [REQ-HIST-002](../sdd/history.md#req-hist-002-user-stats-widget)

---

## Observability

### Structured log events

Implements [REQ-OPS-001](../sdd/observability.md#req-ops-001-structured-json-logging). Every log line is `JSON.stringify`'d to `console.log` so Cloudflare Logs parses it as a structured record.

**Envelope** (all events):

| Field | Type | Description |
|---|---|---|
| `ts` | `number` | Unix milliseconds (`Date.now()`) |
| `level` | `"info" \| "warn" \| "error"` | Severity |
| `event` | `LogEvent` | Closed enum (see below) |

**Event enum** (`src/lib/log.ts` `LogEvent`):

| Event | When emitted |
|---|---|
| `auth.login` | Successful OAuth callback — user created or re-authenticated |
| `auth.callback.failed` | Any failure in the OAuth callback (token exchange, user fetch, DB) |
| `auth.callback.invalid_state` | CSRF state mismatch in the OAuth callback — returns 403 |
| `auth.logout` | Session version bumped; both cookies cleared; active refresh-token row revoked |
| `auth.logout.refresh_revoke_failed` | D1 revoke call in logout threw — session_version was still bumped so the session is invalidated; the refresh row will expire naturally |
| `auth.account.delete` | User row deleted from D1 (info on success, warn when no row affected) |
| `auth.account.delete.failed` | D1 delete threw, or KV cleanup threw |
| `auth.set_tz.failed` | D1 update in `POST /api/auth/set-tz` threw |
| `digest.generation` | Digest generation completed (success or failure) |
| `source.fetch.failed` | An individual source could not be fetched during fan-out |
| `refresh.rejected` | Manual refresh rejected (rate-limited or already in progress) |
| `auth.refresh.rotated` | Refresh-token row successfully rotated (inline middleware or explicit `/api/auth/refresh`) |
| `auth.refresh.rotate_failed` | D1 batch in `rotateRefreshToken` threw |
| `auth.refresh.expired` | Refresh cookie presented but the row is past its 30-day TTL |
| `auth.refresh.fingerprint_mismatch` | Refresh cookie valid but device fingerprint (UA + Cf-IPCountry) does not match the stored row — rejected |
| `auth.refresh.grace_fingerprint_mismatch` | Within the 30 s concurrent-rotation grace window but fingerprint still mismatches — rejected |
| `auth.refresh.concurrent_collision` | Refresh cookie's row is already revoked but within the 30 s grace window — served a fresh access JWT off the surviving child row without re-rotating |
| `auth.refresh.concurrent_lost_race` | Same as above; no surviving child row found — treated as reuse |
| `auth.refresh.reuse_detected` | Revoked refresh cookie presented outside the grace window — every refresh row for the user revoked + `session_version` bumped |
| `auth.refresh.purge_completed` | Daily purge of expired/old-revoked refresh-token rows completed |
| `auth.refresh.purge_failed` | Daily purge threw |
| `email.send.failed` | Resend API call failed |
| `email.dispatch.degraded` | Per-user D1 data-fetch failed during dispatch; static-fallback email still sent |
| `discovery.completed` | Per-tag LLM discovery run finished |
| `discovery.queued` | A new per-tag discovery job was inserted into `pending_discoveries` |
| `settings.update.failed` | D1 update in `PUT /api/settings` threw |
| `article.star.failed` | D1 insert or delete in `POST/DELETE /api/articles/:id/star` threw |

Raw exception messages appear only in the `detail` field of error-level records; they are never stored in D1 and never returned to clients (see [REQ-OPS-002](../sdd/observability.md#req-ops-002-sanitized-error-surfaces)).

---

## Related Documentation

- [Architecture](architecture.md) — Component overview
- [Configuration](configuration.md) — Required env vars and secrets
