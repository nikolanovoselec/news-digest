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

Initiates the OAuth/OIDC authorization-code flow. `{provider}` matches the provider registry (`github`, `google`); unknown names return `404`. Sets a 10-minute `state` cookie and redirects to the provider's authorize URL. Exempt from the Origin check.

**Rate limit:** 10 / 60 s per IP (`auth_login`). Fails open on KV errors. Exhausted → `429` with `Retry-After`.

**Implements:** [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9, [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

### GET /api/auth/{provider}/callback

Validates the per-provider `state` cookie, exchanges the code for tokens, extracts a stable provider identifier and verified email. Resolves `user_id` via the three-path `auth_links` lookup ([REQ-AUTH-007](../sdd/authentication.md#req-auth-007-cross-provider-account-dedup)):

- **Path A** — `(provider, provider_sub)` found in `auth_links` → reuse linked `user_id`.
- **Path B** — no link, but a `users` row with the same verified email exists → insert a new `auth_links` alias.
- **Path C** — neither matches → create a new `users` row and the first `auth_links` row.

New accounts are seeded with default hashtags, `digest_hour=8`, `email_enabled=1`. Sets the session cookie and redirects to `/digest`.

**Rate limit:** 20 / 60 s per IP (`auth_callback`). Fails open on KV errors.

**Error responses:**
| Outcome | Status | Body |
|---|---|---|
| `access_denied`, `no_verified_email`, `oauth_error` | `3xx` | redirect to `/?error={code}&provider={name}` |
| `invalid_state` (CSRF) | `403` | HTML body with `<meta http-equiv="refresh">` to `/?error=invalid_state` |

**Implements:** [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9, [REQ-AUTH-004](../sdd/authentication.md#req-auth-004-oauth-error-surfacing), [REQ-AUTH-007](../sdd/authentication.md#req-auth-007-cross-provider-account-dedup)

### POST /api/auth/refresh

Force-rotates the refresh-token row and mints a new access JWT. Used by long-running tabs before a state-changing XHR.

**Auth:** Refresh cookie required (access JWT need not be valid). Origin check applies.

**Rate limit:** Two tiers, both fail-closed. Per-IP `auth_refresh_ip` 60 / 60 s (pre-validation); per-user `auth_refresh_user` 30 / 60 s (post-validation). Buckets shared with the inline middleware refresh path. Exhausted → `429` with `Retry-After`.

**Responses:**

| Outcome | Status | Cookies |
|---|---|---|
| Success — fresh rotation | `200` | new access JWT + rotated refresh cookie |
| Success — concurrent-rotation collision (within 30 s grace) | `200` | new access JWT only ([REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection) AC 4) |
| Failure — missing/invalid/expired cookie or reuse detected | `401` | both cleared |

**Error codes:** `unauthorized`, `forbidden_origin`

**Implements:** [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation) AC 5, [REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection)

### POST /api/auth/logout

Bumps `session_version`, revokes the active refresh-token row (single-device only), clears both cookies, redirects to `/?logged_out=1`.

**Auth:** Valid session. Origin check applies.

**Rate limit:** 5 / 60 s per IP (`auth_logout`).

**Response:** `303` → `/?logged_out=1`

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

Native form-encoded fallback for the same settings update. Used when the JS fetch handler does not bind.

**Request:** `application/x-www-form-urlencoded`

| Field | Type | Notes |
|---|---|---|
| `hour` | `"00"`–`"23"` | Zero-padded hour. Takes precedence over `time`. |
| `minute` | `"00"`, `"05"`, …, `"55"` | Zero-padded minute. Takes precedence over `time`. |
| `time` | `HH:MM` | Legacy single-field fallback. Used only when `hour`/`minute` are absent. |
| `tz` | string | IANA timezone. |
| `model_id` | string | Validated against `MODELS`. |
| `email_enabled` | `"on"` | Present when checked; absent when unchecked. |

**Response:** `303` → `/settings?saved=ok` on success; `303` → `/settings?error=<code>` on validation failure (`invalid_hashtags`, `invalid_time`, `invalid_email_enabled`).

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

Up to 29 articles from the article pool filtered by the user's active hashtags, ordered `ingested_at DESC, published_at DESC`. `next_scrape_at = last_scrape_run.started_at + 14400` (4-hour cron).

**Implements:** [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest) AC 5

### GET /api/digest/:id

**Response:** Same article shape as `/today` for a single article by ID from the article pool. Returns 404 if not found.

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

`chunks_remaining` and `chunks_total` are `null` when the coordinator has not yet written the chunk count to KV. `articles_ingested` defaults to `0`. The KV counter is a display mirror; the authoritative completion gate is in D1 (`scrape_chunk_completions`).

Both responses carry a `Set-Cookie` refresh when the session is within 5 minutes of expiry, so polling during a long scrape never expires the session.

**Polled by:** `/digest` (swaps countdown for "Update in progress"), `/settings` Force Refresh section (5 s poll for live progress).

**Implements:** [REQ-PIPE-006](../sdd/generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress), [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation) AC 4, [REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection)

---

## Discovery

> **Admin auth.** Every `/api/admin/*` route is gated by three layers: (a) Cloudflare Access zone-level JWT, (b) valid Worker session cookie, (c) session email matches `ADMIN_EMAIL`. See [Deployment: Admin-only routes](deployment.md#admin-only-routes-cloudflare-access-gating). Implements [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8.

### POST /api/admin/discovery/retry

Re-queues a single stuck tag. Validates the tag is in the user's `hashtags_json`, clears `sources:{tag}` and `discovery_failures:{tag}` KV, inserts a `pending_discoveries` row.

| Content-type | Request | Success response |
|---|---|---|
| `application/json` | `{ "tag": "<tag>" }` | `200 { "ok": true }` |
| `application/x-www-form-urlencoded` | `tag=<tag>` | `303` → `/settings?rediscover=ok&tag=<tag>` |

**Error responses:** `400 bad_request` | `400 unknown_tag` | `401 unauthorized` | `403 forbidden_origin`

**Implements:** [REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover)

### POST /api/admin/discovery/retry-bulk (also GET)

Re-queues every stuck tag for the session user in one D1 batch. Backs the **Discover missing sources** button. A tag is stuck when its `sources:{tag}` entry has an explicitly empty `feeds` array; brand-new tags are not stuck (still discovering).

| Method | Caller | Success response |
|---|---|---|
| `POST` | Form submit | `303` → `/settings?rediscover=ok&count=<N>` |
| `GET` | Cloudflare Access post-auth callback (browser) | `303` → `/settings?rediscover=ok&count=<N>` |
| `GET` | Scripted (`Accept: application/json`) | `200 { ok: true, count: N }` |

**Error responses:** `401 unauthorized` | `403 forbidden_origin` | `500 internal_error`. GET path skips the Origin check (Cloudflare Access is the sole gate).

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

> Both `/api/dev/*` routes are gated by `DEV_BYPASS_TOKEN`. When the secret is unset the endpoint returns `404`. When set, the request must carry `Authorization: Bearer <DEV_BYPASS_TOKEN>` (timing-safe). Mismatch also returns `404` (no enumeration). Production leaves the secret unset.

### POST /api/dev/login

Mints a pre-baked session cookie for the synthetic e2e user (`__e2e__`) so test runs never mutate a real account. Set `DEV_BYPASS_USER_ID` to impersonate a different id (staging only).

**Response:** `204` with `Set-Cookie: oauth_session=…` | `401` (missing Bearer) | `404` (disabled or token mismatch).

**Used by:** `scripts/e2e-test.sh`, local Playwright runs.

### POST /api/dev/trigger-scrape

Kicks a real scrape without waiting for the cron. Inserts a `scrape_runs` row and sends `SCRAPE_COORDINATOR`.

**Response (success):** `202 { ok: true, scrape_run_id, status_url: "/api/scrape-status" }`

**Error responses:** `500 { ok: false, error: "start_run_failed" | "enqueue_failed" }`

Poll `GET /api/scrape-status` until `status='ready'`.

---

## Operator Tools

### POST /api/admin/force-refresh (also GET)

Kicks the global-feed coordinator on demand — identical to the every-4-hours cron. Inserts a `scrape_runs` row, sends `SCRAPE_COORDINATOR`. A 120-second reuse window absorbs double-clicks: a new request that finds a `running` row younger than 120 s reuses it.

POST enforces Origin; GET is exempt (so operators can bookmark or `curl`).

| Method | Caller | Success response |
|---|---|---|
| `POST` | `/settings` form submit | `303` → `/settings?force_refresh={ok\|reused}` |
| `GET` | Browser | `303` → `/settings?force_refresh={ok\|reused\|denied}` |
| `GET` | Scripted (`Accept: application/json`) | `200 { ok: true, scrape_run_id, reused }` |

**Error responses:** `401 unauthorized` | `403 forbidden` | `500 "Failed to dispatch coordinator"`.

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

**Response:** `{ days: [...] }` — up to 14 day-groups keyed by the user's local timezone, sorted `local_date DESC`. Empty days are omitted. Each day group has `local_date`, `article_count`, `articles[]` (filtered to the user's active tags), `ticks[]` (scrape runs in that day), and per-day token/cost/articles-ingested aggregates.

`?q=` and `?tags=` are page-level URL state read client-side; they are not server query params.

**Implements:** [REQ-HIST-001](../sdd/history.md#req-hist-001-day-grouped-article-history) AC 4, AC 5

### GET /api/stats

**Response:** `{ digests_generated: int, articles_read: int, articles_total: int, tokens_consumed: int, cost_usd: number }`

Global counters (`digests_generated`, `tokens_consumed`, `cost_usd`) come from `scrape_runs` — one scrape run is one shared event. Per-user counters (`articles_total`, `articles_read`) are scoped to the user's currently-active tag list, so the ratio always describes "of articles you can see now, how many have you read" ([REQ-HIST-002](../sdd/history.md#req-hist-002-user-stats-widget) AC 3).

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
| `auth.logout.sv_bump_failed` | D1 `session_version` increment in logout threw — session may remain valid; both cookies are still cleared on the response |
| `auth.account.delete` | User row deleted from D1 (info on success, warn when no row affected) |
| `auth.account.delete.failed` | D1 delete threw, or KV cleanup threw |
| `auth.set_tz.failed` | D1 update in `POST /api/auth/set-tz` threw |
| `digest.generation` | Digest generation completed (success or failure) |
| `source.fetch.failed` | An individual source could not be fetched during fan-out |
| `refresh.rejected` | Manual refresh rejected (rate-limited or already in progress) |
| `auth.refresh.rotated` | Refresh-token row successfully rotated (inline middleware or explicit `/api/auth/refresh`) |
| `auth.refresh.rotate_failed` | D1 batch in `rotateRefreshToken` threw |
| `auth.refresh.expired` | Refresh cookie presented but the row is past its 30-day TTL |
| `auth.refresh.fingerprint_drift` | Refresh cookie valid but UA or country changed since issuance — forensic metadata only, request is NOT rejected (see "Why fingerprint drift is logged but not enforced" below) |
| `auth.refresh.grace_fingerprint_mismatch` | Refresh row was rotated within the past 30 s grace window AND fingerprint mismatches — treated as theft; `revokeAllForUser` fires |
| `auth.refresh.concurrent_collision` | Refresh cookie's row is already revoked but within the 30 s grace window — served a fresh access JWT off the surviving child row without re-rotating |
| `auth.refresh.concurrent_lost_race` | Same as above; no surviving child row found — treated as reuse |
| `auth.refresh.reuse_detected` | Revoked refresh cookie presented outside the grace window — every refresh row for the user revoked + `session_version` bumped |
| `auth.refresh.purge_completed` | Daily purge of expired/old-revoked refresh-token rows completed |
| `auth.refresh.purge_failed` | Daily purge threw |
| `email.send.failed` | Resend API call failed |
| `email.dispatch.degraded` | Per-user D1 data-fetch failed during dispatch; user is treated as having zero headlines and the send is skipped (REQ-MAIL-001 AC 11) |
| `email.dispatch.skipped_empty` | Recipient has zero unread headlines for the local day; send is skipped and `last_emailed_local_date` is not stamped, so the user is naturally retried tomorrow at their digest time (REQ-MAIL-001 AC 11) |
| `email.dispatch.skipped_invalid_tz` | User row has an empty or unrecognised IANA timezone; row skipped, sibling buckets continue |
| `discovery.completed` | Per-tag LLM discovery run finished |
| `discovery.queued` | A new per-tag discovery job was inserted into `pending_discoveries` |
| `settings.update.failed` | D1 update in `PUT /api/settings` threw |
| `auth.refresh.rate_limited` | Inline middleware or the explicit refresh path hit a refresh rate-limit bucket — request rejected with 429. See [Refresh rate-limit fail mode](#refresh-rate-limit-fail-mode) below for the `bucket` field values. |
| `rate.limit.kv_error` | KV read/write in the rate-limit helper threw. The caller proceeds per the per-rule fail-mode; `decision` and `kv_op` field values are documented in [Refresh rate-limit fail mode](#refresh-rate-limit-fail-mode). |
| `article.star.failed` | D1 insert or delete in `POST/DELETE /api/articles/:id/star` threw |

Raw exception messages appear only in the `detail` field of error-level records; they are never stored in D1 and never returned to clients (see [REQ-OPS-002](../sdd/observability.md#req-ops-002-sanitized-error-surfaces)).

#### Refresh rate-limit fail mode

Refresh rate-limit logs (`auth.refresh.rate_limited`, `rate.limit.kv_error`) carry two extra fields:

| Field | Values | Meaning |
|---|---|---|
| `bucket` | `"ip"` | Pre-validation `auth_refresh_ip` rule (60/min). |
| `bucket` | `"user"` | Post-validation `auth_refresh_user` rule (30/min). |
| `decision` | `"fail_open"` | KV outage on a route that fails open (most routes). The request proceeds. |
| `decision` | `"fail_closed"` | KV outage on a refresh-token route. The request is rejected. |
| `kv_op` | `"get"` | The error happened on the counter-read path. |
| `kv_op` | `"put"` | The error happened on the counter-write path. |

#### Why fingerprint drift is logged but not enforced

A refresh-token row stores the user-agent and country at issuance. On every refresh, the present UA/country are compared with the stored values and a drift event is logged as forensic metadata. **The drift does not block the refresh.**

UA strings change on every browser auto-update; country changes when a user moves between Wi-Fi and mobile networks. Hard-gating refresh on either would lock users out routinely. Industry guidance (RFC 9700, OWASP, Auth0, Okta) is consistent: log drift for anomaly detection, do not enforce it on the steady-state path. Reuse-detection (a revoked-then-replayed cookie) remains the enforcement signal.

---

## Related Documentation

- [Architecture](architecture.md) — Component overview
- [Configuration](configuration.md) — Required env vars and secrets
