# Architecture

System overview, component map, and request lifecycles for `news-digest`.

**Audience:** Developers, Operators

This document describes **what** the system is and **how requests flow through it**. Implementation rationale ("why this code looks the way it does") lives in source comments. Endpoint contracts live in [`api-reference.md`](api-reference.md). Environment and bindings live in [`configuration.md`](configuration.md). Architectural decisions live in [`decisions/README.md`](decisions/README.md). Product intent lives in [`sdd/`](../sdd/).

---

## 1. Overview

`news-digest` is a single Cloudflare Worker serving an Astro-rendered web app. A 4-hour scrape run scrapes a curated set of RSS/Atom/JSON feeds, summarises new candidates with Workers AI, and writes them to the shared **article pool**. Per-user dashboards filter the pool by the user's hashtags — there are no per-user LLM calls. A 5-minute cron drains pending feed-discovery jobs and dispatches daily digest emails. A 03:00 UTC cron purges articles older than 14 days (starred articles exempt).

<!-- doc-allow-large: irreducible architecture diagram, no source to link to -->
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

Implements [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history).

## 2. Components

| Component | Role |
|---|---|
| Astro Worker | Serves all HTML pages and JSON APIs in the Cloudflare Workers runtime |
| Cron Triggers | 5-minute (discovery + email dispatch), 4-hour (scrape), daily 03:00 UTC (retention) |
| Queue Consumers | `SCRAPE_COORDINATOR`, `SCRAPE_CHUNKS`, `SCRAPE_FINALIZE`, cleanup |
| D1 | Strongly-consistent storage: users, articles, scrape_runs, refresh_tokens, pending_discoveries |
| KV | Edge-cached `sources:{tag}`, headline cache, per-URL fetch-health counters, rate-limit counters |
| Workers AI | LLM inference for chunk summarisation and source discovery; bge-base-en-v1.5 embeddings for same-story dedup |
| Vectorize | 768-dim cosine index over every surviving article's embedding; queried per article on ingest and on operator-driven historical sweeps |
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
| `src/middleware/admin-auth.ts` | Admin gate for `/api/admin/*`. Baseline: valid session cookie + `ADMIN_EMAIL` match (case-insensitive). Optional Layer 0 (AD29): when `CF_ACCESS_AUD` is set, the request must additionally carry a Cloudflare Access assertion whose `aud` claim matches the configured value. | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8 |

### 4.2 Libraries (`src/lib/`)

| Path | Role | Implements |
|---|---|---|
| `canonical-url.ts` | URL canonicalization for cross-source dedup | [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history) |
| `crypto.ts` | base64url codec, constant-time HMAC compare, cookie reader | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider), [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation) |
| `db.ts` | D1 wrapper with FK pragma | (shared) |
| `email.ts` | Resend renderer and transport | [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email), [REQ-MAIL-002](../sdd/email.md#req-mail-002-non-blocking-email-failure) |
| `email-html.ts` | Typed HTML builders for the digest email renderer — centralises `escapeHtml` and `headlineRow` so every interpolated value is escaped by default | [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email) |
| `email-data.ts` | Per-user D1 read helpers for the email dispatcher | [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email) |
| `email-dispatch.ts` | 5-minute cron hook; per-tz two-phase D1 strategy with bucket isolation | [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email), [REQ-MAIL-002](../sdd/email.md#req-mail-002-non-blocking-email-failure) |
| `hashtags.ts` | Parse user hashtag list from JSON-encoded D1 column | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest), [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email) |
| `jwt-secret.ts` | Runtime guard rejecting `OAUTH_JWT_SECRET` shorter than 32 bytes | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation) |
| `errors.ts` | Closed `ErrorCode` enum and sanitized response builder | [REQ-OPS-002](../sdd/observability.md#req-ops-002-sanitized-error-surfaces) |
| `generate.ts` | LLM response payload extraction and JSON parsing | [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract) |
| `llm-json.ts` | Single LLM-call entrypoint (single-model architecture, 2026-05-06 — fallback path removed); runs `DEFAULT_MODEL_ID` once per call; centralises token-cost accounting | [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract) |
| `headline-cache.ts` | KV-backed shared headline cache | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) |
| `log.ts` | Structured JSON log emitter with closed `LogEvent` enum | [REQ-OPS-001](../sdd/observability.md#req-ops-001-structured-json-logging) |
| `default-hashtags.ts` | Seed hashtag list for new accounts | [REQ-SET-002](../sdd/settings.md#req-set-002-hashtag-curation) |
| `models.ts` | `MODELS` catalog, `DEFAULT_MODEL_ID` (`@cf/openai/gpt-oss-120b`), cost estimator (cost accounting still live for chunk + discovery LLM calls; per-user model selection *Deprecated 2026-04-23 with REQ-SET-004*) | [REQ-PIPE-006](../sdd/generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress) |
| `oauth-providers.ts` | GitHub + Google adapters with id_token validation | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) |
| `oauth-errors.ts` | OAuth error code allowlist and sanitizer | [REQ-AUTH-004](../sdd/authentication.md#req-auth-004-oauth-error-surfacing) |
| `prompts.ts` | LLM system prompts for chunk processing and source discovery (the finalize-pass dedup prompt was removed when REQ-PIPE-003 replaced LLM dedup with embedding-based same-story matching) | [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract), [REQ-DISC-001](../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery) |
| `rate-limit.ts` | KV window-counter rate limiter for auth routes, mutation routes, and authenticated polling endpoints | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9 |
| `session-jwt.ts` | HMAC-SHA256 sign/verify for the access-token JWT | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation) |
| `refresh-tokens.ts` | 30-day opaque refresh-token storage in D1 with rotation and reuse detection | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation), [REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection) |
| `digest-today.ts` | Dashboard payload loader (`loadTodayPayload`) and next-cron-tick calculator (`computeNextScrapeAt`); factored out of the API route so server-rendered pages call it directly without cross-module route imports | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest) |
| `slug.ts` | Deterministic ASCII slug generation | [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest) |
| `sources.ts` | Source adapters (RSS/Atom/JSON) and fan-out coordinator; `itemToHeadline` applies a per-item `<source>` element override so Google News items carry the underlying publisher name (e.g. "Help Net Security") rather than the feed-level adapter label | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) |
| `prefer-direct-source.ts` | Resolve aggregator URLs (e.g., Google News) to underlying publisher and merge tag-of-discovery state | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history) |
| `paragraph-split.ts` | Normalise LLM-produced prose into a paragraph array for the article-detail view | [REQ-READ-002](../sdd/reading.md#req-read-002-article-detail-view) |
| `curated-sources.ts` | Static registry of curated feeds; exports `googleNewsSourceForTag` (per-tag GN query-RSS synthesis) and `hasCuratedGoogleNews` (skip-guard for the coordinator baseline pass) | [REQ-PIPE-004](../sdd/generation.md#req-pipe-004-curated-source-registry-with-50-feeds-spanning-the-21-system-tags), [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) AC 9 |
| `dedupe.ts` | Canonical-URL clustering (first pass over a chunk's candidates) | [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history) |
| `embeddings.ts` | bge-base-en-v1.5 embedding helpers: input builder (title + body, length-capped), cosine similarity, threshold parser, batch caller for the AI binding | [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history) |
| `finalize-merge.ts` | `pickWinner`, `buildMergeStatements`, and `mergeAsAltSource` (existing-article-wins variant used by the semantic-dedup pass and the historical re-run sweep) | [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history) |
| `scrape-run.ts` | `scrape_runs` lifecycle helpers (`running` → `ready` / `failed`) | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-PIPE-006](../sdd/generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress) |
| `ssrf.ts` | SSRF denylist filter — rejects non-HTTPS, private, loopback, link-local, CGNAT, and metadata-host destinations; used by both discovery URL validation and article body fetching | [REQ-DISC-005](../sdd/discovery.md#req-disc-005-discovery-prompt-injection-protection), [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) |
| `safe-href.ts` | Render-time https-scheme guard for `href` attributes; returns `'#'` for any non-https or unparseable URL from D1 (CF-021 render-time defense-in-depth) | [REQ-DISC-005](../sdd/discovery.md#req-disc-005-discovery-prompt-injection-protection) |
| `article-fetch.ts` | Body-text extraction from candidate article HTML | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) |
| `articles-repo.ts` | Repository layer for the `articles` table: batched `canonical_url` IN-clause lookups (CF-004 consolidation); future chunk-consumer SQL extractions will land here (CF-027) | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) |
| `concurrency.ts` | Bounded-concurrency `mapConcurrent` helper | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) |
| `queue-handler.ts` | Shared queue-batch envelope: per-message try/ack/retry loop driven by `env.QUEUE_MAX_RETRIES` (set in `wrangler.toml [vars]`), optional terminal-failure hook (CF-007) | (shared infrastructure) |
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
| `kv/chunks-remaining.ts` | KV writer for the `scrape_run:{id}:chunks_remaining` display mirror — wraps `KV.put`/`delete` so the coordinator hot path doesn't inline raw KV calls (per [AD27](decisions/README.md#ad27-all-kv-writers-route-through-srclibkvfamilyts-helpers)) | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) |
| `kv/discovery-failures.ts` | KV writer for the discovery failure-counter family (per [AD27](decisions/README.md#ad27-all-kv-writers-route-through-srclibkvfamilyts-helpers)) | [REQ-DISC-001](../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery) |
| `discovery.ts` | LLM discovery pipeline and pending-discovery cron drain. Tags covered by the curated registry short-circuit both the user-facing queue and the cron drain — see `hasCuratedSource` in `curated-sources.ts`. The discovery LLM's legacy Google News fallback (written once to `sources:{tag}` KV) is transitionally redundant now that the coordinator owns per-tag GN synthesis (AD31); until the discovery prompt is retrained, both paths coexist. | [REQ-DISC-001](../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery), [REQ-DISC-005](../sdd/discovery.md#req-disc-005-discovery-prompt-injection-protection) |
| `tag-railing-flip.ts` | Shared FLIP animation helper for the tag railing | [REQ-READ-007](../sdd/reading.md#req-read-007-tag-railing-reorder-animation) |
| `json-ld.ts` | Safe JSON-LD serializer for `<script type="application/ld+json">` blocks — rewrites every `<`, `>`, and `&` byte to its `\uNNNN` JSON form, defeating all HTML state-transition vectors that could escape the script block | [REQ-OPS-004](../sdd/observability.md#req-ops-004-crawler-policy-and-public-surface-discoverability) AC 6 |

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
| `src/scripts/article-detail.ts` | History-aware back arrow on the article page (star toggle moved to `card-interactions.ts` delegation) | [REQ-READ-002](../sdd/reading.md#req-read-002-article-detail-view) |
| `src/scripts/alt-sources-modal.ts` | Alt-source picker open/close and responsive desktop anchor (positions below trigger on ≥768 px viewports, centred on mobile). Mirrored to `public/scripts/alt-sources-modal.js` (CSP requires external bundles) | [REQ-READ-002](../sdd/reading.md#req-read-002-article-detail-view) |
| `src/scripts/card-interactions.ts` | Document-level star-toggle delegation (covers `/digest`, `/starred`, `/history`, and article-detail header) plus tag-disclosure popover bindings. Mirrored to `public/scripts/card-interactions.js` and loaded layout-wide via `Base.astro` (CSP blocks the inline Astro bundle that would otherwise be emitted per-page) | [REQ-STAR-001](../sdd/reading.md#req-star-001-star-and-unstar-articles), [REQ-READ-001](../sdd/reading.md#req-read-001-overview-grid-of-todays-digest) |
| `src/scripts/install-prompt.ts` | PWA install-prompt bindings | [REQ-PWA-001](../sdd/pwa.md#req-pwa-001-installable-pwa-manifest) |
| `src/scripts/theme-toggle.ts` | Theme toggle and meta-tag updates | [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash) |
| `src/styles/global.css` | Design tokens, type scale, focus ring, motion system | [REQ-DES-001](../sdd/design.md#req-des-001-swiss-minimal-visual-language), [REQ-DES-002](../sdd/design.md#req-des-002-light-and-dark-mode-with-no-flash), [REQ-DES-003](../sdd/design.md#req-des-003-deliberate-motion-system) |

### 4.5 Worker, Queue, and Migrations

| Path | Role | Implements |
|---|---|---|
| `src/worker.ts` | Cron + queue dispatch entry — three cron branches, four queue message types. The queue dispatcher normalises `batch.queue` by stripping a recognised env suffix (`-integration` / `-staging`) before the switch, so the same handler routes both production and integration queue messages. | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-PIPE-005](../sdd/generation.md#req-pipe-005-fourteen-day-retention-with-starred-exempt-cleanup), [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email) |
| `src/queue/scrape-coordinator.ts` | Fan-out, freshness filter, eviction pass, multi-source aggregation on re-discovery, per-tag Google News baseline synthesis (REQ-PIPE-001 AC 9), chunk dispatch | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-DISC-003](../sdd/discovery.md#req-disc-003-self-healing-feed-health-tracking) |
| `src/queue/scrape-chunk-consumer.ts` | Per-chunk LLM call (summarisation only), canonical-URL dedup within chunk, embedding generation via `embeddings.ts`, D1 batch insert (writes `embedding_status='embedded'` and `embedded_at`), Vectorize upsert post-batch, atomic completion gate, finalize handoff | [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract), [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history) |
| `src/queue/scrape-finalize-consumer.ts` | Same-story dedupe pass: per-article `VECTORIZE.queryById` (top-K=5), filter matches by cosine threshold + older `published_at`, pick the oldest qualifying match, call `mergeAsAltSource` to fold the new article into the existing one, then `VECTORIZE.deleteByIds` for the merged-away ids. Upfront SELECT short-circuits redelivery before any Vectorize calls when `finalize_recorded` is already set; atomic gate (migration 0010) holds the no-double-count invariant on retries. | [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history) |
| `src/queue/cleanup.ts` | Daily 3-pass cleanup: retention, stuck-tag prune, orphan-tag KV sweep | [REQ-PIPE-005](../sdd/generation.md#req-pipe-005-fourteen-day-retention-with-starred-exempt-cleanup), [REQ-DISC-006](../sdd/discovery.md#req-disc-006-stuck-tag-retention), [REQ-PIPE-007](../sdd/generation.md#req-pipe-007-orphan-tag-source-cleanup) |
| `migrations/0001_initial.sql` | Pre-launch initial schema. Creates `users`, which 0003's article_stars / article_reads tables reference via FK; replaying 0003 against an empty schema fails at FK declaration without it | (FK base) |
| `migrations/0002_article_tags.sql` | Pre-launch `ALTER TABLE articles ADD COLUMN tags_json`; depends on 0001's `articles` table existing first | (FK base) |
| `migrations/0003_global_feed.sql` | Global-feed rework — DROPs pre-launch tables and recreates the canonical schema: articles, tags, sources, stars, reads, scrape_runs (gains `chunk_count`, `finalize_enqueued` via 0008, `finalize_recorded` via 0010 in later migrations) | (foundational) |
| `migrations/0004_system_user.sql` | `__system__` sentinel user | (schema) |
| `migrations/0005_auth_links.sql` | Cross-provider account dedup table | [REQ-AUTH-007](../sdd/authentication.md#req-auth-007-cross-provider-account-dedup) |
| `migrations/0006_e2e_user.sql` | `__e2e__` sentinel user | (schema) |
| `migrations/0007_scrape_chunk_completions.sql` | Atomic chunk-completion tracking table | [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract) |
| `migrations/0008_scrape_runs_finalize_lock.sql` | Atomic finalize-enqueue gate column — the closing chunk consumer wins this gate to enqueue exactly one finalize message per run | [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history) |
| `migrations/0009_refresh_tokens.sql` | `refresh_tokens` table for the access/refresh-token split (30-day opaque token with rotation chain and reuse-detection) | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation), [REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection) |
| `migrations/0010_scrape_runs_finalize_recorded.sql` | `finalize_recorded` gate column — atomic idempotency for finalize-pass run-once invariant; the column is now load-bearing for the semantic-dedup pass instead of LLM-cost recording (the LLM call is gone). | [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history) |
| `migrations/0011_article_embeddings.sql` | `embedding_status` (NULL / `'embedded'` / `'failed'`) and `embedded_at` columns on `articles`. NULL is the never-attempted state (set by the migration on existing rows and used by the chunk consumer when the embed call throws before D1 insert); the chunk consumer stamps `'embedded'` after a successful Vectorize upsert; `'failed'` is set when a post-insert Vectorize upsert errors. The admin embed-backfill route picks up rows with NULL or `'failed'` status. | [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history) |

## 5. Request Lifecycles

### 5.1 Global-feed pipeline (every 4 hours)

<!-- doc-allow-large: irreducible pipeline-flow diagram, load-bearing ASCII art -->
```
Cron (00/04/08/12/16/20 UTC)
  └─► SCRAPE_COORDINATOR queued
       │
       ▼
Coordinator
  ├─ Synthesise per-tag Google News query-RSS source for every tag in
  │  (default-seed ∪ curated ∪ discovered KV); skip tags with a bespoke
  │  hand-tuned GN curated entry (REQ-PIPE-001 AC 9)
  ├─ Fan out {tag × source} pairs (concurrency 10)
  ├─ Record per-URL fetch outcome → KV source_health:{url}
  ├─ Evict URLs at 30 consecutive failures; re-queue discovery if feed list empties
  ├─ Drop candidates older than 48 h; keep undated candidates
  ├─ Canonical-URL dedup across all candidates
  ├─ Re-seen URLs: INSERT OR IGNORE new sources into article_sources (multi-source aggregation);
  │  ingested_at and primary attribution are NOT re-stamped (first-ingestion preserved)
  └─ Chunk → enqueue one SCRAPE_CHUNK per chunk
       │
       ▼
Chunk consumer (per chunk)
  ├─ Fetch article bodies for short-snippet candidates (concurrency 20)
  ├─ Single Workers AI call; align output to inputs by echoed index
  ├─ Filter LLM tags against system-approved allowlist
  ├─ Canonical-URL dedup within chunk (first-source-wins)
  ├─ Build embedding inputs (title + body, length-capped)
  ├─ Single Workers AI call to bge-base-en-v1.5 → vectors
  ├─ INSERT articles (with embedding_status='embedded'), alt_sources, tags, scrape_run counters (D1 batch)
  ├─ VECTORIZE.upsert(id, vector, {published_at, primary_source_url}); on failure UPDATE row to embedding_status='failed'
  └─ Atomic completion gate (D1 — see AD7): last chunk stamps run `ready`,
     enqueues SCRAPE_FINALIZE
       │
       ▼
Finalize consumer (semantic same-story dedupe)
  ├─ Skip when ≤ 1 article in the run (finalize_noop)
  ├─ SELECT finalize_recorded upfront — if already 1, skip before any Vectorize call
  ├─ For each article in the run:
  │   ├─ VECTORIZE.queryById(self.id, topK=5, returnMetadata='all')
  │   ├─ Filter matches: id != self.id, score >= DEDUP_COSINE_THRESHOLD, metadata.published_at < self.published_at
  │   ├─ Existence guard: SELECT 1 FROM articles WHERE id = ? — drop matches whose D1 row is gone (stale-vector race)
  │   └─ If any qualify: pick the OLDEST by metadata.published_at; mergeAsAltSource(db, oldestId, self.id)
  ├─ D1.batch the accumulated merge statements
  ├─ VECTORIZE.deleteByIds(merged-away ids)
  └─ Atomic gate: UPDATE scrape_runs SET finalize_recorded=1 … WHERE finalize_recorded=0
```

### 5.2 Operator force-refresh

Implements [REQ-OPS-005](../sdd/observability.md#req-ops-005-admin-force-refresh-endpoint). The endpoint reuses an in-progress run when one exists within the last two minutes; otherwise it starts a fresh coordinator dispatch — same data flow as the 4-hour cron. See [`api-reference.md — POST /api/admin/force-refresh`](api-reference.md#post-apiadminforce-refresh-also-get) for the full request/response contract.

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

Articles are the central entity in the article pool. Each article belongs to a `scrape_runs` row (one row per scrape run), not to a user. Users read from the pool by filtering on their active hashtags. Foreign keys cascade on delete. Starred articles are user-scoped and exempt from the 14-day retention cleanup.

`pending_discoveries` rows are per-user, but the discovery results themselves (`sources:{tag}` in KV) are globally shared so multiple users benefit from a single discovery run. The coordinator may insert system-owned rows (`user_id = '__system__'`) when a feed eviction empties a tag's source list — real-user queries scoped `WHERE user_id = ?` naturally exclude these.

## 7. Cross-cutting Concerns

| Concern | Mechanism | Detail |
|---|---|---|
| Authentication | 5-minute access JWT + 30-day rotating refresh token | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation), [REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection) |
| CSRF defence | `Origin` header check on every state-changing request | [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints) |
| Rate limiting | KV window-counter, applied to auth routes, mutation routes, and authenticated polling endpoints | `src/lib/rate-limit.ts`, [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9 |
| Security headers | CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options` | [REQ-OPS-003](../sdd/observability.md#req-ops-003-security-headers-on-every-response) |
| Observability | Structured JSON logs via closed `LogEvent` enum | [REQ-OPS-001](../sdd/observability.md#req-ops-001-structured-json-logging) |
| Error surfaces | Closed `ErrorCode` enum, sanitised user-facing messages | [REQ-OPS-002](../sdd/observability.md#req-ops-002-sanitized-error-surfaces) |
| Admin gate | Worker-side baseline: signed-in session + `ADMIN_EMAIL` match. Optional perimeter when `CF_ACCESS_AUD` is set: Cloudflare Access assertion + `aud` claim match (AD29 + AD30). | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8 |

## 8. Build and Deploy

PWA icons render from `public/icons/app-icon.svg` via `scripts/generate-pwa-icons.mjs` (192×192 and 512×512 PNGs, regenerated on every build). Astro produces `dist/_worker.js/index.js`; `scripts/merge-worker-handlers.mjs` post-processes by bundling `src/worker.ts` and writing `dist/_worker.js/_merged.mjs`, which Wrangler deploys. See [`deployment.md`](deployment.md) for the full pipeline.

### Client-script convention

The site CSP is `script-src 'self'`, which blocks every inline `<script>...</script>` block. Astro inlines page-level `<script>` blocks that contain no `import` statement, so a script written without an import is silently dropped at runtime.

**Pattern A — Astro-bundled (lives under `src/scripts/bundled/`):** the script is imported from an Astro component or page, and Astro/Vite bundles it into the page's hashed JS:

```astro
<script>import { toggleTheme } from '~/scripts/bundled/<module>';</script>
```

Astro emits the code as an external `<script type="module" src="/_astro/...js">` bundle that CSP allows. New Pattern A files go directly under `src/scripts/bundled/`; the build script ignores that subdirectory.

**Pattern B — static mirror (lives at `src/scripts/<module>.ts`):** for scripts that must run on every page regardless of which Astro page initiated the navigation (e.g., `card-interactions.ts` running on `/digest`, `/history`, and `/starred`), the build script compiles the TypeScript into `public/scripts/<module>.js` and the layout loads it directly:

```astro
<script is:inline type="module" src="/scripts/<module>.js"></script>
```

The `is:inline` attribute prevents Astro from re-bundling the file. `scripts/build-client-scripts.mjs` rebuilds every Pattern B file on every `npm run build`, so the mirror cannot drift from its source. Scripts currently using this pattern: `page-effects.js`, `card-interactions.js`, `alt-sources-modal.js`, `install-prompt.js`, `offline.js`, `rate-limited.js`, `article-detail.js`. (`tag-railing-flip.ts` is the lib helper imported via Pattern A — see line 138 — not a Pattern B script.)

Replaces the prior hand-maintained `SKIP` set in `build-client-scripts.mjs` (CF-023).

**Critical constraint:** a Pattern B script MUST NOT also be statically imported by any Astro page or component. Doing so causes Vite to bundle the entire module — including its auto-wire IIFE — into the page's `_astro/*.js` chunk. Both module instances share `document` but have independent closure state, so any listener-idempotency flag in module scope fails to deduplicate across the two evaluations. Idempotency tokens for scripts in this situation must live on `window`. See [AD20](decisions/README.md#ad20-idempotency-tokens-for-client-scripts-loaded-both-as-pattern-b-iife-and-via-page-level-import-must-live-on-window) for the full decision record and the CI gate that enforces this constraint.

---

## Design System Tokens (REQ-DES-001, REQ-DES-003)

CSS custom properties declared in `src/styles/global.css` and consumed throughout the component tree.

### Type scale

| Token | Value | Usage |
|-------|-------|-------|
| `--text-xs` | 12 px | Captions, metadata |
| `--text-sm` | 14 px | Secondary body, labels |
| `--text-base` | 16 px | Primary body |
| `--text-lg` | 20 px | Card titles, section headers |
| `--text-2xl` | 32 px | Display (article detail heading) |

Font stacks: sans `(-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif)` for body/UI; serif `(Charter, "Iowan Old Style", Georgia, "Noto Serif", "Source Serif Pro", serif)` for article titles. No webfont download.

Weights: 400 (body), 600 (headings and labels).

### Motion tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | All transitions |
| `--duration-fast` | 150 ms | Micro-interactions (hover, press) |
| `--duration-base` | 250 ms | Component transitions, View Transitions |
| `--duration-slow` | 400 ms | Page-level transitions |

---

## Related Documentation

- [`api-reference.md`](api-reference.md) — Endpoint contracts
- [`configuration.md`](configuration.md) — Env vars, secrets, bindings
- [`deployment.md`](deployment.md) — Local development and production deployment
- [`decisions/README.md`](decisions/README.md) — Architecture Decision Records
- [`../sdd/`](../sdd/) — Product specification (REQs, ACs, status)
