# Architecture

System overview, component map, and data flow.

**Audience:** Developers

---

## Overview

news-digest is a single Cloudflare Worker serving an Astro-rendered app. Every 5 minutes, a Cron Trigger runs a stuck-digest sweeper, processes up to 3 pending source-discovery tasks, and enqueues scheduled digest-generation jobs to a Cloudflare Queue. The queue consumer runs the same `generateDigest` function that powers manual refreshes. See [`sdd/README.md`](../sdd/README.md) for product intent.

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
| GitHub OAuth | Only sign-in mechanism |

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
| `src/lib/canonical-url.ts` | URL canonicalization for cross-source article dedupe — normalizes scheme, strips tracking params, lowercases host | [REQ-GEN-004](../sdd/generation.md#req-gen-004-article-deduplication) |
| `src/lib/db.ts` | D1 wrapper with `PRAGMA foreign_keys=ON`, prepared statements, `batch()` helper | (shared, not REQ-specific) |
| `src/lib/email.ts` | Resend client; `sendDigestEmail()`, `renderDigestEmailHtml()`, `renderDigestEmailText()` — best-effort, never re-throws | [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email), [REQ-MAIL-002](../sdd/email.md#req-mail-002-email-failure-handling) |
| `src/lib/errors.ts` | Closed `ErrorCode` enum + `USER_FACING_MESSAGES` map + `errorResponse()` builder — ensures every API error carries a sanitized code and generic message | [REQ-OPS-002](../sdd/observability.md#req-ops-002-sanitized-error-surfaces) |
| `src/lib/generate.ts` | The single `generateDigest(env, user, trigger, digestId?)` function — claims the digest row, fans out sources, runs one LLM call, writes articles atomically, sends email | [REQ-GEN-001](../sdd/generation.md#req-gen-001-scheduled-generation-via-cron-dispatcher), [REQ-GEN-002](../sdd/generation.md#req-gen-002-manual-refresh-with-rate-limiting), [REQ-GEN-003](../sdd/generation.md#req-gen-003-source-fan-out-with-caching), [REQ-GEN-004](../sdd/generation.md#req-gen-004-article-deduplication), [REQ-GEN-005](../sdd/generation.md#req-gen-005-single-call-llm-summarization), [REQ-GEN-006](../sdd/generation.md#req-gen-006-article-slugs-and-ulids), [REQ-GEN-008](../sdd/generation.md#req-gen-008-cost-transparency-footer) |
| `src/lib/headline-cache.ts` | KV-backed 10-minute shared cache for per-source/per-tag headline fetches; key `headlines:{source}:{tag}`, TTL 600 s | [REQ-GEN-003](../sdd/generation.md#req-gen-003-source-fan-out-with-caching) |
| `src/lib/log.ts` | `log(level, event, fields)` — emits `JSON.stringify({ ts, level, event, ...fields })` to `console.log`; `LogEvent` is a closed enum preventing log injection | [REQ-OPS-001](../sdd/observability.md#req-ops-001-structured-json-logging) |
| `src/lib/models.ts` | Hardcoded `MODELS` list + `DEFAULT_MODEL_ID` + `estimateCost()` | [REQ-SET-004](../sdd/settings.md#req-set-004-model-selection), [REQ-GEN-008](../sdd/generation.md#req-gen-008-cost-transparency-footer) |
| `src/lib/oauth-errors.ts` | `OAUTH_ERROR_CODES` allowlist + `mapOAuthError()` sanitizer + `isKnownOAuthErrorCode()` — collapses unknown GitHub error strings to `oauth_error` | [REQ-AUTH-004](../sdd/authentication.md#req-auth-004-oauth-error-surfacing) |
| `src/lib/prompts.ts` | `DIGEST_SYSTEM`, `DISCOVERY_SYSTEM`, prompt builders, `LLM_PARAMS` | [REQ-GEN-005](../sdd/generation.md#req-gen-005-single-call-llm-summarization), [REQ-DISC-001](../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery) |
| `src/lib/session-jwt.ts` | HMAC-SHA256 sign/verify for session cookies; `shouldRefreshJWT()` for near-expiry detection | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-session-cookie-and-instant-revocation) |
| `src/lib/slug.ts` | `slugify(title)` + `deduplicateSlug(slug, existing)` — deterministic ASCII slug generation with collision suffix | [REQ-GEN-006](../sdd/generation.md#req-gen-006-article-slugs-and-ulids) |
| `src/lib/sources.ts` | Generic source adapters + discovered-feed fetcher; `fanOutForTags()` + `adaptersForDiscoveredFeeds()` | [REQ-GEN-003](../sdd/generation.md#req-gen-003-source-fan-out-with-caching), [REQ-DISC-001](../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery) |
| `src/lib/ssrf.ts` | `isUrlSafe(url)` — SSRF filter for LLM-suggested URLs; rejects non-HTTPS, private IPv4/IPv6 ranges, loopback, CGNAT, metadata hosts | [REQ-DISC-005](../sdd/discovery.md#req-disc-005-ssrf-protection-for-feed-validation), [REQ-GEN-003](../sdd/generation.md#req-gen-003-source-fan-out-with-caching) |
| `src/lib/types.ts` | Shared cross-module types: `AuthenticatedUser`, `Headline`, `GeneratedArticle`, `DiscoveredFeed`, `SourcesCacheValue` | (shared, not REQ-specific) |
| `src/lib/tz.ts` | `localDateInTz()`, `localHourMinuteInTz()` — IANA timezone helpers via `Intl.DateTimeFormat`; `DEFAULT_TZ`, `isValidTz()` | [REQ-SET-003](../sdd/settings.md#req-set-003-scheduled-digest-time-with-timezone), [REQ-GEN-001](../sdd/generation.md#req-gen-001-scheduled-generation-via-cron-dispatcher) |
| `src/lib/ulid.ts` | `generateUlid()` — 26-char Crockford base32 ULID; lexicographically sortable by time; Web-standard crypto only | [REQ-GEN-006](../sdd/generation.md#req-gen-006-article-slugs-and-ulids) |
| `src/lib/discovery.ts` | `discoverTag(tag, env)` — one-shot LLM discovery pipeline with SSRF+parse validation; `processPendingDiscoveries(env, limit)` — cron hook, drains pending rows and writes `sources:{tag}` KV | [REQ-DISC-001](../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery), [REQ-DISC-003](../sdd/discovery.md#req-disc-003-feed-health-tracking-and-auto-eviction), [REQ-DISC-005](../sdd/discovery.md#req-disc-005-ssrf-protection-for-feed-validation) |

### API Routes

| Path | Responsibility | Implements |
|---|---|---|
| `src/pages/api/auth/github/login.ts` | `GET /api/auth/github/login` — generates CSRF state, sets `news_digest_oauth_state` cookie, redirects to GitHub authorize URL with `scope=user:email` | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-github) |
| `src/pages/api/auth/github/callback.ts` | `GET /api/auth/github/callback` — validates state, exchanges code, fetches profile + emails in parallel, upserts user row, mints session JWT, redirects | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-github), [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-session-cookie-and-instant-revocation), [REQ-AUTH-004](../sdd/authentication.md#req-auth-004-oauth-error-surfacing) |
| `src/pages/api/auth/github/logout.ts` | `POST /api/auth/github/logout` — bumps `session_version`, clears session cookie, redirects to `/?logged_out=1` | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-session-cookie-and-instant-revocation), [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints) |
| `src/pages/api/auth/set-tz.ts` | `POST /api/auth/set-tz` — validates IANA timezone via `Intl.supportedValuesOf`, persists to `users.tz` | [REQ-SET-007](../sdd/settings.md#req-set-007-timezone-change-detection), [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints) |
| `src/pages/api/auth/account.ts` | `DELETE /api/auth/account` — requires `{ confirm: "DELETE" }`, deletes user row (FK cascade), paginates and deletes KV entries keyed by `user:{id}:*`, clears cookie | [REQ-AUTH-005](../sdd/authentication.md#req-auth-005-account-deletion) |
| `src/pages/api/settings.ts` | `GET /api/settings`, `PUT /api/settings` — user settings snapshot and update; queues new tags for discovery via `pending_discoveries` | [REQ-SET-001](../sdd/settings.md#req-set-001-unified-first-run-and-edit-flow), [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation), [REQ-SET-003](../sdd/settings.md#req-set-003-scheduled-digest-time-with-timezone), [REQ-SET-004](../sdd/settings.md#req-set-004-model-selection), [REQ-SET-005](../sdd/settings.md#req-set-005-email-notification-preference), [REQ-SET-006](../sdd/settings.md#req-set-006-settings-incomplete-gate) |
| `src/pages/api/digest/today.ts` | `GET /api/digest/today` — most recent digest + articles + `live` flag + `next_scheduled_at` | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-READ-005](../sdd/reading.md#req-read-005-pending-today-banner) |
| `src/pages/api/digest/[id].ts` | `GET /api/digest/:id` — user-scoped digest by id; IDOR-safe | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-READ-004](../sdd/reading.md#req-read-004-live-generation-state) |
| `src/pages/api/digest/refresh.ts` | `POST /api/digest/refresh` — manual refresh; atomic rate-limit + conditional INSERT; enqueues to `digest-jobs` | [REQ-GEN-002](../sdd/generation.md#req-gen-002-manual-refresh-with-rate-limiting) |
| `src/pages/api/history.ts` | `GET /api/history?offset=N` — paginated digest history, 30/page with `has_more`; enriches rows with `model_name` | [REQ-HIST-001](../sdd/history.md#req-hist-001-paginated-past-digests) |
| `src/pages/api/stats.ts` | `GET /api/stats` — four user-scoped aggregates (digests, articles read/total, tokens, cost) via parallel D1 queries | [REQ-HIST-002](../sdd/history.md#req-hist-002-user-stats-widget) |
| `src/pages/api/discovery/status.ts` | `GET /api/discovery/status` — pending discovery tags for the session user | [REQ-DISC-002](../sdd/discovery.md#req-disc-002-discovery-progress-visibility) |
| `src/pages/api/discovery/retry.ts` | `POST /api/discovery/retry` — clears `sources:{tag}` and `discovery_failures:{tag}` KV, re-queues in `pending_discoveries` | [REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover) |

### Pages

| Path | Responsibility | Implements |
|---|---|---|
| `src/pages/digest.astro` | `/digest` overview grid — fetches `GET /api/digest/today`, renders `DigestCard` grid or `LoadingSkeleton` when `live=true`, shows `PendingBanner` when `next_scheduled_at` is set | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-READ-004](../sdd/reading.md#req-read-004-live-generation-state), [REQ-READ-005](../sdd/reading.md#req-read-005-pending-today-banner) |
| `src/pages/digest/[id]/` | Article detail page — renders full article with `transition:name` matching `DigestCard` for shared-element morph; marks `read_at` via `PATCH /api/digest/:id/:slug` | [REQ-READ-002](../sdd/reading.md#req-read-002-article-detail-page), [REQ-READ-003](../sdd/reading.md#req-read-003-read-state-tracking) |
| `src/pages/digest/failed.astro` | Error page shown when digest `status='failed'` — surfaces the `error_code` with a retry option | [REQ-READ-004](../sdd/reading.md#req-read-004-live-generation-state) |
| `src/pages/digest/no-stories.astro` | Empty-state page shown when the digest completed with zero articles | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest) |
| `src/pages/history.astro` | `/history` — calls the `GET /api/history?offset=0` handler in-process (no subrequest), renders paginated digest rows; "Load more" button appends further pages via client-side fetch | [REQ-HIST-001](../sdd/history.md#req-hist-001-paginated-past-digests) |
| `src/pages/settings.astro` | `/settings` — unified first-run and edit flow; includes `StatsWidget`, `HashtagChip`, `ModelSelect` | [REQ-SET-001](../sdd/settings.md#req-set-001-unified-first-run-and-edit-flow) |
| `src/pages/offline.astro` | Service-worker fallback page served from Cache Storage when the network is unavailable | [REQ-PWA-002](../sdd/pwa.md#req-pwa-002-offline-reading-of-the-last-digest) |
| `src/pages/rate-limited.astro` | User-facing rate-limited error page shown when `POST /api/digest/refresh` returns 429 | [REQ-GEN-002](../sdd/generation.md#req-gen-002-manual-refresh-with-rate-limiting), [REQ-READ-006](../sdd/reading.md#req-read-006-manual-refresh-ui) |
| `src/layouts/Base.astro` | Root HTML shell — manifest link, Apple PWA meta tags, `defer`-loaded `theme-init.js`, View Transitions (`ClientRouter`), `ThemeToggle` in header | [REQ-DES-001](../sdd/design.md#req-des-001-swiss-minimal-visual-language), [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash), [REQ-DES-003](../sdd/design.md#req-des-003-deliberate-motion-system), [REQ-PWA-001](../sdd/pwa.md#req-pwa-001-installable-pwa-manifest), [REQ-PWA-003](../sdd/pwa.md#req-pwa-003-mobile-first-responsive-layout) |

### Components

| Path | Responsibility | Implements |
|---|---|---|
| `src/components/ThemeToggle.astro` | Header button with sun/moon icons; wires `initThemeToggle` click handler; `data-theme-toggle` attribute for re-wiring after View Transitions | [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash) |
| `src/components/BottomNav.astro` | Fixed bottom tab bar (Digest, History, Settings) visible below 768 px; `env(safe-area-inset-bottom)` padding; hides at ≥1024 px | [REQ-PWA-003](../sdd/pwa.md#req-pwa-003-mobile-first-responsive-layout) |
| `src/components/Sidebar.astro` | Left sidebar (Digest, History, Settings + logout form) visible at ≥1024 px; `env(safe-area-inset-top/bottom)` padding | [REQ-PWA-003](../sdd/pwa.md#req-pwa-003-mobile-first-responsive-layout) |
| `src/components/InstallPrompt.astro` | Cross-platform install prompt — defers `beforeinstallprompt` on Android/Chrome; renders one-time iOS share-icon note via UA sniff; hidden when already in standalone mode | [REQ-PWA-001](../sdd/pwa.md#req-pwa-001-installable-pwa-manifest) |
| `src/components/DigestCard.astro` | Article card for the digest grid — title, one-liner (150–200 chars), source badge; carries `transition:name` for shared-element morph into the detail page; stagger animation (40 ms/card, capped at 10) | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-READ-002](../sdd/reading.md#req-read-002-article-detail-page) |
| `src/components/LoadingSkeleton.astro` | Single skeleton card matching `DigestCard` dimensions with 1.4 s shimmer; disabled under `prefers-reduced-motion` | [REQ-READ-004](../sdd/reading.md#req-read-004-live-generation-state) |
| `src/components/CostFooter.astro` | Digest footer: "Generated HH:MM TZ · Xs · N tokens · ~$C · model_name"; supports `estimated` flag that prefixes `~` to token count and cost | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-GEN-008](../sdd/generation.md#req-gen-008-cost-transparency-footer) |
| `src/components/PendingBanner.astro` | Scheduled-digest countdown banner — "Next digest at HH:MM — in Xh Ym"; live client-side tick every 60 s via `data-next-at` unix ts | [REQ-READ-005](../sdd/reading.md#req-read-005-pending-today-banner) |
| `src/components/StatsWidget.astro` | Four-tile stats widget (digests generated, articles read/total, tokens consumed, cost to date); calls the `GET /api/stats` handler in-process (no subrequest) on every page load | [REQ-HIST-002](../sdd/history.md#req-hist-002-user-stats-widget) |
| `src/components/HashtagChip.astro` | Selectable hashtag toggle chip for the settings form; state carried in `aria-pressed` + `data-selected` | [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation) |
| `src/components/ModelSelect.astro` | `<select>` dropdown populated from the `MODELS` catalog; groups options by category using `<optgroup>`; shows per-model cost estimate | [REQ-SET-004](../sdd/settings.md#req-set-004-model-selection) |

### Client Scripts

| Path | Responsibility | Implements |
|---|---|---|
| `src/scripts/digest-poll.ts` | 5 s polling loop for `GET /api/digest/:id`; stops when `status != 'in_progress'`; triggers `astro:page-load` navigation on `ready` | [REQ-READ-004](../sdd/reading.md#req-read-004-live-generation-state) |
| `src/scripts/theme-toggle.ts` | `initThemeToggle` — reads/writes `localStorage.theme`, toggles `data-theme` on `<html>`, re-wires on View Transitions | [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash) |

### Styles and Static Assets

| Path | Responsibility | Implements |
|---|---|---|
| `src/styles/global.css` | CSS custom properties for color tokens (`--bg`, `--surface`, `--text`, `--text-muted`, `--border`, `--accent`) per theme; type scale; focus ring; motion system (`--ease`, `--duration-fast/normal/slow`); safe-area utilities; tap-highlight disable | [REQ-DES-001](../sdd/design.md#req-des-001-swiss-minimal-visual-language), [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash), [REQ-DES-003](../sdd/design.md#req-des-003-deliberate-motion-system), [REQ-PWA-003](../sdd/pwa.md#req-pwa-003-mobile-first-responsive-layout) |
| `public/theme-init.js` | IIFE loaded with `defer` before CSS — reads `localStorage.theme`, falls back to `prefers-color-scheme`, sets `document.documentElement.dataset.theme`; also triggers `caches.delete('digest-cache-v1')` on `?logged_out=1` | [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash), [REQ-PWA-002](../sdd/pwa.md#req-pwa-002-offline-reading-of-the-last-digest) |
| `public/manifest.webmanifest` | Web app manifest with `name`, `short_name`, `description`, `start_url=/digest`, `display=standalone`, `theme_color`, `background_color`, and three icon entries (192 any, 512 any, 512 maskable) | [REQ-PWA-001](../sdd/pwa.md#req-pwa-001-installable-pwa-manifest) |
| `migrations/0001_initial.sql` | D1 schema (users, digests, articles, pending_discoveries) | (foundational) |

### Worker Entry and Queue

| Path | Responsibility | Implements |
|---|---|---|
| `src/worker.ts` | Cron + queue handlers (source for post-build bundle) | [REQ-GEN-001](../sdd/generation.md#req-gen-001-scheduled-generation-via-cron-dispatcher), [REQ-GEN-007](../sdd/generation.md#req-gen-007-stuck-digest-sweeper) |
| `src/queue/digest-consumer.ts` | Queue handler that invokes `generateDigest` | [REQ-GEN-001](../sdd/generation.md#req-gen-001-scheduled-generation-via-cron-dispatcher), [REQ-GEN-002](../sdd/generation.md#req-gen-002-manual-refresh-with-rate-limiting) |
| `scripts/merge-worker-handlers.mjs` | Post-build esbuild shim — bundles `src/worker.ts` then writes `dist/_worker.js/_merged.mjs`, which re-exports Astro's `fetch` handler alongside the `scheduled` and `queue` exports; this file is what `wrangler.toml main` points at | (build tooling) |
| `dist/_worker.js/_merged.mjs` | Generated wrangler entry (`main` in `wrangler.toml`); auto-generated, not committed | (build artifact) |

**Build flow:** `astro build` produces `dist/_worker.js/index.js` (fetch-only). The npm `build` script then runs `merge-worker-handlers.mjs`, which uses esbuild to bundle `src/worker.ts` into `dist/_worker.js/handlers-bundle.mjs` and writes `_merged.mjs` that merges both. Wrangler deploys `_merged.mjs`. The `@astrojs/cloudflare` adapter's `workerEntryPoint` option was not used because it produced an invalid merged worker (Cloudflare validator error 10021).

## Request Lifecycle

### Scheduled digest generation

```
Cron fires (every 5 min)
  → stuck-digest sweeper (UPDATE digests WHERE generated_at < now-600)
  → discovery processor (up to 3 pending tags)
  → scheduling pass (for each tz, find due users)
  → enqueue to digest-jobs queue (sendBatch)
Queue consumer (up to 10 concurrent isolates)
  → generateDigest(user, 'scheduled')
  → fan out to generic sources + discovered feeds (cached via headlines:*:* KV)
  → single Workers AI call
  → db.batch([articles, digest status, user last_generated_local_date])
  → if email_enabled: Resend POST (non-blocking)
```

### Manual refresh

```
Browser → POST /api/digest/refresh
  → atomic UPDATE users (rate-limit check)
  → conditional INSERT digests (409 if in-progress exists)
  → enqueue to digest-jobs queue
  → return 202 { digest_id }
Browser polls GET /api/digest/:id every 5s until status != 'in_progress'
```

## Data Flow

Users are the single top-level entity. Every digest belongs to a user; every article belongs to a digest. Foreign keys cascade on delete. Pending discoveries are per-user rows but discovery results (sources per tag) are globally shared in KV so multiple users benefit from a single discovery run.

Headlines cache (`headlines:{source}:{tag}`) is shared globally with a 10-minute TTL, which is why thundering herds at 08:00 local do not hammer upstream sources.

---

## Related Documentation

- [Configuration](configuration.md) — Env vars, secrets, bindings
- [API Reference](api-reference.md) — Endpoint contracts
- [Decisions](decisions/README.md) — Architectural decisions and rationale
