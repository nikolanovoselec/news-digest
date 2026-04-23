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

---

## Authentication

### POST /api/auth/github/login (also GET)

Initiates GitHub OAuth. Generates random `state`, sets `oauth_state` cookie (HttpOnly, 10-min TTL), redirects to GitHub.

`POST` is the canonical entry point — the landing page submits a same-origin form to avoid mobile-browser prefetch races that regenerate the state cookie before GitHub's callback returns. `GET` is retained for direct URL access (bookmarks, test tooling). Both methods are exempt from the Origin check per [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints) AC 4: the only effect is setting the state cookie and returning a 303 redirect; no authenticated session state is mutated.

**Implements:** [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-github), [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

### GET /api/auth/github/callback

Handles GitHub's OAuth redirect. Validates `state`, exchanges code for access token, extracts primary verified email, creates or looks up user, sets session cookie, redirects to `/settings?first_run=1` or `/digest`.

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

**Request:** `{ confirm: "DELETE" }`

**Response:** `200 { ok: true, redirect: "/?account_deleted=1" }` (session cookie cleared, FK cascade deletes all user data, KV entries under `user:{id}:*` deleted best-effort) | `400 confirmation_required` | `401 unauthorized` | `403 forbidden_origin`

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

**Implements:** [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation), [REQ-SET-003](../sdd/settings.md#req-set-003-scheduled-digest-time-with-timezone), [REQ-SET-004](../sdd/settings.md#req-set-004-model-selection), [REQ-SET-005](../sdd/settings.md#req-set-005-email-notification-preference)

---

## Digests

### GET /api/digest/today

**Response:** `{ digest: DigestRow | null, articles: ArticleRow[], live: bool, next_scheduled_at: int | null }`

Returns the most recent digest row for this user; `live=true` when `status='in_progress'`; `next_scheduled_at` is the unix ts of the next scheduled run when today's has not yet generated (null when live). The digest row includes `id`, `local_date`, `generated_at`, `execution_ms`, `tokens_in`, `tokens_out`, `estimated_cost_usd`, `model_id`, `status`, `error_code`, `trigger`. Each article row includes `id`, `digest_id`, `slug`, `source_url`, `title`, `one_liner`, `details_json`, `source_name`, `published_at`, `rank`, `read_at`, `tags` (JSON array of the user hashtags this article matched during fan-out — used by the tag-strip filter per [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation) and [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest) AC 7).

**Implements:** [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-READ-005](../sdd/reading.md#req-read-005-pending-today-banner)

### GET /api/digest/:id

**Response:** Same shape as `/today` for a specific digest. Query is scoped: `SELECT * FROM digests WHERE id = ? AND user_id = :session_user_id` — returns 404 if not found or not owned.

**Implements:** [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-READ-004](../sdd/reading.md#req-read-004-live-generation-state)

### POST /api/digest/refresh

Manual refresh. Rate-limited to once per 30 seconds and 100 per rolling 24h. Runs a conditional INSERT to prevent duplicate in-progress digests.

**Response:** `202 { digest_id, status: 'in_progress' }`

**Error codes:** `rate_limited` (429 with `retry_after_seconds`, `reason: cooldown|daily_cap`), `already_in_progress` (409).

**Implements:** [REQ-GEN-002](../sdd/generation.md#req-gen-002-manual-refresh-with-rate-limiting)

---

## Discovery

### GET /api/discovery/status

**Response:** `{ pending: string[] }` — tags this user is waiting on for discovery.

**Implements:** [REQ-DISC-002](../sdd/discovery.md#req-disc-002-discovery-progress-visibility)

### POST /api/discovery/retry

**Request:** `{ tag: string }`

**Response:** `200 { ok: true }` | `400 unknown_tag` | `401`

Verifies the tag is in the user's `hashtags_json`, clears `sources:{tag}` and `discovery_failures:{tag}` KV entries, inserts a fresh `pending_discoveries` row.

**Implements:** [REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover)

---

## History and Stats

### GET /api/history?offset=0

**Response:** `{ digests: [...], has_more: bool }` — up to 30 per page ordered by `generated_at DESC`. Each digest row includes `article_count` (correlated subquery), `model_name` (human-readable, resolved from the model catalog — falls back to the raw `model_id` for removed models), `execution_ms`, `tokens_in`, `tokens_out`, `estimated_cost_usd`, `status`, `error_code`, and `trigger`.

**Implements:** [REQ-HIST-001](../sdd/history.md#req-hist-001-paginated-past-digests)

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
