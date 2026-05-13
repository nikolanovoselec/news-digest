# API Reference

<!-- doc-allow-large: AD46 api-reference single-file design -->

All public and authenticated HTTP endpoints. Operator and admin endpoints live in [api-reference-admin.md](api-reference-admin.md).

**Audience:** Developers

## Contents

- [Conventions](#conventions)
- [Pages](#pages)
- [Authentication](#authentication)
- [Settings](#settings)
- [Digests](#digests)
- [Discovery](#discovery)
- [Stars](#stars)
- [Tags](#tags)
- [Developer Tools](#developer-tools)
- [Operator Tools](#operator-tools)
- [SEO and Crawler Policy](#seo-and-crawler-policy)
- [History and Stats](#history-and-stats)
- [Structured Log Events](#structured-log-events)
- [Related Documentation](#related-documentation)

## Conventions

The conventions below apply to every endpoint in this document. They are stated once here and not repeated per endpoint.

- **Error envelope.** Every error response carries the JSON body `{ "error": string, "code": string }`. Additional fields (`detail`, `retry_after`) appear when relevant.
- **Authentication.** The `Authentication` field on each endpoint uses one of the canonical values listed below.
  - `none` — public endpoint.
  - `session` — valid `__Host-session` cookie required.
  - `refresh cookie` — valid `__Host-refresh` cookie required; access JWT may be absent.
  - `state cookie` — OAuth `state` cookie required.
  - `session + admin email` — session cookie plus `ADMIN_EMAIL` match required.
  - `dev-bypass token` — Bearer `DEV_BYPASS_TOKEN` required.
- **Origin check.** The `Origin check` field uses `applies` (Origin header must match `APP_URL`, mismatch returns `403 forbidden_origin`), `exempt` (intentionally not checked, justified per endpoint), or `n/a` (non-mutating GET). See [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints).
- **Rate limit.** When present, the `Rate limit` field gives `{count}/{window} per {scope}` and a fail mode (`fail-open` or `fail-closed`). Exhausted buckets return `429` with a `Retry-After` header. See [REQ-AUTH-001 AC 9](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) and [`security.md`](security.md#rate-limiting-req-auth-001-ac-9) for the full matrix.
- **Implements.** Every endpoint cites the REQ that owns its contract.

---

## Pages

### GET / (Landing page)

Public landing page. Anonymous visitors see provider sign-in buttons; authenticated visitors are redirected to `/digest`.

```
GET /
```

**Authentication:** none
**Origin check:** n/a

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Anonymous | Landing page HTML |
| `303` | Authenticated | Redirect to `/digest` |

**Implements:** [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider)

---

### GET /404 (Not-found page)

Catch-all not-found page. Carries `noindex=true` to keep stale URLs out of search indexes.

```
GET /404
```

**Authentication:** none
**Origin check:** n/a

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Always | Static error page (`noindex`) |

**Implements:** [REQ-READ-006 AC 5](../sdd/reading.md#req-read-006-empty-error-and-offline-pages)

---

### GET /500 (Server-error page)

Generic server-error fallback. Shown when an uncaught exception bubbles to Astro's error handler. Carries `noindex=true`.

```
GET /500
```

**Authentication:** none
**Origin check:** n/a

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Always | Static error page (`noindex`) |

**Implements:** [REQ-READ-006 AC 5](../sdd/reading.md#req-read-006-empty-error-and-offline-pages)

---

## Authentication

### POST /api/auth/{provider}/login (Start OAuth flow)

Initiates the OAuth 2.0 / OIDC authorization-code flow. Sets a 10-minute `state` cookie and redirects to the provider's authorize URL. `{provider}` must match the configured registry (`github`, `google`); unknown names return `404`. Both `POST` (preferred, blocks prefetch races) and `GET` (browser fallback) are accepted.

```
POST /api/auth/{provider}/login
GET  /api/auth/{provider}/login
```

**Authentication:** none
**Origin check:** exempt (entry point only sets a state cookie and redirects; consent happens at the provider)

**Path parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `provider` | string | yes | One of: `github`, `google` |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `302` | Success | Redirect to provider authorize URL |
| `404` | Unknown provider | `{ error, code: "not_found" }` |
| `429` | Rate limited | `{ error, code: "rate_limit_exceeded" }` |

**Rate limit:** 10/60s per IP (`auth_login`), fail-closed. See [AD23](decisions/README.md#ad23-auth-rate-limit-fail-closed-without-waf-backstop).

**Implements:** [REQ-AUTH-001 AC 9](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider), [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

---

### GET /api/auth/{provider}/callback (OAuth callback)

Validates the per-provider `state` cookie, exchanges the code for tokens, and resolves the session via the three-path `auth_links` lookup ([REQ-AUTH-007](../sdd/authentication.md#req-auth-007-cross-provider-account-dedup)). New accounts get default hashtags, `digest_hour=8`, and `email_enabled=1`. On success, both session cookies are set and the user is redirected to `/digest`.

```
GET /api/auth/{provider}/callback
```

**Authentication:** state cookie (validates `state` query param against the cookie set by `/login`)
**Origin check:** n/a (CSRF defense is the `state` cookie)

**Query parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `code` | string | yes | Authorization code from provider |
| `state` | string | yes | Must match the `state` cookie |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `302` | Success | Redirect to `/digest` with session cookies set |
| `302` | Provider error | Redirect to `/?error={code}&provider={name}` |
| `403` | Invalid state | HTML body with `<meta http-equiv="refresh">` to `/?error=invalid_state` |
| `429` | Rate limited | `{ error, code: "rate_limit_exceeded" }` |

**Error codes:** `access_denied`, `no_verified_email`, `oauth_error` (3xx redirects), `invalid_state` (403).

**Rate limit:** 20/60s per IP (`auth_callback`), fail-closed.

**Implements:** [REQ-AUTH-001 AC 9](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider), [REQ-AUTH-004](../sdd/authentication.md#req-auth-004-oauth-error-surfacing), [REQ-AUTH-007](../sdd/authentication.md#req-auth-007-cross-provider-account-dedup)

**Notes**

Account resolution follows three paths: (A) existing `(provider, provider_sub)` pair in `auth_links` reuses the linked `user_id`; (B) no link but a `users` row with the same verified email exists, so a new `auth_links` alias is inserted; (C) neither matches, so a new `users` row plus first `auth_links` row are created.

---

### POST /api/auth/refresh (Force token rotation)

Force-rotates the refresh-token row and mints a new access JWT. Used by long-running tabs before issuing a state-changing XHR that middleware cannot safely auto-refresh on the same call.

```
POST /api/auth/refresh
```

**Authentication:** refresh cookie (access JWT need not be valid)
**Origin check:** applies

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Fresh rotation | New access JWT + rotated refresh cookie |
| `200` | Concurrent-rotation collision (within 30s grace) | New access JWT only |
| `401` | Missing/invalid/expired cookie, or reuse detected | `{ error, code: "unauthorized" }`, both cookies cleared |
| `403` | Origin mismatch | `{ error, code: "forbidden_origin" }` |
| `429` | Rate limited | `{ error, code: "rate_limit_exceeded" }` |

**Rate limit:** Two tiers (both fail-closed). Per-IP `auth_refresh_ip` 60/60s (pre-validation); per-user `auth_refresh_user` 30/60s (post-validation). Buckets shared with the inline middleware refresh path.

**Implements:** [REQ-AUTH-002 AC 5](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation), [REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection)

**Notes**

The 30-second concurrent-rotation grace window covers the case where two parallel requests from the same client both raced to refresh. The loser presenting the now-revoked cookie within the grace window receives a fresh access JWT off the surviving rotated row without re-rotating ([REQ-AUTH-008 AC 4](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection)).

---

### POST /api/auth/logout (End session)

Bumps `session_version` (invalidates every outstanding access JWT for the user), revokes the active refresh-token row, clears both cookies, redirects to `/?logged_out=1`.

```
POST /api/auth/logout
```

**Authentication:** session
**Origin check:** applies

**Response**

| Status | Outcome | Body |
|---|---|---|
| `303` | Success | Redirect to `/?logged_out=1`, both cookies cleared |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `403` | Origin mismatch | `{ error, code: "forbidden_origin" }` |
| `429` | Rate limited | `{ error, code: "rate_limit_exceeded" }` |

**Rate limit:** 5/60s per IP (`auth_logout`).

**Implements:** [REQ-AUTH-002 AC 3](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation), [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints), [REQ-AUTH-008 AC 3](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection)

**Notes**

Single-device logout only: this revokes the active refresh-token row, not every refresh row for the user. Other devices stay signed in.

---

### POST /api/auth/set-tz (Update timezone)

Persists the user's IANA timezone. Validated via `Intl.supportedValuesOf('timeZone')`. Triggers a session-cookie refresh in the same response when the session is near expiry.

```
POST /api/auth/set-tz
```

**Authentication:** session
**Origin check:** applies

**Request body** (JSON)

| Field | Type | Required | Description |
|---|---|---|---|
| `tz` | string | yes | IANA timezone (e.g. `Europe/Zurich`) |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | `{ ok: true, tz: string }` |
| `400` | Invalid timezone | `{ error, code: "invalid_tz" }` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `403` | Origin mismatch | `{ error, code: "forbidden_origin" }` |
| `429` | Rate limited | `{ error, code: "rate_limit_exceeded" }` |

**Rate limit:** 30/60s per user (`set_tz`), fail-open. Sized to cover travel/DST edge cases and dev/test loops.

**Implements:** [REQ-SET-007](../sdd/settings.md#req-set-007-timezone-change-detection), [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

---

### DELETE /api/auth/account (Delete account, JSON path)

Deletes the user and every row owned by the user via FK cascade. Both cookies cleared, KV entries under `user:{id}:*` deleted best-effort. Confirmation string required to prevent accidental deletion.

```
DELETE /api/auth/account
```

**Authentication:** session
**Origin check:** applies

**Request body** (JSON)

| Field | Type | Required | Description |
|---|---|---|---|
| `confirm` | string | yes | Must equal `"DELETE"` |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | `{ ok: true, redirect: "/?account_deleted=1" }`, both cookies cleared |
| `400` | Missing/unparseable body | `{ error, code: "bad_request" }` |
| `400` | Wrong `confirm` value | `{ error, code: "confirmation_required" }` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `403` | Origin mismatch | `{ error, code: "forbidden_origin" }` |

**Implements:** [REQ-AUTH-005](../sdd/authentication.md#req-auth-005-account-deletion), [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

---

### POST /api/auth/account (Delete account, form path)

Native form-encoded transport for the same deletion. Used by browsers that do not reliably fire JS-issued `DELETE` requests (Samsung Browser, some in-app webviews). Same auth, Origin, and confirmation contract as the DELETE path.

```
POST /api/auth/account
```

**Authentication:** session
**Origin check:** applies

**Request body** (form-encoded)

| Field | Type | Required | Description |
|---|---|---|---|
| `confirm` | string | yes | Must equal `"DELETE"` |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `303` | Success | Redirect to `/?account_deleted=1`, both cookies cleared |
| `400` | Empty body or `Content-Length: 0` | `{ error, code: "bad_request" }` |
| `400` | Wrong `confirm` value | `{ error, code: "confirmation_required" }` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `403` | Origin mismatch | `{ error, code: "forbidden_origin" }` |

**Implements:** [REQ-AUTH-005](../sdd/authentication.md#req-auth-005-account-deletion), [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

---

## Settings

### GET /api/settings (Read user settings)

Returns the authenticated user's settings.

```
GET /api/settings
```

**Authentication:** session
**Origin check:** n/a

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | `{ hashtags: string[], digest_hour, digest_minute, tz, model_id, email_enabled, first_run }` |
| `401` | No session | `{ error, code: "unauthorized" }` |

**Implements:** [REQ-SET-001](../sdd/settings.md#req-set-001-unified-first-run-and-edit-flow)

---

### PUT /api/settings (Update settings, JSON path)

Updates the authenticated user's settings. Returns the list of newly-added tags that will trigger background discovery on the next cron.

```
PUT /api/settings
```

**Authentication:** session
**Origin check:** applies

**Request body** (JSON)

| Field | Type | Required | Description |
|---|---|---|---|
| `hashtags` | string[] | yes | Active tag list |
| `digest_hour` | int | yes | 0-23 |
| `digest_minute` | int | yes | 0, 5, 10, ..., 55 |
| `model_id` | string | yes | Validated against `MODELS` |
| `email_enabled` | bool | yes | Daily email opt-in |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | `{ ok: true, discovering: string[] }` |
| `400` | Validation failure | `{ error, code: <see error codes> }` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `403` | Origin mismatch | `{ error, code: "forbidden_origin" }` |

**Error codes:** `invalid_hashtags`, `invalid_time`, `invalid_model_id`, `invalid_email_enabled`.

**Implements:** [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation-strip-ux), [REQ-SET-003](../sdd/settings.md#req-set-003-scheduled-digest-time-with-timezone), [REQ-SET-004](../sdd/settings.md#req-set-004-model-selection), [REQ-SET-005](../sdd/settings.md#req-set-005-email-notification-preference)

**Notes**

REQ-SET-004 is `Partial`: the model-selection UI is hidden, but the API still validates and persists `model_id`.

---

### POST /api/settings (Update settings, form path)

Native form-encoded fallback for the same update. Used when the JS fetch handler does not bind.

```
POST /api/settings
```

**Authentication:** session
**Origin check:** applies

**Request body** (form-encoded)

| Field | Type | Required | Description |
|---|---|---|---|
| `hour` | string (`"00"`-`"23"`) | no | Takes precedence over `time` |
| `minute` | string (`"00"`, `"05"`, ..., `"55"`) | no | Takes precedence over `time` |
| `time` | string (`HH:MM`) | no | Legacy single-field fallback when `hour`/`minute` absent |
| `tz` | string | yes | IANA timezone |
| `model_id` | string | yes | Validated against `MODELS` |
| `email_enabled` | string (`"on"`) | no | Present when checked, absent when unchecked |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `303` | Success | Redirect to `/settings?saved=ok` |
| `303` | Validation failure | Redirect to `/settings?error=<code>` |

**Error codes (redirected):** `invalid_hashtags`, `invalid_time`, `invalid_email_enabled`.

**Implements:** [REQ-SET-001](../sdd/settings.md#req-set-001-unified-first-run-and-edit-flow), [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation-strip-ux), [REQ-SET-003](../sdd/settings.md#req-set-003-scheduled-digest-time-with-timezone), [REQ-SET-005](../sdd/settings.md#req-set-005-email-notification-preference)

---

### GET /api/discovery/status (Poll pending tag discovery)

Returns the set of hashtags the authenticated user has queued for background source discovery. The settings page polls this after a save to display "Still discovering sources for #foo" inline.

```
GET /api/discovery/status
```

**Authentication:** session
**Origin check:** n/a

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | `{ pending: string[] }` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `429` | Rate limited | `{ error, code: "rate_limit_exceeded" }` |

**Rate limit:** 120/60s per user (`discovery_status`), fail-open. Sized for a 2-second polling cadence with overhead.

**Implements:** [REQ-DISC-002](../sdd/discovery.md#req-disc-002-discovery-progress-visibility), [REQ-SET-006](../sdd/settings.md#req-set-006-settings-incomplete-gate)

---

## Digests

### GET /api/digest/today (Today's digest)

Up to 29 articles from the article pool filtered by the user's active hashtags. Ordered by `ingested_at DESC, published_at DESC`.

```
GET /api/digest/today
```

**Authentication:** session
**Origin check:** n/a

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | See response shape below |
| `401` | No session | `{ error, code: "unauthorized" }` |

**Response shape**

```json
{
  "articles": [{
    "id": "string", "title": "string", "details": ["string"],
    "primary_source_name": "string", "primary_source_url": "string",
    "published_at": "ISO-8601", "tags": ["string"],
    "alt_source_count": 0, "starred": false, "read": false
  }],
  "last_scrape_run": { "id": "string", "started_at": 0, "finished_at": 0, "status": "ready" },
  "next_scrape_at": 1234567890,
  "scrape_running": false
}
```

**Implements:** [REQ-READ-001 AC 5, AC 7](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-PIPE-006](../sdd/generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress)

**Notes**

`last_scrape_run` and `next_scrape_at` may be `null` before the first cron tick. `next_scrape_at` is derived from the cron schedule (next UTC quadrant-hour boundary `HH:00` where `HH ∈ {0,4,8,12,16,20}`), not from the last run's start time, so a delayed run does not push the next tick out.

`scrape_running` is the SSR first-paint indicator for the "Update in progress" banner. It is `true` only when the **most-recent** `scrape_runs` row has `status = 'running'` — the same predicate used by `GET /api/scrape-status`. A stuck older `running` row that coexists with a newer `ready` row does not trigger the banner.

The `alt_source_count` field drives the `+N` suffix on source labels across all card grids.

---

### GET /api/digest/:id (Tombstoned)

**Status:** Tombstoned (returns `410 Gone`; removed when the `digests` table was dropped in migration 0003).
**Replacement:** Per-user digests no longer exist; see [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) for the global pipeline.

---

### POST /api/digest/refresh (Tombstoned)

**Status:** Tombstoned (returns `410 Gone`; replaced by the every-4-hours global scrape pipeline).
**Replacement:** Operators that want to force a refresh use `POST /api/admin/force-refresh` (see [REQ-OPS-005](../sdd/observability.md#req-ops-005-admin-force-refresh-endpoint)) instead.

---

### GET /api/scrape-status (Poll active scrape progress)

Returns whether a scrape is in progress and, if so, its chunk progress. Polled by `/digest` (countdown swap) and `/settings` Administration section (5s poll for live progress; also consumed by the pipeline orchestrator to gate phase transitions).

```
GET /api/scrape-status
```

**Authentication:** session
**Origin check:** n/a

**Query parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `run_id` | string (ULID) | no | Pin to a specific run; absent returns most-recent |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Idle | `{ "running": false }` |
| `200` | In progress | See response shape below |
| `401` | No session | `{ error, code: "unauthorized" }` |

**Response shape (in progress)**

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

**Implements:** [REQ-PIPE-006](../sdd/generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress), [REQ-AUTH-002 AC 4](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation), [REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection)

**Notes**

`chunks_remaining` and `chunks_total` are `null` when the coordinator has not yet written the chunk count to KV. `articles_ingested` defaults to `0`. The KV counter is a display mirror; the authoritative completion gate is in D1 (`scrape_chunk_completions`).

The "running" predicate consults the most-recent `scrape_runs` row, matching the SSR `scrape_running` field in `GET /api/digest/today`. A stuck older row never causes the two sources to disagree (regression fixed in PR #220, 2026-05-07).

Both responses carry a `Set-Cookie` refresh when the session is within 5 minutes of expiry, so polling during a long scrape never expires the session.

---

## Discovery

### POST /api/admin/discovery/retry (Re-queue one tag)

Re-queues a single stuck tag for source discovery. Validates the tag is in the user's `hashtags_json`, clears `sources:{tag}` and `discovery_failures:{tag}` KV, inserts a `pending_discoveries` row.

```
POST /api/admin/discovery/retry
```

**Authentication:** session + admin email
**Origin check:** applies

**Request body** (JSON or form-encoded)

| Field | Type | Required | Description |
|---|---|---|---|
| `tag` | string | yes | Tag to re-queue |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | JSON path success | `{ ok: true }` |
| `303` | Form path success | Redirect to `/settings?rediscover=ok&tag=<tag>` |
| `400` | Missing tag | `{ error, code: "bad_request" }` |
| `400` | Tag not in user's hashtags | `{ error, code: "unknown_tag" }` |
| `401` | No session or non-admin | `{ error, code: "unauthorized" }` |
| `403` | Origin mismatch | `{ error, code: "forbidden_origin" }` |

**Implements:** [REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover)

---

### POST /api/admin/discovery/retry-bulk (Re-queue all stuck tags)

Re-queues every stuck tag for the session user in one D1 batch. Backs the **Discover missing sources** button. A tag is stuck when its `sources:{tag}` entry has an explicitly empty `feeds` array; brand-new tags are not stuck (still discovering). Both POST (preferred) and GET (browser navigation via Cloudflare Access post-auth) are accepted; the GET path skips the Origin check because Cloudflare Access is the sole gate.

```
POST /api/admin/discovery/retry-bulk
GET  /api/admin/discovery/retry-bulk
```

**Authentication:** session + admin email (POST), Cloudflare Access (GET browser path)
**Origin check:** applies on POST; exempt on GET (Access is the gate)

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Scripted success (`Accept: application/json`) | `{ ok: true, count: N }` |
| `303` | Browser success (form submit or Access redirect) | Redirect to `/settings?rediscover=ok&count=<N>` |
| `401` | No session or non-admin | `{ error, code: "unauthorized" }` |
| `403` | Origin mismatch (POST) | `{ error, code: "forbidden_origin" }` |
| `500` | D1 error | `{ error, code: "internal_error" }` |

**Implements:** [REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover)

---

## Stars

### POST /api/articles/:id/star (Star article)

Stars an article for the authenticated user. Optimistic on the client (UI flips before response).

```
POST /api/articles/:id/star
```

**Authentication:** session
**Origin check:** applies

**Path parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Article id |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | `{ ok: true, starred: true }` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `403` | Origin mismatch | `{ error, code: "forbidden_origin" }` |
| `404` | Article not found | `{ error, code: "not_found" }` |
| `429` | Rate limited | `{ error, code: "rate_limit_exceeded" }` |

**Rate limit:** 60/60s per user (`article_star`), fail-open.

**Implements:** [REQ-STAR-001](../sdd/reading.md#req-star-001-star-and-unstar-articles)

---

### DELETE /api/articles/:id/star (Unstar article)

Unstars an article. Same auth, Origin, and rate-limit contract as POST.

```
DELETE /api/articles/:id/star
```

**Authentication:** session
**Origin check:** applies

**Path parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Article id |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | `{ ok: true, starred: false }` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `403` | Origin mismatch | `{ error, code: "forbidden_origin" }` |
| `404` | Article not found | `{ error, code: "not_found" }` |
| `429` | Rate limited | `{ error, code: "rate_limit_exceeded" }` |

**Rate limit:** 60/60s per user (`article_star`), fail-open. Shared bucket with POST.

**Implements:** [REQ-STAR-001](../sdd/reading.md#req-star-001-star-and-unstar-articles)

---

### GET /api/starred (List starred articles)

Returns the session user's starred articles, newest star first. Limit 60. Article shape matches `/api/digest/today`.

```
GET /api/starred
```

**Authentication:** session
**Origin check:** n/a

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | `{ articles: WireArticle[] }` (max 60, newest star first) |
| `401` | No session | `{ error, code: "unauthorized" }` |

**Implements:** [REQ-STAR-002](../sdd/reading.md#req-star-002-starred-articles-page)

---

## Tags

### PUT /api/tags (Add or remove one tag)

Add or remove a single hashtag from the user's tag list. Persists immediately. Normalises to lowercase, strips `#`, rejects characters outside `[a-z0-9-]`, enforces 2-32 char length and max 25 tags.

```
PUT /api/tags
```

**Authentication:** session
**Origin check:** applies

**Request body** (JSON)

| Field | Type | Required | Description |
|---|---|---|---|
| `tag` | string | yes | Tag to add or remove (normalised server-side) |
| `action` | string | yes | `"add"` or `"remove"` |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | `{ ok: true, hashtags: string[] }` |
| `400` | Tag fails validation | `{ error, code: "invalid_tag" }` |
| `400` | Already at 25 tags | `{ error, code: "max_tags_reached" }` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `429` | Rate limited | `{ error, code: "rate_limit_exceeded" }` |

**Rate limit:** 30/60s per user (`tags_mutation`), fail-open. Shared bucket with `POST /api/tags/restore`.

**Implements:** [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation-strip-ux)

---

### POST /api/tags/restore (Restore default tags)

Replaces the user's hashtag list with the curated default seed from `DEFAULT_HASHTAGS`.

```
POST /api/tags/restore
```

**Authentication:** session
**Origin check:** applies

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | `{ ok: true, hashtags: string[] }` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `429` | Rate limited | `{ error, code: "rate_limit_exceeded" }` |

**Rate limit:** 30/60s per user (`tags_mutation`), fail-open. Shared bucket with `PUT /api/tags`.

**Implements:** [REQ-SET-008 AC 4](../sdd/settings.md#req-set-008-hashtag-persistence-validation-and-defaults)

---

### POST /api/tags/delete-initial (Dismiss new-user seed prompt)

Clears the new-user "would you like our suggested tags?" seed prompt by writing an empty `hashtags_json = '[]'` for the caller. The settings page checks `hashtags_json IS NULL` to decide whether to show the seed prompt; setting it to a JSON empty array dismisses the prompt without committing the user to any tags.

```
POST /api/tags/delete-initial
```

**Authentication:** session
**Origin check:** applies

**Response**

| Status | Outcome | Body |
|---|---|---|
| `303` | Success | Redirect to `/digest` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `403` | Origin mismatch | `{ error, code: "origin_mismatch" }` |
| `429` | Rate limited | `{ error, code: "rate_limit_exceeded" }` |
| `500` | D1 error | `{ ok: false, error: "db_failed" }` |

**Rate limit:** 30/60s per user (`tags_mutation`), fail-open.

**Implements:** [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation-strip-ux)

---

## Developer Tools

Both `/api/dev/*` routes are test-only authentication paths for integration deployments. They are gated by `DEV_BYPASS_TOKEN` (timing-safe comparison). When the secret is unset OR the request token mismatches, both routes return `404` (no enumeration). Production deployments leave the secret unset; routes also return `404` when `IS_PRODUCTION = "true"` regardless of token state. See [`security.md`](security.md#dev-bypass-prod-guard-req-auth-001-ac-10).

### POST /api/dev/login (Mint synthetic session)

Mints a pre-baked session cookie for the synthetic e2e user (`__e2e__`) so test runs never mutate a real account. Set `DEV_BYPASS_USER_ID` to impersonate a different id (staging only).

```
POST /api/dev/login
```

**Authentication:** dev-bypass token (`Authorization: Bearer <DEV_BYPASS_TOKEN>`)
**Origin check:** exempt

**Response**

| Status | Outcome | Body |
|---|---|---|
| `204` | Success | Empty, `Set-Cookie: oauth_session=...` |
| `401` | Missing Bearer header | `{ error, code: "unauthorized" }` |
| `404` | Token unset, token mismatch, or `IS_PRODUCTION=true` | Empty |

**Implements:** [REQ-AUTH-001 AC 10](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider)

**Notes**

Used by `scripts/e2e-test.sh` and local Playwright runs.

---

### POST /api/dev/trigger-scrape (Force scrape pipeline)

Kicks a real scrape without waiting for the cron. Inserts a `scrape_runs` row and dispatches to the `SCRAPE_COORDINATOR` queue.

```
POST /api/dev/trigger-scrape
```

**Authentication:** dev-bypass token (`Authorization: Bearer <DEV_BYPASS_TOKEN>`)
**Origin check:** exempt

**Response**

| Status | Outcome | Body |
|---|---|---|
| `202` | Accepted | `{ ok: true, scrape_run_id, status_url: "/api/scrape-status" }` |
| `404` | Token unset, token mismatch, or `IS_PRODUCTION=true` | Empty |
| `500` | Run insert or enqueue failed | `{ ok: false, error: "start_run_failed" \| "enqueue_failed" }` |

**Implements:** [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-AUTH-001 AC 10](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider)

**Notes**

Poll `GET /api/scrape-status` until `status='ready'`.

---

## Operator Tools

Admin endpoints (force-refresh, embed-backfill, historical-dedup, dedup-status, pipeline-run POST/GET, pipeline-status, dedup-diag) live in [api-reference-admin.md](api-reference-admin.md). Backlinks to REQ-OPS-005/008, REQ-PIPE-001/003/009, and REQ-AUTH-001 AC 8a/8d/9/9g/10 are documented there.

---

## SEO and Crawler Policy

### GET /sitemap.xml (XML sitemap)

Dynamic XML sitemap. Lists only the public landing page (`/`). Referenced from `robots.txt`.

```
GET /sitemap.xml
```

**Authentication:** none
**Origin check:** n/a

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | XML sitemap (`Cache-Control: public, max-age=3600`) |

**Implements:** [REQ-OPS-004 AC 4](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability), [REQ-OPS-007](../sdd/observability.md#req-ops-007-public-sitemap-for-crawler-discovery)

**Notes**

`changefreq=daily`, `priority=1.0`, `lastmod` set to the current date at request time.

---

### GET /robots.txt (Crawler policy)

Static file served from `public/robots.txt`. Allows crawlers on the landing page and public assets; disallows `/api/`, `/digest`, `/starred`, `/history`, `/settings`. Blocks known AI training user agents (GPTBot, anthropic-ai, ClaudeBot, Google-Extended, CCBot, PerplexityBot) with a blanket `Disallow: /`.

```
GET /robots.txt
```

**Authentication:** none
**Origin check:** n/a

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | Plain text robots policy |

**Implements:** [REQ-OPS-004 AC 2](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability)

---

### GET /llms.txt (Agents policy, short)

Static machine-readable agents policy. Describes the product, what is public, that every surface beyond the landing page requires a federated OAuth session, and an explicit request not to train on content behind the login.

```
GET /llms.txt
```

**Authentication:** none
**Origin check:** n/a

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | Plain text agents policy |

**Implements:** [REQ-OPS-004 AC 3](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability)

---

### GET /llms-full.txt (Agents policy, extended)

Extended machine-readable agents policy. Superset of `llms.txt` — adds technology stack detail, storage layer, and GDPR basis for withholding per-user content.

```
GET /llms-full.txt
```

**Authentication:** none
**Origin check:** n/a

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | Plain text extended agents policy |

**Implements:** [REQ-OPS-004 AC 3](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability)

---

## History and Stats

### GET /api/history (Day-grouped article history)

Up to 14 day-groups keyed by the user's local timezone, sorted `local_date DESC`. Empty days are omitted.

```
GET /api/history
```

**Authentication:** session
**Origin check:** n/a

**Query parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `date` | string (`YYYY-MM-DD`) | no | Filter to a single local day (used for the "see today" deep-link) |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | See response shape below |
| `401` | No session | `{ error, code: "unauthorized" }` |

**Response shape**

```json
{
  "days": [{
    "local_date": "YYYY-MM-DD",
    "article_count": 0,
    "articles": [{ "id": "string", "title": "string", "starred": false, "alt_source_count": 0 }],
    "ticks": [{ "id": "string", "started_at": 0 }],
    "tokens_consumed": 0,
    "cost_usd": 0,
    "articles_ingested": 0
  }]
}
```

**Implements:** [REQ-HIST-003 AC 1, AC 2](../sdd/history.md#req-hist-003-search-tag-filter-and-deep-link-on-history), [REQ-STAR-001 AC 6](../sdd/reading.md#req-star-001-star-and-unstar-articles), [REQ-READ-001 AC 7](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest)

**Notes**

Each article includes `starred` (true when a row exists in `article_stars` for `(user_id, article_id)`) so `/history` renders the star glyph server-side without a separate fetch.

`alt_source_count` is `COUNT(*) FROM article_sources WHERE source_url != primary_source_url`. Values `> 0` drive the `+N` suffix on the DigestCard source label.

`?q=` and `?tags=` are page-level URL state read client-side and are not server query params.

---

### GET /api/stats (User stats widget)

Global counters (`digests_generated`, `tokens_consumed`, `cost_usd`) come from `scrape_runs`; per-user counters (`articles_total`, `articles_read`) are scoped to the user's currently-active tag list.

```
GET /api/stats
```

**Authentication:** session
**Origin check:** n/a

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Success | `{ digests_generated, articles_read, articles_total, tokens_consumed, cost_usd }` |
| `401` | No session | `{ error, code: "unauthorized" }` |

**Implements:** [REQ-HIST-002](../sdd/history.md#req-hist-002-user-stats-widget)

**Notes**

The ratio `articles_read / articles_total` always describes "of articles you can see now, how many have you read" because per-user counters scope to the active tag list ([REQ-HIST-002 AC 3](../sdd/history.md#req-hist-002-user-stats-widget)).

---

## Structured Log Events

This is not an HTTP endpoint. It documents the JSON log shape emitted to Cloudflare Logs via `console.log`. Every log line is `JSON.stringify`'d so Cloudflare Logs parses it as a structured record.

**Implements:** [REQ-OPS-001](../sdd/observability.md#req-ops-001-structured-json-logging)

### Envelope

Every event carries the following fields:

| Field | Type | Description |
|---|---|---|
| `ts` | number | Unix milliseconds (`Date.now()`) |
| `level` | string (`"info"` \| `"warn"` \| `"error"`) | Severity |
| `event` | string (closed enum) | Event name; see table below |

### Event enum

The `LogEvent` enum is defined in `src/lib/log.ts`. Each event has fixed semantics and may carry additional event-specific fields (see source).

| Event | When emitted |
|---|---|
| `auth.login` | Successful OAuth callback — user created or re-authenticated |
| `auth.callback.failed` | OAuth callback failed (token exchange, user fetch, or DB) |
| `auth.callback.invalid_state` | CSRF state mismatch in the OAuth callback (returns 403) |
| `auth.logout` | Session version bumped; cookies cleared; active refresh row revoked |
| `auth.logout.refresh_revoke_failed` | D1 revoke call in logout threw; session_version still bumped |
| `auth.logout.sv_bump_failed` | D1 session_version increment in logout threw |
| `auth.account.delete` | User row deleted from D1 |
| `auth.account.delete.failed` | D1 delete threw, or KV cleanup threw |
| `auth.set_tz.failed` | D1 update in `POST /api/auth/set-tz` threw |
| `digest.generation` | Digest generation completed (success or failure) |
| `source.fetch.failed` | An individual source could not be fetched during fan-out |
| `refresh.rejected` | Manual refresh rejected (rate-limited or already in progress) |
| `auth.refresh.rotated` | Refresh-token row rotated (middleware or explicit endpoint) |
| `auth.refresh.rotate_failed` | D1 batch in `rotateRefreshToken` threw |
| `auth.refresh.expired` | Refresh cookie presented but the row is past its 30-day TTL |
| `auth.refresh.fingerprint_drift` | UA or country changed; logged but not enforced (see below) |
| `auth.refresh.grace_fingerprint_mismatch` | Fingerprint mismatch inside 30s grace; treated as theft |
| `auth.refresh.concurrent_collision` | Revoked cookie inside grace window; served fresh JWT off surviving row |
| `auth.refresh.concurrent_lost_race` | Same as above; no surviving row found; treated as reuse |
| `auth.refresh.reuse_detected` | Revoked cookie outside grace window; all refresh rows revoked, session_version bumped |
| `auth.refresh.purge_completed` | Daily purge of expired/old-revoked refresh-token rows completed |
| `auth.refresh.purge_failed` | Daily purge threw |
| `email.send.failed` | Resend API call failed |
| `email.dispatch.degraded` | Per-user D1 data-fetch failed; user treated as having zero headlines |
| `email.dispatch.skipped_empty` | Zero unread headlines for the local day; send skipped |
| `email.dispatch.skipped_invalid_tz` | User row has empty or unrecognised IANA timezone |
| `discovery.completed` | Per-tag LLM discovery run finished |
| `discovery.queued` | New per-tag discovery job inserted into `pending_discoveries` |
| `settings.update.failed` | D1 update in `PUT /api/settings` threw |
| `auth.refresh.rate_limited` | Refresh rate-limit bucket hit; request rejected with 429 |
| `rate.limit.kv_error` | KV read/write in the rate-limit helper threw |
| `article.star.failed` | D1 insert or delete in `POST/DELETE /api/articles/:id/star` threw |

Raw exception messages appear only in the `detail` field of error-level records; they are never stored in D1 and never returned to clients (see [REQ-OPS-002](../sdd/observability.md#req-ops-002-sanitized-error-surfaces)).

### Rate limiter atomicity

The KV-backed rate limiter does a non-atomic `get`-then-`put`. Concurrent requests racing within the same window can each read N, decide `N < limit`, and write `N+1`, allowing up to roughly `concurrency × limit` through under contention (bounded by KV's propagation delay, typically < 60s globally). For most routes this is acceptable defence-in-depth.

For `failClosed: true` rules (`AUTH_REFRESH_IP`, `AUTH_REFRESH_USER`) protecting refresh-token spray attacks distributed across concurrent requests, the in-Worker limiter is best treated as defence-in-depth rather than the primary gate. Cloudflare zone-level Rate Limiting (WAF) is atomic and should be configured in front of `/api/auth/refresh` for production deployments. Without it, a coordinated burst above ~2× the configured limit can succeed during the propagation window (CF-034).

### Refresh rate-limit fail mode

Refresh rate-limit logs (`auth.refresh.rate_limited`, `rate.limit.kv_error`) carry two extra fields:

| Field | Values | Meaning |
|---|---|---|
| `bucket` | `"ip"` | Pre-validation `auth_refresh_ip` rule (60/min) |
| `bucket` | `"user"` | Post-validation `auth_refresh_user` rule (30/min) |
| `decision` | `"fail_open"` | KV outage on a route that fails open (most routes) |
| `decision` | `"fail_closed"` | KV outage on a refresh-token route (rejected) |
| `kv_op` | `"get"` | Error on the counter-read path |
| `kv_op` | `"put"` | Error on the counter-write path |

### Why fingerprint drift is logged but not enforced

A refresh-token row stores the user-agent and country at issuance. On every refresh, the present UA/country are compared and a drift event is logged as forensic metadata. **The drift does not block the refresh.**

UA strings change on every browser auto-update; country changes when a user moves between Wi-Fi and mobile networks. Hard-gating refresh on either would lock users out routinely. Industry guidance (RFC 9700, OWASP, Auth0, Okta) is consistent: log drift for anomaly detection, do not enforce it on the steady-state path. Reuse-detection (a revoked-then-replayed cookie) remains the enforcement signal.

---

## Related Documentation

- [api-reference-admin.md](api-reference-admin.md) — Admin and operator endpoints
- [architecture.md](architecture.md) — Component map
- [configuration.md](configuration.md) — Env vars, secrets, KV namespace bindings
- [security.md](security.md) — Rate-limit matrix, admin auth layers, threat model
- [`../sdd/`](../sdd/) — REQ-AUTH-*, REQ-OPS-*, REQ-SET-*, REQ-READ-*, REQ-PIPE-*, REQ-HIST-*, REQ-STAR-*, REQ-DISC-*
