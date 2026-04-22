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

Modules shipped as of Phase 2 (auth + design + PWA + observability). Further modules will be added as phases complete.

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
| `src/lib/db.ts` | D1 wrapper with `PRAGMA foreign_keys=ON`, prepared statements, `batch()` helper | (shared, not REQ-specific) |
| `src/lib/errors.ts` | Closed `ErrorCode` enum + `USER_FACING_MESSAGES` map + `errorResponse()` builder — ensures every API error carries a sanitized code and generic message | [REQ-OPS-002](../sdd/observability.md#req-ops-002-sanitized-error-surfaces) |
| `src/lib/log.ts` | `log(level, event, fields)` — emits `JSON.stringify({ ts, level, event, ...fields })` to `console.log`; `LogEvent` is a closed enum preventing log injection | [REQ-OPS-001](../sdd/observability.md#req-ops-001-structured-json-logging) |
| `src/lib/models.ts` | Hardcoded `MODELS` list + `DEFAULT_MODEL_ID` | [REQ-SET-004](../sdd/settings.md#req-set-004-model-selection) |
| `src/lib/oauth-errors.ts` | `OAUTH_ERROR_CODES` allowlist + `mapOAuthError()` sanitizer + `isKnownOAuthErrorCode()` — collapses unknown GitHub error strings to `oauth_error` | [REQ-AUTH-004](../sdd/authentication.md#req-auth-004-oauth-error-surfacing) |
| `src/lib/prompts.ts` | `DIGEST_SYSTEM`, `DISCOVERY_SYSTEM`, prompt builders, `LLM_PARAMS` | [REQ-GEN-005](../sdd/generation.md#req-gen-005-single-call-llm-summarization), [REQ-DISC-001](../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery) |
| `src/lib/session-jwt.ts` | HMAC-SHA256 sign/verify for session cookies; `shouldRefreshJWT()` for near-expiry detection | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-session-cookie-and-instant-revocation) |
| `src/lib/sources.ts` | Generic source adapters + discovered-feed fetcher | [REQ-GEN-003](../sdd/generation.md#req-gen-003-source-fan-out-with-caching), [REQ-DISC-001](../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery) |
| `src/lib/generate.ts` | The single `generateDigest(user, trigger, digestId?)` function | [REQ-GEN-001](../sdd/generation.md#req-gen-001-scheduled-generation-via-cron-dispatcher) |
| `src/lib/email.ts` | Resend client + "digest ready" template | [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email) |

### API Routes

| Path | Responsibility | Implements |
|---|---|---|
| `src/pages/api/auth/github/login.ts` | `GET /api/auth/github/login` — generates CSRF state, sets `news_digest_oauth_state` cookie, redirects to GitHub authorize URL with `scope=user:email` | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-github) |
| `src/pages/api/auth/github/callback.ts` | `GET /api/auth/github/callback` — validates state, exchanges code, fetches profile + emails in parallel, upserts user row, mints session JWT, redirects | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-github), [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-session-cookie-and-instant-revocation), [REQ-AUTH-004](../sdd/authentication.md#req-auth-004-oauth-error-surfacing) |
| `src/pages/api/auth/github/logout.ts` | `POST /api/auth/github/logout` — bumps `session_version`, clears session cookie, redirects to `/?logged_out=1` | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-session-cookie-and-instant-revocation), [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints) |
| `src/pages/api/auth/set-tz.ts` | `POST /api/auth/set-tz` — validates IANA timezone via `Intl.supportedValuesOf`, persists to `users.tz` | [REQ-SET-007](../sdd/settings.md#req-set-007-timezone-change-detection), [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints) |
| `src/pages/api/auth/account.ts` | `DELETE /api/auth/account` — requires `{ confirm: "DELETE" }`, deletes user row (FK cascade), paginates and deletes KV entries keyed by `user:{id}:*`, clears cookie | [REQ-AUTH-005](../sdd/authentication.md#req-auth-005-account-deletion) |
| `src/pages/api/settings.ts` | GET/PUT handlers for user settings | [REQ-SET-001](../sdd/settings.md#req-set-001-unified-first-run-and-edit-flow) |
| `src/pages/api/digest/*.ts` | Refresh, today, by-id, article read | [REQ-GEN-002](../sdd/generation.md#req-gen-002-manual-refresh-with-rate-limiting), [REQ-READ-005](../sdd/reading.md#req-read-005-pending-today-banner) |
| `src/pages/api/discovery/*.ts` | Status, retry | [REQ-DISC-002](../sdd/discovery.md#req-disc-002-discovery-progress-visibility), [REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover) |

### Pages

| Path | Responsibility | Implements |
|---|---|---|
| `src/pages/*.astro` | Landing, settings, digest, article detail, history | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-SET-001](../sdd/settings.md#req-set-001-unified-first-run-and-edit-flow) |
| `src/layouts/Base.astro` | Root HTML shell — manifest link, Apple PWA meta tags, `defer`-loaded `theme-init.js`, View Transitions (`ClientRouter`), `ThemeToggle` in header | [REQ-DES-001](../sdd/design.md#req-des-001-swiss-minimal-visual-language), [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash), [REQ-DES-003](../sdd/design.md#req-des-003-deliberate-motion-system), [REQ-PWA-001](../sdd/pwa.md#req-pwa-001-installable-pwa-manifest), [REQ-PWA-003](../sdd/pwa.md#req-pwa-003-mobile-first-responsive-layout) |

### Components

| Path | Responsibility | Implements |
|---|---|---|
| `src/components/ThemeToggle.astro` | Header button with sun/moon icons; wires `initThemeToggle` click handler; `data-theme-toggle` attribute for re-wiring after View Transitions | [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash) |
| `src/components/BottomNav.astro` | Fixed bottom tab bar (Digest, History, Settings) visible below 768 px; `env(safe-area-inset-bottom)` padding; hides at ≥1024 px | [REQ-PWA-003](../sdd/pwa.md#req-pwa-003-mobile-first-responsive-layout) |
| `src/components/Sidebar.astro` | Left sidebar (Digest, History, Settings + logout form) visible at ≥1024 px; `env(safe-area-inset-top/bottom)` padding | [REQ-PWA-003](../sdd/pwa.md#req-pwa-003-mobile-first-responsive-layout) |
| `src/components/InstallPrompt.astro` | Cross-platform install prompt — defers `beforeinstallprompt` on Android/Chrome; renders one-time iOS share-icon note via UA sniff; hidden when already in standalone mode | [REQ-PWA-001](../sdd/pwa.md#req-pwa-001-installable-pwa-manifest) |

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
| `src/worker.ts` | Entry point + cron handler | [REQ-GEN-001](../sdd/generation.md#req-gen-001-scheduled-generation-via-cron-dispatcher), [REQ-GEN-007](../sdd/generation.md#req-gen-007-stuck-digest-sweeper) |
| `src/queue/digest-consumer.ts` | Queue handler that invokes `generateDigest` | [REQ-GEN-001](../sdd/generation.md#req-gen-001-scheduled-generation-via-cron-dispatcher), [REQ-GEN-002](../sdd/generation.md#req-gen-002-manual-refresh-with-rate-limiting) |

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
