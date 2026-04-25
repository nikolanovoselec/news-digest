# Architecture

System overview, component map, and data flow.

**Audience:** Developers

---

## Overview

news-digest is a single Cloudflare Worker serving an Astro-rendered app. Every hour, a Cron Trigger fires the global-feed coordinator: it fans out 50+ curated RSS/Atom/JSON sources, canonical-URL-deduplicates candidates, and enqueues chunked LLM summarization jobs to a Cloudflare Queue. Chunk consumers write articles to a shared D1 pool. Per-user dashboards read from that pool filtered by the user's active hashtags — no per-user LLM calls. A daily cron at 03:00 UTC purges articles older than 7 days (starred articles are exempt). See [`sdd/README.md`](../sdd/README.md) for product intent.

Implements [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence).

## Components

| Component | Role |
|---|---|
| Astro Worker (request handler) | Serves all HTML pages and JSON APIs; runs in the Cloudflare Workers runtime |
| Cron Trigger | 5-minute trigger — sweeper + discovery + scheduled-digest dispatcher |
| Queue Consumer | Processes `digest-jobs` messages; runs `generateDigest` in isolate-per-message |
| D1 | Strongly-consistent storage for users, digests, articles, pending_discoveries |
| KV | Edge-distributed cache for discovered sources, headlines, source health |
| Workers AI | LLM inference for digest summarization and source discovery |
| Resend | Transactional email for "digest ready" notifications |
| Federated OAuth (GitHub, Google) | Sign-in via configured providers; at least one provider pair must be set |

## Source Modules

### Middleware

| Path | Responsibility | Implements |
|---|---|---|
| `src/middleware/index.ts` | Astro middleware entry point; chains `securityHeadersMiddleware` as the last global handler | [REQ-OPS-003](../sdd/observability.md#req-ops-003-security-headers-on-every-response) |
| `src/middleware/auth.ts` | `loadSession()` — reads `__Host-news_digest_session` cookie, verifies HMAC-SHA256 JWT, checks `session_version`, auto-refreshes cookie on near-expiry; `buildSessionCookie()`, `buildClearSessionCookie()`, `readCookie()`, `applyRefreshCookie()` helpers | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-session-cookie-and-instant-revocation) |
| `src/middleware/origin-check.ts` | `checkOrigin()` — rejects POST/PUT/PATCH/DELETE requests whose `Origin` header is absent or does not match `APP_URL`; returns 403 `forbidden_origin`; `originOf()` helper | [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints), [REQ-OPS-002](../sdd/observability.md#req-ops-002-sanitized-error-surfaces) |
| `src/middleware/security-headers.ts` | `securityHeadersMiddleware` — stamps CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` on every response via `Headers.set()` | [REQ-OPS-003](../sdd/observability.md#req-ops-003-security-headers-on-every-response) |

### Libraries

| Path | Responsibility | Implements |
|---|---|---|
| `src/lib/canonical-url.ts` | URL canonicalization for cross-source article dedupe — normalizes scheme, strips tracking params, lowercases host | [REQ-GEN-004](../sdd/generation.md#req-gen-004-url-canonicalization-and-dedupe) |
| `src/lib/db.ts` | D1 wrapper with `PRAGMA foreign_keys=ON`, prepared statements, `batch()` helper | (shared, not REQ-specific) |
| `src/lib/email.ts` | Resend client; `sendDigestEmail()`, `renderDigestEmailHtml()`, `renderDigestEmailText()` — best-effort, never re-throws | [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email), [REQ-MAIL-002](../sdd/email.md#req-mail-002-non-blocking-email-failure) |
| `src/lib/errors.ts` | Closed `ErrorCode` enum + `USER_FACING_MESSAGES` map + `errorResponse()` builder — ensures every API error carries a sanitized code and generic message | [REQ-OPS-002](../sdd/observability.md#req-ops-002-sanitized-error-surfaces) |
| `src/lib/generate.ts` | LLM response helpers for the global-feed pipeline — `extractResponsePayload()` resolves both flat (`{ response }`) and OpenAI-envelope (`{ choices[0].message.content }`) shapes; `parseLLMPayload()` strips fences, extracts the first brace-balanced object, and validates structure. The per-user `generateDigest` function was retired in the 2026-04-23 global-feed rework. | [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract) |
| `src/lib/headline-cache.ts` | KV-backed 10-minute shared cache for per-source/per-tag headline fetches; key `headlines:{source}:{tag}`, TTL 600 s | [REQ-GEN-003](../sdd/generation.md#req-gen-003-source-fan-out-with-caching) |
| `src/lib/log.ts` | `log(level, event, fields)` — emits `JSON.stringify({ ts, level, event, ...fields })` to `console.log`; `LogEvent` is a closed enum preventing log injection | [REQ-OPS-001](../sdd/observability.md#req-ops-001-structured-json-logging) |
| `src/lib/default-hashtags.ts` | `DEFAULT_HASHTAGS` seed list (12 technology tags used for brand-new accounts) + `RESTORE_DEFAULTS_LABEL` constant shared by the UI button and tests | [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation) |
| `src/lib/models.ts` | Hardcoded `MODELS` catalog + `DEFAULT_MODEL_ID` (`@cf/openai/gpt-oss-20b`) + `FALLBACK_MODEL_ID` (`@cf/openai/gpt-oss-120b`) + `estimateCost()` + `modelById()`. `DEFAULT_MODEL_ID` was swapped from Gemma 4 after Gemma's chain-of-thought reasoning consumed the entire `max_tokens` budget before emitting any JSON — every chunk landed with `finish_reason=length` and `content=null`. `gpt-oss-20b` has a hard JSON-mode guarantee. `DEFAULT_MODEL_ID` is also used as a fallback when a digest is generated for a user whose stored `model_id` no longer appears in `MODELS` (e.g., after a model retirement) | [REQ-SET-004](../sdd/settings.md#req-set-004-model-selection) *(Deprecated 2026-04-24)*, [REQ-GEN-008](../sdd/generation.md#req-gen-008-cost-time-and-token-transparency) |
| `src/lib/oauth-errors.ts` | `OAUTH_ERROR_CODES` allowlist + `mapOAuthError()` sanitizer + `isKnownOAuthErrorCode()` — collapses unknown GitHub error strings to `oauth_error` | [REQ-AUTH-004](../sdd/authentication.md#req-auth-004-oauth-error-surfacing) |
| `src/lib/prompts.ts` | `PROCESS_CHUNK_SYSTEM`, `DISCOVERY_SYSTEM`, prompt builders, `LLM_PARAMS`. The `details` field contract: 2 or 3 plaintext paragraphs separated by the JSON-escaped token `\n` (backslash-n), each 3–5 sentences, totalling 150–200 words. Paragraph roles are fixed: 1. WHAT happened (concrete facts, who/what/when), 2. HOW it works (architecture, mechanism, numbers), 3. IMPACT for the reader (cost, migration, security posture — optional third paragraph). A `details` value under ~120 words is treated as a failed response. `temperature` is 0.6. Each article entry in the `PROCESS_CHUNK_SYSTEM` prompt must echo its input candidate's `index` value so the consumer can align LLM output back to the input by index rather than by position; a title-overlap sanity check (at least one substantive non-stopword token shared with the source headline) provides a second alignment guard. Implements [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract) AC 3, AC 7, AC 8. | [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract), [REQ-GEN-005](../sdd/generation.md#req-gen-005-single-call-llm-summarization), [REQ-DISC-001](../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery) |
| `src/lib/session-jwt.ts` | HMAC-SHA256 sign/verify for session cookies; `shouldRefreshJWT()` for near-expiry detection | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-session-cookie-and-instant-revocation) |
| `src/lib/slug.ts` | `slugify(title)` + `deduplicateSlug(slug, existing)` — deterministic ASCII slug generation with collision suffix | [REQ-GEN-006](../sdd/generation.md#req-gen-006-atomic-final-write) |
| `src/lib/sources.ts` | Source adapters (RSS/Atom, JSON) and the fan-out coordinator — fetches every `{tag × curated-source}` pair through a semaphore-capped concurrency of 10; per-source failures are logged via `source.fetch.failed` and never propagate so a single flaky source cannot abort the entire run. Each item's publication timestamp is extracted via `parseFeedDate()` (RSS `pubDate` / Dublin Core `dc:date`, Atom `published`/`updated`, JSON Feed `date_published`), clamped to the range 2000-01-01–now+1d, and threaded through as `published_at` (unix seconds); articles without a parseable date fall back to ingestion time set by the chunk consumer. Feed snippets are extracted from `<content:encoded>` (preferred, full HTML body), then `<description>` / Atom `<summary>` for RSS/Atom feeds; HN items use `story_text` (self-posts); Reddit items use `selftext`. Snippets are stripped to plaintext and capped at 1200 characters before landing in the chunk prompt. | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-DISC-001](../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery) |
| `src/lib/curated-sources.ts` | Registry of 50+ curated sources; each entry declares slug, name, feed URL, feed kind, and at least one system tag | [REQ-PIPE-004](../sdd/generation.md#req-pipe-004-curated-source-registry-with-50-feeds-spanning-the-20-system-tags) |
| `src/lib/dedupe.ts` | Canonical-URL + LLM-cluster deduplication — merges `dedup_groups` hints from the LLM payload with URL equality; first-source-wins within each cluster | [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-canonical-url--llm-cluster-dedupe-with-first-source-wins) |
| `src/lib/scrape-run.ts` | `startRun()`, `finishRun()` — D1 helpers for the `scrape_runs` lifecycle (`running` → `ready` or `failed`) | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-PIPE-006](../sdd/generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress) |
| `src/lib/ssrf.ts` | `isUrlSafe(url)` — SSRF filter for LLM-suggested URLs; rejects non-HTTPS, private IPv4/IPv6 ranges, loopback, CGNAT, metadata hosts | [REQ-DISC-005](../sdd/discovery.md#req-disc-005-discovery-prompt-injection-protection), [REQ-GEN-003](../sdd/generation.md#req-gen-003-source-fan-out-with-caching) |
| `src/lib/article-fetch.ts` | `extractArticleText(html)` — extracts readable body text from raw HTML using a multi-container heuristic: tries `<article>`, `<main>`, and common content-div class names in priority order, taking whichever yields the longest clean text; falls back to `<body>`. Non-content blocks (scripts, styles, nav, header, footer, aside, forms, SVGs) are stripped before extraction. Output is capped at 3000 characters. `fetchArticleBody(url)` — fetches one article URL (SSRF-guarded, 8 s timeout, 1.5 MB cap) and returns extracted text or null on failure. `fetchArticleBodies(urls, concurrency)` — bulk variant with a 20-worker concurrency bucket. | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) |
| `src/lib/types.ts` | Shared cross-module types: `AuthenticatedUser`, `Headline`, `GeneratedArticle`, `DiscoveredFeed`, `SourcesCacheValue` | (shared, not REQ-specific) |
| `src/lib/tz.ts` | `localDateInTz()`, `localHourMinuteInTz()` — IANA timezone helpers via `Intl.DateTimeFormat`; `DEFAULT_TZ`, `isValidTz()` | [REQ-SET-003](../sdd/settings.md#req-set-003-scheduled-digest-time-with-timezone), [REQ-GEN-001](../sdd/generation.md#req-gen-001-scheduled-generation-via-cron-dispatcher) |
| `src/lib/ulid.ts` | `generateUlid()` — 26-char Crockford base32 ULID; lexicographically sortable by time; Web-standard crypto only | [REQ-GEN-006](../sdd/generation.md#req-gen-006-atomic-final-write) |
| `src/lib/feed-health.ts` | Per-URL fetch-health counter for the self-healing discovery loop. `recordFetchResult(env, url, success)` — on success: deletes the `source_health:{url}` KV key; on failure: increments it (7-day TTL). Returns `{ evicted: boolean, count: number }` where `evicted` becomes true when consecutive failures reach `CONSECUTIVE_FETCH_FAILURE_LIMIT` (30). `clearHealth(env, url)` — called by the coordinator eviction path after a URL is removed from its `sources:{tag}` entry so a re-discovered feed at the same URL starts from zero. Never throws — KV errors are treated as a no-op to prevent a transient KV outage from mass-evicting the registry. | [REQ-DISC-003](../sdd/discovery.md#req-disc-003-self-healing-feed-health-tracking) |
| `src/lib/discovery.ts` | `discoverTag(tag, env)` — one-shot LLM discovery pipeline with SSRF+parse validation; `processPendingDiscoveries(env, limit)` — cron hook, drains pending rows and writes `sources:{tag}` KV. Uses the shared `extractResponsePayload` helper from `generate.ts` to tolerate both the flat `{ response }` shape (Llama/Mistral) and the OpenAI envelope `{ choices[0].message.content }` shape (gpt-oss-120b); without this, discovery calls on OpenAI-backed models returned `empty_llm_response`. Logs `warn` / `discovery.completed` with `status: 'llm_missing_feeds_field'` and returns `[]` when the LLM returns a shaped object that lacks a `feeds` array. | [REQ-DISC-001](../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery), [REQ-DISC-005](../sdd/discovery.md#req-disc-005-discovery-prompt-injection-protection) |
| `src/lib/tag-railing-flip.ts` | Shared FLIP-pattern helper for the tag railing on `/digest` and `/history`. Exports `flipChipToFront(strip, chip, options)` and `isFlipLocked(strip)`. The helper captures pre-mutation rects (FLIP First), moves the tapped chip to slot 0 via `insertBefore` (Last), inverts positions with `transform` (Invert), then transitions transforms to zero on the next animation frame (Play). Applies a `tag-chip--just-tapped` pulse class for immediate input confirmation (AC 1). Sets `data-tag-flip-locked` on the strip for the duration of the cascade to prevent double-tap desyncs (AC 4). On overflow-scrollable strips, scrolls to `left: 0` only when the tapped chip was outside the visible area before the tap (AC 5). Bails to an instant reorder when `prefers-reduced-motion: reduce` is active (AC 7). Lock is cleared in a `try/finally` block so the strip never gets stuck inert if a DOM operation throws. | [REQ-READ-007](../sdd/reading.md#req-read-007-tag-railing-reorder-animation) |

### API Routes

| Path | Responsibility | Implements |
|---|---|---|
| `src/lib/oauth-providers.ts` | Provider registry: `PROVIDERS` (github + google), per-provider `fetchProfile(tokens, clientId)` adapter (`clientId` threaded through `ProfileFetcher` so adapters can validate without re-resolving env vars), `configuredProviders(env)` returns providers with creds set sorted alphabetically, `userIdFor(provider, sub)` namespaces non-GitHub ids as `<provider>:<sub>` while GitHub keeps its bare-numeric form for legacy compatibility. Google adapter decodes the id_token and validates `iss` (`accounts.google.com`), `aud` (must equal `clientId`), and `exp` (OIDC Core 3.1.3.7 — required even when signature verification is skipped because the token came directly from the token endpoint over TLS). `displayName` fallback ladder: profile `name` → `given_name` → verified email → `'Google user'` (never exposes the opaque `sub`). | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) |
| `src/pages/api/auth/[provider]/login.ts` | `GET/POST /api/auth/<provider>/login` — generates a per-provider CSRF state, sets `news_digest_oauth_state_<provider>` cookie, redirects to the provider's authorize URL. Unknown provider → 404; provider with no creds → `oauth_not_configured` | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) |
| `src/pages/api/auth/[provider]/callback.ts` | `GET /api/auth/<provider>/callback` — validates state, exchanges code (JSON body for GitHub, form-urlencoded for Google), runs the provider's `fetchProfile`, upserts user row keyed by `userIdFor(provider, sub)` (GitHub bare numeric, Google `google:<sub>`), mints session JWT, redirects to `/digest`. New accounts are inserted with `digest_hour=8`, 20 seeded hashtags, and `email_enabled=1` so no `/settings` detour is needed. On error redirects to `/?error=<code>&provider=<name>` | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider), [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-session-cookie-and-instant-revocation), [REQ-AUTH-004](../sdd/authentication.md#req-auth-004-oauth-error-surfacing) |
| `src/pages/api/auth/logout.ts` | `POST /api/auth/logout` — bumps `session_version`, clears session cookie, redirects to `/?logged_out=1`. Provider-agnostic | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-session-cookie-and-instant-revocation), [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints) |
| `src/pages/api/auth/set-tz.ts` | `POST /api/auth/set-tz` — validates IANA timezone via `Intl.supportedValuesOf`, persists to `users.tz` | [REQ-SET-007](../sdd/settings.md#req-set-007-timezone-change-detection), [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints) |
| `src/pages/api/auth/account.ts` | `DELETE /api/auth/account` — requires `{ confirm: "DELETE" }`, deletes user row (FK cascade), paginates and deletes KV entries keyed by `user:{id}:*`, clears cookie | [REQ-AUTH-005](../sdd/authentication.md#req-auth-005-account-deletion) |
| `src/pages/api/settings.ts` | `GET /api/settings`, `PUT /api/settings` — user settings snapshot and update; queues new tags for discovery via `pending_discoveries` | [REQ-SET-001](../sdd/settings.md#req-set-001-unified-first-run-and-edit-flow), [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation), [REQ-SET-003](../sdd/settings.md#req-set-003-scheduled-digest-time-with-timezone), [REQ-SET-004](../sdd/settings.md#req-set-004-model-selection) *(Deprecated 2026-04-24)*, [REQ-SET-005](../sdd/settings.md#req-set-005-email-notification-preference), [REQ-SET-006](../sdd/settings.md#req-set-006-settings-incomplete-gate) |
| `src/pages/api/digest/today.ts` | `GET /api/digest/today` — 29 most-recently-ingested articles filtered by user tags (`ORDER BY ingested_at DESC, published_at DESC`) + last scrape run metadata + `next_scrape_at` | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest) AC 5 |
| `src/pages/api/digest/[id].ts` | `GET /api/digest/:id` — user-scoped digest by id; IDOR-safe | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-READ-004](../sdd/reading.md#req-read-004-live-generation-state) |
| `src/pages/api/digest/refresh.ts` | `POST /api/digest/refresh` — manual refresh; atomic rate-limit + conditional INSERT; enqueues to `digest-jobs` | [REQ-GEN-002](../sdd/generation.md#req-gen-002-manual-refresh-with-rate-limiting) |
| `src/pages/api/history.ts` | `GET /api/history?offset=N` — paginated digest history, 30/page with `has_more`; enriches rows with `model_name` | [REQ-HIST-001](../sdd/history.md#req-hist-001-day-grouped-article-history) |
| `src/pages/api/stats.ts` | `GET /api/stats` — four user-scoped aggregates (digests, articles read/total, tokens, cost) via parallel D1 queries | [REQ-HIST-002](../sdd/history.md#req-hist-002-user-stats-widget) |
| `src/pages/api/discovery/status.ts` | `GET /api/discovery/status` — pending discovery tags for the session user | [REQ-DISC-002](../sdd/discovery.md#req-disc-002-discovery-progress-visibility) *(Deprecated 2026-04-24)* |
| `src/pages/api/admin/discovery/retry.ts` | `POST /api/admin/discovery/retry` — accepts JSON body `{"tag":"<tag>"}` (returns `200 {ok:true}`) or form-encoded `tag=<tag>` (returns `303 → /settings?rediscover=ok&tag=<tag>`); clears `sources:{tag}` and `discovery_failures:{tag}` KV, re-queues in `pending_discoveries`; gated by Cloudflare Access (`/api/admin/*` wildcard) | [REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover) |
| `src/pages/api/admin/discovery/retry-bulk.ts` | `POST /api/admin/discovery/retry-bulk` — single-form submission that re-queues every empty-feeds tag for the session user in one D1 batch; returns `303 → /settings?rediscover=ok&count=<N>`; backs the "Discover missing sources" button | [REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover) |
| `src/pages/api/articles/[id]/star.ts` | `POST /api/articles/:id/star` + `DELETE /api/articles/:id/star` — star and unstar; user-scoped; protected by Origin check | [REQ-STAR-001](../sdd/reading.md#req-star-001-star-and-unstar-articles) |
| `src/pages/api/starred.ts` | `GET /api/starred` — list the session user's starred articles, newest star first; limit 60 | [REQ-STAR-002](../sdd/reading.md#req-star-002-starred-articles-page) |
| `src/pages/api/tags.ts` | `PUT /api/tags` — add or remove a single hashtag from the user's tag list; persists immediately (no form submit); normalises to lowercase, strips `#`, rejects invalid chars | [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation) |
| `src/pages/api/tags/restore.ts` | `POST /api/tags/restore` — replaces the user's hashtag list with the default seed from `DEFAULT_HASHTAGS` | [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation) |
| `src/pages/api/scrape-status.ts` | `GET /api/scrape-status` — lightweight status poll (one D1 SELECT + one KV get); returns `{ running: false }` or `{ running: true, id, started_at, chunks_remaining, chunks_total, articles_ingested }`; polled by `/digest` countdown and `/settings` Force Refresh section | [REQ-PIPE-006](../sdd/generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress) |
| `src/pages/api/dev/trigger-scrape.ts` | `POST /api/dev/trigger-scrape` — dev-only pipeline trigger gated by `DEV_BYPASS_TOKEN` (timing-safe Bearer comparison); 404s when the secret is absent or empty. Creates a `scrape_runs` row and sends a `SCRAPE_COORDINATOR` message. Returns `202 { ok, scrape_run_id, status_url }`. Used by `scripts/e2e-test.sh` to drive a real scrape without waiting for the cron or needing Cloudflare Access for `/api/admin/force-refresh`. | — |

### Pages

| Path | Responsibility | Implements |
|---|---|---|
| `src/pages/digest.astro` | `/digest` overview grid — queries the shared article pool filtered by the user's active tags; renders 29 `DigestCard` tiles plus a fixed 30th "see today" tile (`.digest-page__more-card` / `.digest-page__more-icon`) using the MDI `gradient-vertical` icon; the tile's `href` is `/history?date=YYYY-MM-DD` computed server-side via `localDateInTz` from `src/lib/tz.ts`. Inline tag-filter strip and "Last updated / Next update" countdown header included; polls `GET /api/scrape-status` to swap the countdown for "Update in progress" while a scrape run is active. A visually-hidden `h1.digest-page__a11y-title` ("Today's digest") is present for screen-reader heading navigation. | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-READ-005](../sdd/reading.md#req-read-005-empty-dashboard-state), [REQ-PIPE-006](../sdd/generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress) |
| `src/pages/digest/[id]/[slug].astro` | Article detail page — renders full article with `transition:name` matching `DigestCard` for shared-element morph; marks `read_at` on first load; history-aware back control uses `document.referrer` to navigate back to whichever in-app page the user came from (dashboard, history, starred, search) rather than always targeting `/digest` | [REQ-READ-002](../sdd/reading.md#req-read-002-article-detail-view), [REQ-READ-003](../sdd/reading.md#req-read-003-read-tracking) |
| `src/pages/404.astro` | Catch-all not-found page — `noindex=true`; calm headline and "Back to home" link | [REQ-READ-006](../sdd/reading.md#req-read-006-empty-error-and-offline-pages) |
| `src/pages/500.astro` | Generic server-error fallback — `noindex=true`; shown when an uncaught exception reaches Astro's error handler | [REQ-READ-006](../sdd/reading.md#req-read-006-empty-error-and-offline-pages) |
| `src/pages/starred.astro` | `/starred` — card grid scoped to articles the session user has starred, ordered by star time descending | [REQ-STAR-002](../sdd/reading.md#req-star-002-starred-articles-page) |
| `src/pages/history.astro` | `/history` — calls the `GET /api/history?offset=0` handler in-process (no subrequest), renders paginated digest rows; "Load more" button appends further pages via client-side fetch. Includes the shared `TagStrip` component whose chip clicks, `?q=` search-query, and `?tags=` comma-separated-tag-list are synced to the URL via `replaceState` so the browser back button restores the exact filter state. When `?date=YYYY-MM-DD` is present (deep-linked from the digest grid "see today" tile), the page renders in single-day-focused mode — only matching-day digests are shown and a "Back to all days" control appears. Document-delegated click handler (not per-chip listeners) manages chip interactions. | [REQ-HIST-001](../sdd/history.md#req-hist-001-day-grouped-article-history) AC 4, AC 5, AC 7 |
| `src/pages/settings.astro` | `/settings` — steady-state settings editor; includes `StatsWidget`, `HashtagChip`, `ModelSelect`, a Force Refresh section with live scrape-progress polling via `GET /api/scrape-status`, a manual IANA timezone picker (`<select>` pre-populated from `Intl.supportedValuesOf('timeZone')`, client-side upgraded to the browser-detected zone) that persists via the same `PUT /api/settings` save handler as the rest of the form, and a "Stuck tags" fieldset ([REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover)) that surfaces a single "Discover missing sources" button when at least one user tag has an empty `sources:{tag}` KV entry; the fieldset is absent when no tag is stuck | [REQ-SET-001](../sdd/settings.md#req-set-001-unified-first-run-and-edit-flow), [REQ-SET-007](../sdd/settings.md#req-set-007-timezone-change-detection) AC 5, [REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover) |
| `src/pages/api/admin/force-refresh.ts` | `POST /api/admin/force-refresh` + `GET /api/admin/force-refresh` — operator-only endpoint that kicks the hourly global-feed coordinator on demand; 120-second reuse window prevents duplicate runs; gated by Cloudflare Access (`/api/admin/*` wildcard) | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability) |
| `src/pages/sitemap.xml.ts` | `GET /sitemap.xml` — dynamic XML sitemap; lists only the public landing page | [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability) |
| `src/pages/offline.astro` | Service-worker fallback page served from Cache Storage when the network is unavailable | [Out of Scope](../sdd/README.md#out-of-scope) — offline reading (was REQ-PWA-002) was descoped; this file may be a build artefact |
| `src/pages/rate-limited.astro` | User-facing rate-limited error page shown when `POST /api/digest/refresh` returns 429 | [REQ-READ-006](../sdd/reading.md#req-read-006-empty-error-and-offline-pages) |
| `src/layouts/Base.astro` | Root HTML shell — manifest link, Apple PWA meta tags, `defer`-loaded `theme-init.js`, View Transitions (`ClientRouter`); landing page carries title, description, canonical, and Open Graph metadata. On authenticated pages, stamps `data-user-tz` on `<body>` and inlines a global script that compares the browser's resolved IANA timezone to the stored value and silently POSTs to `/api/auth/set-tz` when they differ — runs on every route so timezone drift from travel is corrected immediately. | [REQ-DES-001](../sdd/design.md#req-des-001-swiss-minimal-visual-language), [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash), [REQ-DES-003](../sdd/design.md#req-des-003-deliberate-motion-system), [REQ-PWA-001](../sdd/pwa.md#req-pwa-001-installable-pwa-manifest), [REQ-PWA-003](../sdd/pwa.md#req-pwa-003-mobile-first-responsive-layout), [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability), [REQ-SET-007](../sdd/settings.md#req-set-007-timezone-change-detection) AC 3 |

### Components

| Path | Responsibility | Implements |
|---|---|---|
| `src/components/HeaderThemeToggle.astro` | Compact sun/moon toggle button fixed in the authenticated site header (left of the UserMenu avatar). Uses the same `data-theme-toggle` attribute as `ThemeToggle.astro` so the UserMenu's delegated click listener handles it — ships no JS of its own, preventing double-fire | [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash) |
| `src/components/ThemeToggle.astro` | Theme-switch button with sun/moon icons inside the user menu; wires `initThemeToggle` click handler; `data-theme-toggle` attribute for re-wiring after View Transitions | [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash) |
| `src/components/UserMenu.astro` | Avatar-triggered dropdown in the header — contains theme toggle, History, Settings, Starred, and Log out entries; consolidates all navigation into the header on every viewport | [REQ-PWA-003](../sdd/pwa.md#req-pwa-003-mobile-first-responsive-layout) |
| `src/components/InstallPrompt.astro` | Cross-platform install prompt — defers `beforeinstallprompt` on Android/Chrome; renders one-time iOS share-icon note via UA sniff; hidden when already in standalone mode | [REQ-PWA-001](../sdd/pwa.md#req-pwa-001-installable-pwa-manifest) |
| `src/components/TagStrip.astro` | Shared tag-railing component — hashtag chips (label + count + remove affordance), add-pill, and hidden text input for inline tag creation. Extracted from `digest.astro` so the identical chip geometry, add/remove UX, and `is:global` CSS apply consistently across `/digest` and `/history`. Ships the `tagChipPulse` keyframe and `.tag-chip--just-tapped` class consumed by the FLIP helper. | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest) AC 4, [REQ-HIST-001](../sdd/history.md#req-hist-001-day-grouped-article-history) AC 5, [REQ-READ-007](../sdd/reading.md#req-read-007-tag-railing-reorder-animation) AC 1 |
| `src/components/DigestCard.astro` | Article card for the digest grid — title, one-liner summary, source badge, star toggle; carries `transition:name` for shared-element morph into the detail page; stagger animation | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-READ-002](../sdd/reading.md#req-read-002-article-detail-view), [REQ-STAR-001](../sdd/reading.md#req-star-001-star-and-unstar-articles) |
| `src/components/AltSourcesModal.astro` | Modal that lists every source (primary + alternatives) for a multi-source article; closes on Escape and backdrop click | [REQ-READ-002](../sdd/reading.md#req-read-002-article-detail-view) |
| `src/components/StatsWidget.astro` | Four-tile stats widget (digests generated, articles read/total, tokens consumed, cost to date); calls the `GET /api/stats` handler in-process (no subrequest) on every page load | [REQ-HIST-002](../sdd/history.md#req-hist-002-user-stats-widget) |
| `src/components/ModelSelect.astro` | `<select>` dropdown populated from the `MODELS` catalog; groups options by category using `<optgroup>`; shows per-model cost estimate | [REQ-SET-004](../sdd/settings.md#req-set-004-model-selection) *(Deprecated 2026-04-24)* |

### Client Scripts

| Path | Responsibility | Implements |
|---|---|---|
| `src/scripts/theme-toggle.ts` | `initThemeToggle` — reads/writes `localStorage.theme`, toggles `data-theme` on `<html>`, re-wires on View Transitions | [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash) |

### Styles and Static Assets

| Path | Responsibility | Implements |
|---|---|---|
| `src/styles/global.css` | CSS custom properties for color tokens (`--bg`, `--surface`, `--text`, `--text-muted`, `--border`, `--accent`) per theme; type scale; focus ring; motion system (`--ease`, `--duration-fast/normal/slow`); safe-area utilities; tap-highlight disable | [REQ-DES-001](../sdd/design.md#req-des-001-swiss-minimal-visual-language), [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash), [REQ-DES-003](../sdd/design.md#req-des-003-deliberate-motion-system), [REQ-PWA-003](../sdd/pwa.md#req-pwa-003-mobile-first-responsive-layout) |
| `public/theme-init.js` | IIFE loaded with `defer` before CSS — reads `localStorage.theme`, falls back to `prefers-color-scheme`, sets `document.documentElement.dataset.theme`; also triggers `caches.delete('digest-cache-v1')` on `?logged_out=1` | [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash) — cache-delete line relates to offline reading (was REQ-PWA-002, now [Out of Scope](../sdd/README.md#out-of-scope)) |
| `public/manifest.webmanifest` | Web app manifest with `name`, `short_name`, `description`, `start_url=/digest`, `display=standalone`, `theme_color`, `background_color`, and two SVG icon entries (`/icons/app-icon.svg`, `sizes="any"`, one with `purpose: "any"` and one with `purpose: "maskable"`) | [REQ-PWA-001](../sdd/pwa.md#req-pwa-001-installable-pwa-manifest) |
| `public/robots.txt` | Crawler policy — allows only the landing page and public assets; blocks AI training crawlers; references the sitemap | [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability) |
| `public/llms.txt` | Machine-readable agents policy — describes the product, what is public, and requests that agents not train on content behind the login | [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability) |
| `public/llms-full.txt` | Extended agents policy with technology stack and GDPR basis detail | [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability) |
| `public/swiss-post.svg` | Swiss Post sponsor logo; displayed on the landing page | — |
| `public/scramble.js` | Text scramble animation script used on the landing page hero | — |
| `migrations/0001_initial.sql` | D1 schema (users, digests, articles, pending_discoveries) | (foundational) |

### Worker Entry and Queue

| Path | Responsibility | Implements |
|---|---|---|
| `src/worker.ts` | Cron + queue dispatch entry (source for post-build bundle) — hourly tick fires the scrape coordinator; daily tick fires the 7-day retention cleanup | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-PIPE-005](../sdd/generation.md#req-pipe-005-seven-day-retention-with-starred-exempt-cleanup) |
| `src/queue/scrape-coordinator.ts` | Queue consumer for `SCRAPE_COORDINATOR` messages — fans out sources, records per-URL fetch outcomes via `feed-health.ts` (`source_health:{url}` KV), applies a 48-hour freshness filter (candidates whose parsed publish date is older than 48 h before the current tick are dropped before LLM summarisation; candidates with no parsable publish date are kept), then applies feed evictions: discovered-tag URLs that crossed the 30-failure threshold are removed from their `sources:{tag}` KV entry; when eviction empties a tag's feed list a re-discovery row is inserted into `pending_discoveries` with `user_id = '__system__'` so real-user queries (scoped `WHERE user_id = ?`) naturally exclude it while the discovery cron (which GROUPs BY tag) picks it up on the next invocation. Finally chunks remaining candidates and enqueues `SCRAPE_CHUNK` messages for LLM processing. | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) AC 7, [REQ-PIPE-004](../sdd/generation.md#req-pipe-004-curated-source-registry-with-50-feeds-spanning-the-20-system-tags), [REQ-DISC-003](../sdd/discovery.md#req-disc-003-self-healing-feed-health-tracking) |
| `src/queue/scrape-chunk-consumer.ts` | Queue consumer for `SCRAPE_CHUNK` messages — for each chunk: (1) fetches article HTML bodies for candidates whose feed snippet is below 400 characters (using `fetchArticleBodies` with 20-worker concurrency), taking whichever of the fetched body or the feed snippet is longer as the prompt `snippet`; (2) runs one LLM call per chunk; (3) aligns LLM output back to input candidates by echoed `index` (Map-based; falls back to positional when fewer than 3 articles echo a valid index or fewer than 50% of articles echo); (4) drops any article whose LLM-generated title shares no substantive non-stopword token with the source candidate's headline (title-overlap sanity check); (5) deduplicates via LLM dedup_groups + canonical-URL equality; (6) writes articles to D1. Per-chunk failure only marks that chunk failed; other chunks in the same tick persist. Body-fetch happens in the consumer (not the coordinator) to avoid blowing the coordinator's execution budget before chunks are enqueued. | [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract), [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-canonical-url--llm-cluster-dedupe-with-first-source-wins) |
| `src/queue/cleanup.ts` | Queue consumer for the daily retention cron — runs two sequential passes: (1) article retention sweep: deletes unstarred articles older than 7 days with FK-cascade cleanup of alternative sources, tag rows, and read-tracking rows ([REQ-PIPE-005](../sdd/generation.md#req-pipe-005-seven-day-retention-with-starred-exempt-cleanup)); (2) orphan-tag KV sweep: deletes `sources:{tag}` and `discovery_failures:{tag}` KV entries whose tag is not owned by any user ([REQ-PIPE-007](../sdd/generation.md#req-pipe-007-orphan-tag-source-cleanup)) | [REQ-PIPE-005](../sdd/generation.md#req-pipe-005-seven-day-retention-with-starred-exempt-cleanup), [REQ-PIPE-007](../sdd/generation.md#req-pipe-007-orphan-tag-source-cleanup) |
| `scripts/merge-worker-handlers.mjs` | Post-build esbuild shim — bundles `src/worker.ts` then writes `dist/_worker.js/_merged.mjs`, which re-exports Astro's `fetch` handler alongside the `scheduled` and `queue` exports; this file is what `wrangler.toml main` points at | (build tooling) |
| `dist/_worker.js/_merged.mjs` | Generated wrangler entry (`main` in `wrangler.toml`); auto-generated, not committed | (build artifact) |

**Build flow:** `astro build` produces `dist/_worker.js/index.js` (fetch-only). The npm `build` script then runs `merge-worker-handlers.mjs`, which uses esbuild to bundle `src/worker.ts` into `dist/_worker.js/handlers-bundle.mjs` and writes `_merged.mjs` that merges both. Wrangler deploys `_merged.mjs`. The `@astrojs/cloudflare` adapter's `workerEntryPoint` option was not used because it produced an invalid merged worker (Cloudflare validator error 10021).

## Request Lifecycle

### Hourly global-feed pipeline

Implements [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract).

```
Cron fires (every hour, on the hour)
  → SCRAPE_COORDINATOR queue message sent
Coordinator consumer
  → fans out all {tag × curated-source} pairs (concurrency cap: 10)
  → per-source fetch outcome recorded in KV: source_health:{url}
      success → deletes counter; failure → increments counter (7-day TTL)
  → per-source fetch failure logged; never propagates (resilient fan-out)
  → feed snippets extracted: <content:encoded> → <description> → HN story_text → Reddit selftext
  → eviction pass (REQ-DISC-003): discovered-tag URLs at 30 consecutive failures
      → removed from sources:{tag} KV entry; per-URL health counter cleared
      → if tag's feed list is now empty → INSERT pending_discoveries (user_id='__system__')
         so the discovery cron repopulates it on the next 5-minute invocation
      → curated URLs tracked in the health counter but never evicted at runtime
  → candidates older than 48 h (by parsed publish date) are dropped; candidates with no parsable date are kept
  → canonical-URL deduplication across all candidates
  → chunks ~100 candidates → enqueues one SCRAPE_CHUNK message per chunk
Chunk consumer (per chunk, isolated)
  → fetches article HTML bodies for candidates with snippet < 400 chars (20-worker concurrency)
  → merges fetched body with feed snippet — takes whichever is longer
  → single Workers AI call (JSON output; default model: gpt-oss-20b)
  → LLM enforces 150–200-word contract on the details field (≥ 120 words required): 2 or 3 paragraphs (WHAT happened / HOW it works / optionally IMPACT for the reader), each 3–5 sentences, \n-separated; each article echoes its input index so the consumer aligns by index (falls back to positional when < 3 articles echo a valid index or < 50% echo); title-overlap sanity check drops any article whose LLM-generated title shares no substantive token with the source headline
  → LLM-cluster + canonical-URL dedupe (first-source-wins)
  → db.batch([articles, alternative_sources, tags, scrape_run counters])
  → chunk failure marks only that chunk failed; other chunks persist
```

### Operator force-refresh

```
Operator → POST /api/admin/force-refresh (or GET /api/admin/force-refresh)
  → checks scrape_runs for any 'running' row < 120 s old
  → if found: reuse that run_id (no second coordinator dispatched)
  → if not found: INSERT scrape_runs row, send SCRAPE_COORDINATOR message
  → POST: 303 → /settings?force_refresh={ok|reused}&run_id={ulid}
  → GET:  200 { ok, scrape_run_id, reused }
```

### Daily retention cleanup

```
Cron fires (daily at 03:00 UTC)
  → Pass 1 — article retention (REQ-PIPE-005):
      DELETE articles WHERE published_at < now-7d AND NOT starred by any user
      FK cascade removes alternative sources, tag rows, read-tracking rows
  → Pass 2 — orphan-tag KV sweep (REQ-PIPE-007):
      DELETE sources:{tag} and discovery_failures:{tag} for every tag
      not present in any user's active tag list
```

## Data Flow

Articles are the central entity in the global pool. Each article belongs to a `scrape_runs` tick, not a user. Users read from the pool by filtering on their active hashtags. Foreign keys cascade on delete. Starred articles are user-scoped and exempt from the 7-day cleanup.

Pending discoveries are per-user rows but discovery results (`sources:{tag}` KV) are globally shared so multiple users benefit from a single discovery run.

The `pending_discoveries` table is also written by the system when a feed eviction empties a tag's source list. These rows carry `user_id = '__system__'` (a synthetic sentinel that is never a real ULID) so queries scoped to a real user naturally exclude them. The discovery cron groups by tag and picks up both real-user and system-owned rows on the next invocation.

The `/settings` page surfaces a "Stuck tags" fieldset ([REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover)) when any of the session user's tags has an empty `sources:{tag}` KV entry. A single "Discover missing sources" button in that fieldset posts to `POST /api/admin/discovery/retry-bulk` — via a native HTML form so the flow works in Samsung Browser and in-app webviews — which clears the stale KV entries and re-queues a discovery pass for every empty-feeds tag in one D1 batch. The route is gated by Cloudflare Access (`/api/admin/*` wildcard); non-admin users see the Access login prompt rather than the re-queue succeeding. The single-tag JSON variant `POST /api/admin/discovery/retry` is preserved for scripted callers.

Implements [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest).

---

## Related Documentation

- [Configuration](configuration.md) — Env vars, secrets, bindings
- [API Reference](api-reference.md) — Endpoint contracts
- [Decisions](decisions/README.md) — Architectural decisions and rationale
