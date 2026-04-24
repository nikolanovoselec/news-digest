# API Reference

All public and internal API endpoints.

**Audience:** Developers

Every mutating endpoint requires a valid session cookie and an `Origin` header matching the app's canonical origin (see [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)). All JSON responses use the shape `{ error: string, code: string, ...extras }` for errors.

---

## Pages

### GET /

Returns the landing page.

- **Anonymous:** `200` — renders the landing page with a "Sign in with GitHub" button.
- **Authenticated:** `303` → `/digest` — redirects authenticated users directly to their digest.

**Implements:** [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-github)

### GET /404

Catch-all not-found page. Rendered by Astro for any URL that no route file claims. Carries `noindex=true` so stale bookmarks and mistyped URLs do not contaminate search engine indexes. Presents a calm headline ("Page not found") and a "Back to home" link.

**Implements:** [REQ-READ-006](../sdd/reading.md#req-read-006-empty-error-and-offline-pages) AC 5

### GET /500

Generic server-error fallback. Shown when an uncaught exception bubbles up to Astro's error-page handler. Carries `noindex=true`. Presents "Something went wrong" with a "Back to home" link.

**Implements:** [REQ-READ-006](../sdd/reading.md#req-read-006-empty-error-and-offline-pages) AC 5

---

## Authentication

### POST /api/auth/github/login (also GET)

Initiates GitHub OAuth. Generates random `state`, sets `oauth_state` cookie (HttpOnly, 10-min TTL), redirects to GitHub.

`POST` is the canonical entry point — the landing page submits a same-origin form to avoid mobile-browser prefetch races that regenerate the state cookie before GitHub's callback returns. `GET` is retained for direct URL access (bookmarks, test tooling). Both methods are exempt from the Origin check per [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints) AC 4: the only effect is setting the state cookie and returning a 303 redirect; no authenticated session state is mutated.

**Implements:** [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-github), [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

### GET /api/auth/github/callback

Handles GitHub's OAuth redirect. Validates `state`, exchanges code for access token, extracts primary verified email, creates or looks up user, sets session cookie, redirects to `/digest` for all users (new and returning).

New accounts are inserted with complete onboarding defaults at the moment of first login — 20 seeded hashtags (`DEFAULT_HASHTAGS`), `digest_hour=8`, `digest_minute=0`, and `email_enabled=1`. The browser auto-corrects timezone on first `/digest` load via a client-side POST to `/api/auth/set-tz`. No `/settings` detour is required for new users.

**Implements:** [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-github), [REQ-AUTH-004](../sdd/authentication.md#req-auth-004-oauth-error-surfacing)

**Error responses:**
- `access_denied`, `no_verified_email`, `oauth_error` — 3xx redirect to `/?error={code}`.
- `invalid_state` (CSRF state mismatch) — HTTP 403 with an HTML body that meta-refreshes to `/?error=invalid_state`. Browsers do not auto-follow `Location` on 4xx responses, so the redirect is delivered via `<meta http-equiv="refresh">` in the body. The origin value interpolated into the body is HTML-escaped.

### POST /api/auth/github/logout

Bumps `session_version`, clears cookie, redirects to `/?logged_out=1`.

**Implements:** [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-session-cookie-and-instant-revocation)

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

**Request:** `{ hashtags: string[], digest_hour: int, digest_minute: int, model_id: string, email_enabled: bool }`

**Response:** `200 { ok: true, discovering: string[] }` — `discovering` lists any newly-added tags that will trigger discovery on the next cron.

**Error codes:** `invalid_hashtags`, `invalid_time`, `invalid_model_id`, `invalid_email_enabled`.

**Implements:** [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation), [REQ-SET-003](../sdd/settings.md#req-set-003-scheduled-digest-time-with-timezone), [REQ-SET-004](../sdd/settings.md#req-set-004-model-selection) *(Deprecated 2026-04-24)*, [REQ-SET-005](../sdd/settings.md#req-set-005-email-notification-preference)

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

Returns up to 29 articles from the global pool filtered by the session user's active hashtags, ordered by `ingested_at DESC, published_at DESC` — newest ingest wins so a fresh scrape always bubbles its articles to the top of the dashboard. The 30th position in the digest grid is always the "see today" tile (a fixed icon card that deep-links to `/history?date=YYYY-MM-DD`). `last_scrape_run` is the most recent completed `scrape_runs` row; `next_scrape_at` is `started_at + 3600` (unix seconds). The pool is always populated — no `live` flag or skeleton state.

**Implements:** [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest) AC 5

### GET /api/digest/:id

**Response:** Same article shape as `/today` for a single article by ID. Scoped to articles whose digest belongs to the session user — returns 404 if not found or not owned.

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

**Callers:**
- `/digest` — swaps the "Next update in Xm" countdown for "Update in progress" while `running=true`.
- `/settings` Force Refresh section — polls every 5s after form submission to show live `articles_ingested` and `chunks_remaining`.

**Implements:** [REQ-PIPE-006](../sdd/generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-and-history)

---

## Discovery

### GET /api/discovery/status

**Response:** `{ pending: string[] }` — tags this user is waiting on for discovery.

**Implements:** [REQ-DISC-002](../sdd/discovery.md#req-disc-002-discovery-progress-visibility) *(Deprecated 2026-04-24)*

### POST /api/discovery/retry

Verifies the submitted tag is in the session user's `hashtags_json`, clears `sources:{tag}` and `discovery_failures:{tag}` KV entries, then inserts a fresh `pending_discoveries` row so the next 5-minute discovery cron repopulates the tag.

The endpoint is additionally gated by Cloudflare Access at the zone level — see [Deployment: Admin-only routes](deployment.md#admin-only-routes-cloudflare-access-gating). Only the configured admin email can reach it in production regardless of session state.

**Content-type: application/json**

**Request:** `{ "tag": "<tag>" }`

**Response:** `200 { "ok": true }` | `400 bad_request` | `400 unknown_tag` | `401 unauthorized` | `403 forbidden_origin`

**Content-type: application/x-www-form-urlencoded**

**Request:** form field `tag=<tag>` (native HTML form POST from the Stuck tags fieldset on `/settings`)

**Response:** `303` redirect to `/settings?rediscover=ok&tag=<tag>` — returns the operator to the settings page with a visible confirmation banner. Error responses are identical in status code to the JSON path; the redirect is only issued on success.

**Implements:** [REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover)

---

## Stars

### POST /api/articles/:id/star

Stars an article. Optimistic — the UI flips the icon before the response returns. Protected by the Origin check.

**Response:** `200 { ok: true, starred: true }` | `401 unauthorized` | `403 forbidden_origin` | `404 not_found`

**Implements:** [REQ-STAR-001](../sdd/reading.md#req-star-001-star-and-unstar-articles)

### DELETE /api/articles/:id/star

Unstars an article. Same auth and error contract as POST.

**Response:** `200 { ok: true, starred: false }` | `401` | `403` | `404`

**Implements:** [REQ-STAR-001](../sdd/reading.md#req-star-001-star-and-unstar-articles)

### GET /api/starred

**Response:** `{ articles: WireArticle[] }` — the session user's starred articles, newest star first, limit 60. Same article shape as `/api/digest/today`.

**Implements:** [REQ-STAR-002](../sdd/reading.md#req-star-002-starred-articles-page)

---

## Tags

### PUT /api/tags

Add or remove a single hashtag from the user's tag list. Persists immediately — no form submit required. Normalises to lowercase, strips `#`, rejects characters outside `[a-z0-9-]`, enforces 2–32 char length and max 25 tags.

**Request:** `{ tag: string, action: "add" | "remove" }`

**Response:** `200 { ok: true, hashtags: string[] }` | `400 invalid_tag` | `400 max_tags_reached` | `401`

**Implements:** [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation)

### POST /api/tags/restore

Replaces the user's hashtag list with the curated default seed from `DEFAULT_HASHTAGS`.

**Response:** `200 { ok: true, hashtags: string[] }` | `401`

**Implements:** [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation) AC 8

---

## Developer Tools

### POST /api/dev/trigger-scrape

Dev-only pipeline trigger. Kicks a real global-feed scrape (coordinator → chunks → LLM → D1) without waiting for the hourly cron or needing Cloudflare Access.

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

**Used by:** `scripts/e2e-test.sh` full-cycle scrape section — triggers the real pipeline and asserts that at least one article is ingested and that the first article's `details` field is ≥ 150 words (target contract: 150–250 words, 2–3 paragraphs per [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract) AC 3).

---

## Operator Tools

### POST /force-refresh (also GET)

Operator-only endpoint that kicks the hourly global-feed coordinator on demand — identical to what the `0 * * * *` cron fires automatically. Creates a fresh `scrape_runs` row with `status='running'` and sends a `SCRAPE_COORDINATOR` queue message.

**Access control:** Intended to be gated by Cloudflare Access at the zone level. `POST` additionally enforces the standard Origin check ([REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)) as defence-in-depth against CSRF from a logged-in browser session. `GET` is exempt from the Origin check so operators can trigger from a bookmark or `curl`.

**Concurrency guard (120-second reuse window):** Before creating a new run, the handler queries for any `scrape_runs` row with `status='running'` started within the last 120 seconds. If one is found it is reused instead of dispatching a second coordinator. This absorbs double-clicks and link-preview bot refetches. Note: two truly concurrent requests can both pass the SELECT before either INSERT commits — the ULIDs are unique so no PK collision collapses the race; for an operator-only endpoint the tradeoff is acceptable.

**POST response:** `303` redirect to `/settings?force_refresh={ok|reused}&run_id={ulid}`.

**GET response:** `200 { ok: true, scrape_run_id: string, reused: bool }`.

**Error response (both methods):** `500 "Failed to dispatch coordinator"` when the D1 INSERT or queue send throws.

**Implements:** [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability) (operator tooling surface), [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-hourly-global-scrape-and-summarise-pipeline)

---

## SEO and Crawler Policy

### GET /sitemap.xml

Dynamic XML sitemap. Lists only the public landing page (`/`). `changefreq=daily`, `priority=1.0`, `lastmod` set to the current date at request time. `Cache-Control: public, max-age=3600`. Referenced from `robots.txt`.

**Implements:** [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability) AC 4

### GET /robots.txt

Static file served from `public/robots.txt`. Allows crawlers access to the landing page and public assets; explicitly disallows `/api/`, `/digest`, `/starred`, `/history`, `/settings`. Blocks known AI training user agents (GPTBot, anthropic-ai, ClaudeBot, Google-Extended, CCBot, PerplexityBot) with a blanket `Disallow: /`. References the sitemap URL.

**Implements:** [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability) AC 2

### GET /llms.txt

Static machine-readable agents policy (served from `public/llms.txt`). Describes the product, what is public, that every surface beyond the landing page requires a GitHub OAuth session, and an explicit request not to train on content behind the login. Links to the sitemap and `robots.txt`.

**Implements:** [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability) AC 3

### GET /llms-full.txt

Extended machine-readable agents policy (`public/llms-full.txt`). Superset of `llms.txt` — adds technology stack detail, storage layer, and GDPR basis for withholding per-user content.

**Implements:** [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability) AC 3

---

## History and Stats

### GET /api/history?offset=0

**Query parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `offset` | integer | No (default 0) | Pagination offset — skip this many rows before returning results |
| `date` | string (`YYYY-MM-DD`) | No | When present, filters to the single day matching this local date and returns a single-day-focused rendering mode with a "Back to all days" control on `/history`. Deep-linked from the "see today" tile on the digest grid. |

**Response:** `{ digests: [...], has_more: bool }` — up to 30 per page ordered by `generated_at DESC`. When `date` is supplied, only digests whose `generated_at` falls on that calendar day are returned and `has_more` is always `false`. Each digest row includes `article_count` (correlated subquery), `model_name` (human-readable, resolved from the model catalog — falls back to the raw `model_id` for removed models), `execution_ms`, `tokens_in`, `tokens_out`, `estimated_cost_usd`, `status`, `error_code`, and `trigger`.

The `/history` page also reads `?q=` (search query, ≥3 chars) and `?tags=` (comma-separated tag list) from the URL client-side to restore the exact filter state when the user returns via the browser back button from an opened article. These parameters are written to the URL via `replaceState` — they are not sent to `/api/history` on the server; the page filters the already-rendered cards in the browser.

**Implements:** [REQ-HIST-001](../sdd/history.md#req-hist-001-paginated-past-digests) AC 4, AC 5

### GET /api/stats

**Response:** `{ digests_generated: int, articles_read: int, articles_total: int, tokens_consumed: int, cost_usd: number }`

All fields are user-scoped via the session. Article queries JOIN through `digests` on `user_id` (IDOR protection by construction). Queries run in parallel via `Promise.all` — no sequential round-trips. `digests_generated` counts only `status='ready'` rows. Defaults to `0` for each field if no data exists.

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
| `auth.logout` | Session version bumped; cookie cleared |
| `auth.account.delete` | User row deleted from D1 (info on success, warn when no row affected) |
| `auth.account.delete.failed` | D1 delete threw, or KV cleanup threw |
| `auth.set_tz.failed` | D1 update in `POST /api/auth/set-tz` threw |
| `digest.generation` | Digest generation completed (success or failure) |
| `source.fetch.failed` | An individual source could not be fetched during fan-out |
| `refresh.rejected` | Manual refresh rejected (rate-limited or already in progress) |
| `email.send.failed` | Resend API call failed |
| `discovery.completed` | Per-tag LLM discovery run finished |
| `discovery.queued` | A new per-tag discovery job was inserted into `pending_discoveries` |
| `settings.update.failed` | D1 update in `PUT /api/settings` threw |

Raw exception messages appear only in the `detail` field of error-level records; they are never stored in D1 and never returned to clients (see [REQ-OPS-002](../sdd/observability.md#req-ops-002-sanitized-error-surfaces)).

---

## Related Documentation

- [Architecture](architecture.md) — Component overview
- [Configuration](configuration.md) — Required env vars and secrets
