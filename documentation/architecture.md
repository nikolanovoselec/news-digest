# Architecture

System overview, component map, and request lifecycles for `news-digest`.

**Audience:** Developers, Operators

This document describes **what** the system is and **how requests flow through it**. Implementation rationale ("why this code looks the way it does") lives in source comments. Endpoint contracts live in [`api-reference.md`](api-reference.md). Environment and bindings live in [`configuration.md`](configuration.md). Architectural decisions live in [`decisions/README.md`](decisions/README.md). Product intent lives in [`sdd/`](../sdd/).

---

## 1. Overview

`news-digest` is a single Cloudflare Worker serving an Astro-rendered web app. A 4-hour cron tick scrapes a curated set of RSS/Atom/JSON feeds, summarises new candidates with Workers AI, and writes them to a shared global article pool. Per-user dashboards filter that pool by the user's hashtags — there are no per-user LLM calls. A 5-minute cron drains pending feed-discovery jobs and dispatches daily digest emails. A 03:00 UTC cron purges articles older than 14 days (starred articles exempt).

```
┌────────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker (Astro)                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐    │
│  │ Page handler │  │ API handlers │  │  Cron + Queue dispatch │    │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬────────────┘    │
│         └──────────────┬──┴───────────────────┬──┘                 │
│                        ▼                      ▼                    │
│                ┌──────────────┐       ┌──────────────┐             │
│                │      D1      │       │ Cloudflare   │             │
│                │ (consistent) │       │    Queues    │             │
│                └──────────────┘       └──────┬───────┘             │
│                                              ▼                     │
│                ┌──────────────┐       ┌──────────────┐             │
│                │      KV      │       │ Workers AI   │             │
│                │  (cache)     │       │   (LLM)      │             │
│                └──────────────┘       └──────────────┘             │
└────────────────────────────────────────────────────────────────────┘
                  │                                        │
                  ▼                                        ▼
          GitHub / Google                              Resend
           (federated OAuth)                       (digest emails)
```

Implements [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-PIPE-008](../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass).

## 2. Components

| Component | Role |
|---|---|
| Astro Worker | Serves all HTML pages and JSON APIs in the Cloudflare Workers runtime |
| Cron Triggers | 5-minute (discovery + email dispatch), 4-hour (scrape), daily 03:00 UTC (retention) |
| Queue Consumers | `SCRAPE_COORDINATOR`, `SCRAPE_CHUNKS`, `SCRAPE_FINALIZE`, cleanup |
| D1 | Strongly-consistent storage: users, articles, scrape_runs, refresh_tokens, pending_discoveries |
| KV | Edge-cached `sources:{tag}`, headline cache, per-URL fetch-health counters, rate-limit counters |
| Workers AI | LLM inference for chunk summarisation, source discovery, cross-chunk dedup |
| Resend | Transactional email transport for digest-ready notifications |
| Federated OAuth | GitHub and Google sign-in (at least one provider must be configured) |

## 3. Repository Layout

| Path | Contents |
|---|---|
| `src/middleware/` | Astro middleware: session loading, CSRF/Origin check, security headers, admin gate |
| `src/lib/` | Shared library code: crypto, DB helpers, LLM helpers, sources, dedupe, email, rate limit, tz |
| `src/pages/` | Astro page components (HTML routes) |
| `src/pages/api/` | JSON API routes (see [`api-reference.md`](api-reference.md) for contracts) |
| `src/components/` | Astro UI components |
| `src/layouts/` | Page layout shells |
| `src/queue/` | Queue consumers (coordinator, chunk, finalize, cleanup) |
| `src/scripts/` | Client-side TypeScript modules (mirrored to `public/scripts/` at build time) |
| `src/styles/` | Global CSS and design tokens |
| `public/` | Static assets, manifest, runtime client-script bundles |
| `migrations/` | D1 schema migrations |
| `scripts/` | Build tooling (PWA icon generation, worker handler merge) |
| `tests/` | Vitest suites; run via `@cloudflare/vitest-pool-workers` |

## 4. Source Module Map

Every source file annotates the REQ-IDs it implements via `// Implements REQ-X-NNN` comments. The tables below summarise role; refer to source for the full contract.

### 4.1 Middleware

| Path | Role | Implements |
|---|---|---|
| `src/middleware/index.ts` | Astro middleware entry; chains the security-headers handler | [REQ-OPS-003](../sdd/observability.md#req-ops-003-security-headers-on-every-response) |
| `src/middleware/auth.ts` | `loadSession` — access JWT verify and refresh-token rotation; cookie helpers | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation), [REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection) |
| `src/middleware/origin-check.ts` | Rejects state-changing requests whose `Origin` does not match `APP_URL` | [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints) |
| `src/middleware/security-headers.ts` | Stamps CSP, HSTS, and related headers on every response | [REQ-OPS-003](../sdd/observability.md#req-ops-003-security-headers-on-every-response) |
| `src/middleware/admin-auth.ts` | Three-layer gate for `/api/admin/*` (Access JWT, session, admin email) | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) |

### 4.2 Libraries (`src/lib/`)

| Path | Role | Implements |
|---|---|---|
| `canonical-url.ts` | URL canonicalization for cross-source dedup | [REQ-GEN-004](../sdd/generation.md#req-gen-004-url-canonicalization-and-dedupe) |
| `crypto.ts` | base64url codec, constant-time HMAC compare, cookie reader | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider), [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation) |
| `db.ts` | D1 wrapper with FK pragma | (shared) |
| `email.ts` | Resend renderer and transport | [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email), [REQ-MAIL-002](../sdd/email.md#req-mail-002-non-blocking-email-failure) |
| `email-data.ts` | Per-user D1 read helpers for the email dispatcher | [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email) |
| `email-dispatch.ts` | 5-minute cron hook; per-tz two-phase D1 strategy with bucket isolation | [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email), [REQ-MAIL-002](../sdd/email.md#req-mail-002-non-blocking-email-failure) |
| `hashtags.ts` | Parse user hashtag list from JSON-encoded D1 column | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email) |
| `jwt-secret.ts` | Runtime guard rejecting `OAUTH_JWT_SECRET` shorter than 32 bytes | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation) |
| `errors.ts` | Closed `ErrorCode` enum and sanitized response builder | [REQ-OPS-002](../sdd/observability.md#req-ops-002-sanitized-error-surfaces) |
| `generate.ts` | LLM response payload extraction and JSON parsing | [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract), [REQ-PIPE-008](../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass) |
| `llm-json.ts` | Single LLM-call entrypoint with primary→fallback retry and cost accounting | [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract), [REQ-PIPE-008](../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass) |
| `headline-cache.ts` | KV-backed shared headline cache | [REQ-GEN-003](../sdd/generation.md#req-gen-003-source-fan-out-with-caching) |
| `log.ts` | Structured JSON log emitter with closed `LogEvent` enum | [REQ-OPS-001](../sdd/observability.md#req-ops-001-structured-json-logging) |
| `default-hashtags.ts` | Seed hashtag list for new accounts | [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation) |
| `models.ts` | `MODELS` catalog, default + fallback model IDs, cost estimator | [REQ-SET-004](../sdd/settings.md#req-set-004-model-selection) *(Deprecated)* |
| `oauth-providers.ts` | GitHub + Google adapters with id_token validation | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) |
| `oauth-errors.ts` | OAuth error code allowlist and sanitizer | [REQ-AUTH-004](../sdd/authentication.md#req-auth-004-oauth-error-surfacing) |
| `prompts.ts` | LLM system prompts for chunk processing, discovery, and finalize | [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract), [REQ-PIPE-008](../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass), [REQ-DISC-001](../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery) |
| `rate-limit.ts` | KV window-counter rate limiter for auth and mutation routes | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) |
| `session-jwt.ts` | HMAC-SHA256 sign/verify for the access-token JWT | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation) |
| `refresh-tokens.ts` | 30-day opaque refresh-token storage in D1 with rotation and reuse detection | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation), [REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection) |
| `slug.ts` | Deterministic ASCII slug generation | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest) |
| `sources.ts` | Source adapters (RSS/Atom/JSON) and fan-out coordinator | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) |
| `prefer-direct-source.ts` | Resolve aggregator URLs (e.g., Google News) to underlying publisher and merge tag-of-discovery state | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-canonical-url--llm-cluster-dedupe-with-first-source-wins) |
| `paragraph-split.ts` | Normalise LLM-produced prose into a paragraph array for the article-detail view | [REQ-READ-002](../sdd/reading.md#req-read-002-article-detail-view) |
| `curated-sources.ts` | Static registry of curated feeds | [REQ-PIPE-004](../sdd/generation.md#req-pipe-004-curated-source-registry-with-50-feeds-spanning-the-21-system-tags) |
| `dedupe.ts` | Canonical-URL plus LLM-cluster dedup; first-source-wins | [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-canonical-url--llm-cluster-dedupe-with-first-source-wins) |
| `finalize-merge.ts` | Pure helpers for the cross-chunk dedup finalize pass | [REQ-PIPE-008](../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass) |
| `scrape-run.ts` | `scrape_runs` lifecycle helpers (`running` → `ready` / `failed`) | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-PIPE-006](../sdd/generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress) |
| `ssrf.ts` | SSRF filter for LLM-suggested URLs | [REQ-DISC-005](../sdd/discovery.md#req-disc-005-discovery-prompt-injection-protection) |
| `article-fetch.ts` | Body-text extraction from candidate article HTML | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) |
| `concurrency.ts` | Bounded-concurrency `mapConcurrent` helper | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) |
| `json-string-array.ts` | Defensive parser for D1 columns storing `string[]` as JSON | [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email), [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation) |
| `html-text.ts` | HTML entity decode and tag-stripping for LLM prompts | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) |
| `fetch-policy.ts` | Centralised feed and article fetch timeouts and size caps | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) |
| `types.ts` | Shared cross-module TypeScript types | (shared) |
| `tz.ts` | IANA timezone helpers (local-date / local-midnight conversions) | [REQ-SET-003](../sdd/settings.md#req-set-003-scheduled-digest-time-with-timezone), [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email) |
| `optional-prop.ts` | Conditional-property spread helper for `exactOptionalPropertyTypes` | (shared) |
| `ulid.ts` | 26-char Crockford base32 ULID generator | [REQ-PIPE-006](../sdd/generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress) |
| `system-user.ts` | Sentinel user-id constants (`__system__`, `__e2e__`) | [REQ-DISC-003](../sdd/discovery.md#req-disc-003-self-healing-feed-health-tracking) |
| `title-overlap.ts` | Token-overlap alignment guard for the chunk consumer | [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract) |
| `feed-health.ts` | Per-URL fetch-health counter for the self-healing discovery loop | [REQ-DISC-003](../sdd/discovery.md#req-disc-003-self-healing-feed-health-tracking) |
| `discovery.ts` | LLM discovery pipeline and pending-discovery cron drain | [REQ-DISC-001](../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery), [REQ-DISC-005](../sdd/discovery.md#req-disc-005-discovery-prompt-injection-protection) |
| `tag-railing-flip.ts` | Shared FLIP animation helper for the tag railing | [REQ-READ-007](../sdd/reading.md#req-read-007-tag-railing-reorder-animation) |

### 4.3 Pages and API Routes

Page components (`src/pages/*.astro`) and API handlers (`src/pages/api/**.ts`) — see [`api-reference.md`](api-reference.md) for endpoint contracts (request/response shapes, status codes, auth requirements).

| Path | Role | Implements |
|---|---|---|
| `index.astro` | Public landing page; redirects authenticated users to `/digest` | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) |
| `digest.astro` | `/digest` overview grid filtered by user hashtags; empty-state when no matching articles | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-READ-005](../sdd/reading.md#req-read-005-empty-dashboard-state) |
| `digest/[id]/[slug].astro` | Article detail view with shared-element morph and read tracking | [REQ-READ-002](../sdd/reading.md#req-read-002-article-detail-view), [REQ-READ-003](../sdd/reading.md#req-read-003-read-tracking) |
| `history.astro` | `/history` — day-grouped paginated history with tag filtering | [REQ-HIST-001](../sdd/history.md#req-hist-001-day-grouped-article-history) |
| `starred.astro` | `/starred` — user's starred articles | [REQ-STAR-002](../sdd/reading.md#req-star-002-starred-articles-page) |
| `settings.astro` | `/settings` — hashtags, schedule, timezone, model, email toggle, account deletion, stuck-tag rediscovery | [REQ-SET-001](../sdd/settings.md#req-set-001-unified-first-run-and-edit-flow), [REQ-SET-005](../sdd/settings.md#req-set-005-email-notification-preference), [REQ-SET-006](../sdd/settings.md#req-set-006-settings-incomplete-gate), [REQ-SET-007](../sdd/settings.md#req-set-007-timezone-change-detection), [REQ-AUTH-005](../sdd/authentication.md#req-auth-005-account-deletion), [REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover) |
| `404.astro`, `500.astro` | Error pages (`noindex`) | [REQ-READ-006](../sdd/reading.md#req-read-006-empty-error-and-offline-pages) |
| `sitemap.xml.ts` | Dynamic sitemap (public landing only) | [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability) |

### 4.4 Layouts, Components, and Client Scripts

| Path | Role | Implements |
|---|---|---|
| `src/layouts/Base.astro` | Root HTML shell — manifest, Apple PWA meta, theme init, View Transitions | [REQ-DES-001](../sdd/design.md#req-des-001-swiss-minimal-visual-language), [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash), [REQ-PWA-001](../sdd/pwa.md#req-pwa-001-installable-pwa-manifest), [REQ-PWA-003](../sdd/pwa.md#req-pwa-003-mobile-first-responsive-layout) |
| `src/components/HeaderThemeToggle.astro` | Header theme toggle | [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash) |
| `src/components/UserMenu.astro` | Avatar dropdown — theme, history, settings, starred, log out | [REQ-PWA-003](../sdd/pwa.md#req-pwa-003-mobile-first-responsive-layout), [REQ-STAR-003](../sdd/reading.md#req-star-003-starred-entry-in-the-user-menu) |
| `src/components/InstallPrompt.astro` | PWA install prompt (Android `beforeinstallprompt`, iOS share-icon note) | [REQ-PWA-001](../sdd/pwa.md#req-pwa-001-installable-pwa-manifest) |
| `src/components/TagStrip.astro` | Shared tag-railing component | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-READ-007](../sdd/reading.md#req-read-007-tag-railing-reorder-animation) |
| `src/components/DigestCard.astro` | Article card for the digest grid | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-STAR-001](../sdd/reading.md#req-star-001-star-and-unstar-articles) |
| `src/components/AltSourcesModal.astro` | Modal listing alternative sources for an article | [REQ-READ-002](../sdd/reading.md#req-read-002-article-detail-view) |
| `src/components/StatsWidget.astro` | Four-tile stats widget | [REQ-HIST-002](../sdd/history.md#req-hist-002-user-stats-widget) |
| `src/scripts/page-effects.ts` | Layout-level client behaviour (tz sync, scroll restore, brand-link, view transitions, single-named-group card promotion). Mirrored to `public/scripts/page-effects.js` (CSP requires external bundles) | [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash), [REQ-DES-003](../sdd/design.md#req-des-003-deliberate-motion-system), [REQ-PWA-003](../sdd/pwa.md#req-pwa-003-mobile-first-responsive-layout), [REQ-READ-002](../sdd/reading.md#req-read-002-article-detail-view), [REQ-SET-007](../sdd/settings.md#req-set-007-timezone-change-detection) |
| `src/scripts/article-detail.ts` | Star toggle and history-aware back arrow on the article page | [REQ-STAR-001](../sdd/reading.md#req-star-001-star-and-unstar-articles), [REQ-READ-002](../sdd/reading.md#req-read-002-article-detail-view) |
| `src/scripts/card-interactions.ts` | Star toggle and tag-disclosure popover bindings on dashboard cards | [REQ-STAR-001](../sdd/reading.md#req-star-001-star-and-unstar-articles), [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest) |
| `src/scripts/install-prompt.ts` | PWA install-prompt bindings | [REQ-PWA-001](../sdd/pwa.md#req-pwa-001-installable-pwa-manifest) |
| `src/scripts/theme-toggle.ts` | Theme toggle and meta-tag updates | [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash) |
| `src/styles/global.css` | Design tokens, type scale, focus ring, motion system | [REQ-DES-001](../sdd/design.md#req-des-001-swiss-minimal-visual-language), [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash), [REQ-DES-003](../sdd/design.md#req-des-003-deliberate-motion-system) |

### 4.5 Worker, Queue, and Migrations

| Path | Role | Implements |
|---|---|---|
| `src/worker.ts` | Cron + queue dispatch entry — three cron branches, four queue message types | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-PIPE-005](../sdd/generation.md#req-pipe-005-fourteen-day-retention-with-starred-exempt-cleanup), [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email) |
| `src/queue/scrape-coordinator.ts` | Fan-out, freshness filter, eviction pass, chunk dispatch | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-DISC-003](../sdd/discovery.md#req-disc-003-self-healing-feed-health-tracking) |
| `src/queue/scrape-chunk-consumer.ts` | Per-chunk LLM call, dedup, atomic completion gate, finalize handoff | [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract), [REQ-PIPE-008](../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass) |
| `src/queue/scrape-finalize-consumer.ts` | Cross-chunk semantic dedup pass over the tick's surviving articles | [REQ-PIPE-008](../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass) |
| `src/queue/cleanup.ts` | Daily 3-pass cleanup: retention, stuck-tag prune, orphan-tag KV sweep | [REQ-PIPE-005](../sdd/generation.md#req-pipe-005-fourteen-day-retention-with-starred-exempt-cleanup), [REQ-DISC-006](../sdd/discovery.md#req-disc-006-stuck-tag-retention), [REQ-PIPE-007](../sdd/generation.md#req-pipe-007-orphan-tag-source-cleanup) |
| `migrations/0001_initial.sql` | Initial schema | (foundational) |
| `migrations/0002_article_tags.sql` | Article tag columns | (schema) |
| `migrations/0003_global_feed.sql` | Global-feed rework — articles, tags, sources, stars, reads, scrape_runs | (foundational) |
| `migrations/0004_system_user.sql` | `__system__` sentinel user | (schema) |
| `migrations/0005_auth_links.sql` | Cross-provider account dedup table | [REQ-AUTH-007](../sdd/authentication.md#req-auth-007-cross-provider-account-dedup) |
| `migrations/0006_e2e_user.sql` | `__e2e__` sentinel user | (schema) |
| `migrations/0007_scrape_chunk_completions.sql` | Atomic chunk-completion tracking table | [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract) |
| `migrations/0008_scrape_runs_finalize_lock.sql` | Atomic finalize-enqueue gate column | [REQ-PIPE-008](../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass) |

## 5. Request Lifecycles

### 5.1 Global-feed pipeline (every 4 hours)

```
Cron (00/04/08/12/16/20 UTC)
  └─► SCRAPE_COORDINATOR queued
       │
       ▼
Coordinator
  ├─ Fan out {tag × source} pairs (concurrency 10)
  ├─ Record per-URL fetch outcome → KV source_health:{url}
  ├─ Evict discovered URLs at 30 consecutive failures
  │  └─ If tag's feed list empties, queue rediscovery (user_id='__system__')
  ├─ Drop candidates older than 48 h; keep undated candidates
  ├─ Canonical-URL dedup across all candidates
  └─ Chunk → enqueue one SCRAPE_CHUNK per chunk
       │
       ▼
Chunk consumer (per chunk)
  ├─ Fetch article bodies for short-snippet candidates (concurrency 20)
  ├─ Single Workers AI call (default model gpt-oss-20b, fallback gpt-oss-120b)
  ├─ Align LLM output to inputs by echoed index (positional fallback)
  ├─ Filter LLM tags against the system-approved allowlist
  ├─ LLM-cluster + canonical-URL dedup (first-source-wins)
  ├─ INSERT articles, alt_sources, tags, scrape_run counters (D1 batch)
  ├─ Atomic completion gate:
  │    INSERT OR IGNORE scrape_chunk_completions
  │    SELECT COUNT(*) FROM scrape_chunk_completions WHERE scrape_run_id = ?
  └─ When count == total_chunks, the consumer that wins
       UPDATE scrape_runs SET finalize_enqueued = 1
              WHERE id = ? AND finalize_enqueued = 0
     stamps the run `ready` and enqueues SCRAPE_FINALIZE
       │
       ▼
Finalize consumer
  ├─ Skip when ≤ 1 article (finalize_noop)
  ├─ Single Workers AI call over title+source+pub-ts list
  └─ Per dedup group (size ≥ 2): merge losers into earliest-pub-ts winner
     via 6-statement D1 batch (alt sources, tags, stars, reads, then DELETE)
```

### 5.2 Operator force-refresh

Implements [REQ-OPS-005](../sdd/observability.md#req-ops-005-admin-force-refresh-endpoint).

```
POST /api/admin/force-refresh   (or GET, gated by Cloudflare Access)
  └─ If a 'running' scrape_runs row is < 120 s old: reuse run_id
     Otherwise: INSERT scrape_runs, send SCRAPE_COORDINATOR
  └─ POST → 303 /settings?force_refresh={ok|reused}&run_id={ulid}
     GET (Accept: application/json) → 200 { ok, scrape_run_id, reused }
```

### 5.3 Daily retention (03:00 UTC)

```
Cron daily 03:00 UTC
  ├─ Pass 1 — Article retention
  │   DELETE articles WHERE published_at < now-14d AND NOT starred by any user
  │   FK cascade: alt sources, tag rows, read marks
  ├─ Pass 2 — Stuck-tag prune
  │   For each sources:{tag} entry with feeds:[] AND discovered_at < now-7d
  │   remove that tag from every user's hashtags_json
  └─ Pass 3 — Orphan-tag KV sweep
      DELETE sources:{tag} and discovery_failures:{tag} for tags no user owns
```

### 5.4 Email dispatcher (every 5 minutes)

```
Cron every 5 minutes
  ├─ DISTINCT-tz probe: SELECT DISTINCT tz FROM users WHERE email_enabled=1
  └─ For each tz bucket:
       ├─ Skip if tz fails isValidTz check
       ├─ SELECT users in this tz inside the current 5-minute digest window
       └─ For each user:
            ├─ Fetch headlines + tag tally via Promise.allSettled
            ├─ Skip if headlines.length == 0 (no email, no last_emailed stamp)
            └─ Render email, send via Resend, stamp last_emailed_local_date
```

## 6. Data Flow

Articles are the central entity in the global pool. Each article belongs to a `scrape_runs` tick, not to a user. Users read from the pool by filtering on their active hashtags. Foreign keys cascade on delete. Starred articles are user-scoped and exempt from the 14-day retention cleanup.

`pending_discoveries` rows are per-user, but the discovery results themselves (`sources:{tag}` in KV) are globally shared so multiple users benefit from a single discovery run. The coordinator may insert system-owned rows (`user_id = '__system__'`) when a feed eviction empties a tag's source list — real-user queries scoped `WHERE user_id = ?` naturally exclude these.

## 7. Cross-cutting Concerns

| Concern | Mechanism | Detail |
|---|---|---|
| Authentication | 5-minute access JWT + 30-day rotating refresh token | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation), [REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection) |
| CSRF defence | `Origin` header check on every state-changing request | [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints) |
| Rate limiting | KV window-counter, applied to auth and mutation routes | `src/lib/rate-limit.ts` |
| Security headers | CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` | [REQ-OPS-003](../sdd/observability.md#req-ops-003-security-headers-on-every-response) |
| Observability | Structured JSON logs via closed `LogEvent` enum | [REQ-OPS-001](../sdd/observability.md#req-ops-001-structured-json-logging) |
| Error surfaces | Closed `ErrorCode` enum, sanitised user-facing messages | [REQ-OPS-002](../sdd/observability.md#req-ops-002-sanitized-error-surfaces) |
| Admin gate | Cloudflare Access JWT + session + `ADMIN_EMAIL` match | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) |

## 8. Build and Deploy

PWA icons render from `public/icons/app-icon.svg` via `scripts/generate-pwa-icons.mjs` (192×192 and 512×512 PNGs, regenerated on every build). Astro produces `dist/_worker.js/index.js`; `scripts/merge-worker-handlers.mjs` post-processes by bundling `src/worker.ts` and writing `dist/_worker.js/_merged.mjs`, which Wrangler deploys. See [`deployment.md`](deployment.md) for the full pipeline.

**Page-script CSP gotcha.** The site CSP is `script-src 'self'`, which blocks every inline `<script>...</script>` block. Astro inlines page-level `<script>` blocks that contain no `import` statement, so any such block is silently dropped at runtime. The pattern: put the script body in `src/scripts/<module>.ts` and import it from a `<script> import '~/scripts/<module>'; </script>` block — Astro then emits the code as an external `<script type="module" src="/_astro/...js">` bundle that CSP allows.

---

## Related Documentation

- [`api-reference.md`](api-reference.md) — Endpoint contracts
- [`configuration.md`](configuration.md) — Env vars, secrets, bindings
- [`deployment.md`](deployment.md) — Local development and production deployment
- [`decisions/README.md`](decisions/README.md) — Architecture Decision Records
- [`../sdd/`](../sdd/) — Product specification (REQs, ACs, status)
