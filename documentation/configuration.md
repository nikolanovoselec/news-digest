# Configuration

**Audience:** Operators, Developers

Environment variables, secrets, and platform bindings required to run the system.

## Contents

- [Worker Secrets](#worker-secrets)
- [GitHub Actions Secrets (CI deploy only)](#github-actions-secrets-ci-deploy-only)
- [Platform Bindings](#platform-bindings)
- [Worker Vars (non-secret)](#worker-vars-non-secret)
- [Cron](#cron)
- [KV Key Conventions](#kv-key-conventions)
- [Compatibility](#compatibility)
- [Observability](#observability)
- [Security Headers](#security-headers)
- [Configuration Files](#configuration-files)
- [Related Documentation](#related-documentation)

---

## Worker Secrets

Stored via `wrangler secret put <name>`. Never committed to git.

| Variable | Required | Default | Consumed by | Implements |
|---|---|---|---|---|
| `GH_OAUTH_CLIENT_ID` | Conditional (one OAuth pair required) | none | `src/pages/api/auth/[provider]/login.ts`, `callback.ts` | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) |
| `GH_OAUTH_CLIENT_SECRET` | Conditional (when `GH_OAUTH_CLIENT_ID` set) | none | `src/pages/api/auth/[provider]/callback.ts` | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) |
| `GOOGLE_OAUTH_CLIENT_ID` | Conditional (one OAuth pair required) | none | `src/pages/api/auth/[provider]/login.ts`, `callback.ts` | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Conditional (when `GOOGLE_OAUTH_CLIENT_ID` set) | none | `src/pages/api/auth/[provider]/callback.ts` | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) |
| `OAUTH_JWT_SECRET` | Yes | none | `src/pages/api/auth/refresh.ts`, `logout.ts`, `account.ts`, middleware | [REQ-AUTH-002](../sdd/authentication.md#req-auth-002-session-lifecycle) |
| `RESEND_API_KEY` | Conditional (email dispatch) | none — email silently skipped when unset | `src/lib/email.ts` | [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email-content), [REQ-MAIL-003](../sdd/email.md#req-mail-003-digest-ready-email-send-policy) |
| `RESEND_FROM` | Conditional (when `RESEND_API_KEY` set) | none | `src/lib/email.ts` | [REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email-content) |
| `APP_URL` | Yes | none | `src/pages/api/auth/account.ts`, `src/pages/api/tags.ts`, all Origin-check routes | [REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints) |
| `ADMIN_EMAIL` | Conditional (admin routes) | none — every `/api/admin/*` returns 403 when unset | `src/middleware/admin-auth.ts` | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8 |
| `CF_ACCESS_AUD` | Optional | none (Layer 0 perimeter skipped when unset) | `src/middleware/admin-auth.ts` | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8a |
| `DEV_BYPASS_TOKEN` | Optional | none — `/api/dev/*` returns 404 when unset | `src/pages/api/dev/login.ts`, `src/pages/api/dev/trigger-scrape.ts` | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 10 |
| `DEV_BYPASS_USER_ID` | Optional | `__e2e__` (synthetic row) | `src/pages/api/dev/login.ts` | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 10 |

Notes: The `GH_` prefix on the GitHub OAuth secrets is required because GitHub Actions reserves the `GITHUB_*` namespace for its built-in tokens. `RESEND_FROM` accepts a bare address (`digest@example.com`) or RFC 5322 display-name form (`Acme News <digest@example.com>`) — see [RESEND_FROM display-name handling](#resend_from-display-name-handling).

### RESEND_FROM display-name handling

A bare address (e.g., `digest@example.com`) is automatically wrapped in `News Digest <digest@example.com>` display-name format before sending so recipients see a friendly name in their inbox regardless of the stored format. To set a custom display name, store the full RFC 5322 form in the secret (`Acme News <digest@example.com>`); the wrapper only fires when no `<` is present.

### DEV_BYPASS_USER_ID override

Unset is the right value for almost every deployment. When unset, `/api/dev/login` mints sessions for the synthetic `__e2e__` row from `migrations/0006_e2e_user.sql` — this keeps e2e tests from mutating the operator's account. Set this only for unusual cases (e.g., impersonating a specific staging account); the deploy workflow does not propagate the value.

## GitHub Actions Secrets (CI deploy only)

The deploy job reads these secrets from GitHub Actions. The first two are Cloudflare credentials; the rest are Worker secrets that CI pushes to the Worker on each deploy via `wrangler secret put`.

| Secret | Required | Description |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Yes | Token with Workers Scripts:Edit scope for deployment |
| `CLOUDFLARE_ACCOUNT_ID` | Yes | Target Cloudflare account id |
| `GH_OAUTH_CLIENT_ID` | Conditional | GitHub OAuth App client ID (required when GitHub sign-in is enabled) |
| `GH_OAUTH_CLIENT_SECRET` | Conditional | GitHub OAuth App client secret (required when `GH_OAUTH_CLIENT_ID` is set) |
| `GOOGLE_OAUTH_CLIENT_ID` | Conditional | Google OAuth 2.0 client ID (required when Google sign-in is enabled) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Conditional | Google OAuth 2.0 client secret (required when `GOOGLE_OAUTH_CLIENT_ID` is set) |
| `OAUTH_JWT_SECRET` | Yes | 32+ char random string used to HMAC-sign session JWTs |
| `RESEND_API_KEY` | Conditional | Resend API key for digest emails; when absent the runtime silently skips email dispatch |
| `RESEND_FROM` | Conditional | Sender address for emails; required when `RESEND_API_KEY` is set |
| `APP_URL` | Yes | Canonical origin (e.g., `https://digest.example.com`); used in emails, OAuth redirect URIs, and CSRF checks |
| `DEV_BYPASS_TOKEN` | Conditional | Bearer token that enables `/api/dev/login` and `/api/dev/trigger-scrape`; omit in production |
| `ADMIN_EMAIL` | Conditional | Operator email that gates `/api/admin/*`; when unset every admin endpoint returns HTTP 403 ([REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8) |
| `CF_ACCESS_AUD` | Optional | Cloudflare Access audience tag; when set, enables Layer 0 perimeter check (assertion presence + `aud`-claim match) on `/api/admin/*`; when unset, Layer 0 is skipped and admin is gated by session + `ADMIN_EMAIL` alone ([REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8, AD29). See [Setting `CF_ACCESS_AUD`](#setting-cf_access_aud-production-when-binding-cloudflare-access) for setup. |

### Setting `CF_ACCESS_AUD` (production, when binding Cloudflare Access)

`CF_ACCESS_AUD` is optional. Per AD29, Cloudflare Access is opt-in additive perimeter: when this var is unset, admin is gated by signed-in session + `ADMIN_EMAIL` alone — appropriate for forks and integration deploys where binding Access in front of the worker is overkill.

For production deploys that DO bind Access, set this var and follow AD30 — bind Access on every public hostname the worker serves OR disable the unbound hostnames:
1. **Set `CF_ACCESS_AUD`** — the audience tag of the Access application fronting the custom domain. The Worker enforces Layer 0 (assertion presence + `aud` claim match) before the baseline session + `ADMIN_EMAIL` checks run.
2. **Bind Access on `*.workers.dev` too OR disable that subdomain** — Workers & Pages → your worker → Settings → Domains & Routes. Unbound `*.workers.dev` bypasses the perimeter; baseline session + `ADMIN_EMAIL` still gates, but the perimeter promise is broken (AD30).

The deploy job also runs `wrangler secret delete DEV_BYPASS_USER_ID` (idempotent, silenced on not-found) on each deploy so any stray value cannot defeat the synthetic `__e2e__` sandbox. The workflow does not propagate this secret; operators who need it must set it manually via `wrangler secret put`.

CI pushes Worker secrets using the file-redirect form (safer than piping under some CI environments).

## Platform Bindings

Declared in `wrangler.toml`:

| Binding | Type | Purpose |
|---|---|---|
| `DB` | D1 database | Primary strongly-consistent store — users, articles, scrape_runs, pending_discoveries, stars |
| `KV` | KV namespace | Edge cache for discovered sources, headlines, source health |
| `SCRAPE_COORDINATOR` | Queue producer | Producer binding — one message per every-4-hours cron tick kicks the coordinator |
| `SCRAPE_CHUNKS` | Queue producer | Producer binding — one message per ~100-candidate LLM chunk |
| `SCRAPE_FINALIZE` | Queue producer | Producer binding — one message per scrape run, enqueued by the last chunk consumer after the run is stamped `ready`; triggers the same-story dedup pass ([REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-core-matching-contract)) |
| `DEDUP_SWEEP` | Queue producer + consumer | Self-chaining queue carrying operator-triggered historical-dedup sweep messages. The kicker (admin route) sends the first message; the consumer processes one batch then re-enqueues a continuation until the corpus tail is reached, decoupling the sweep from the operator's browser tab ([REQ-PIPE-014](../sdd/generation.md#req-pipe-014-same-story-operator-surfaces) AC 1) |
| `PIPELINE_JOBS` | Queue producer + consumer | Self-chaining queue for the backend-driven full pipeline orchestrator. One consumer walks seven phases by chaining messages; the producer binding is used by the kicker routes. No browser tab dependency ([REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface), [AD37](decisions/README.md#ad37-full-pipeline-run-is-backend-orchestrated-browser-tab-is-display-only)) |
| `AI` | Workers AI | LLM inference for chunk summarization and source discovery, plus bge-base-en-v1.5 embedding generation for same-story dedup |
| `VECTORIZE` | Vectorize index | 768-dim cosine index over every surviving article's embedding; queried in the finalize pass and by the historical re-run sweep ([REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-core-matching-contract)) |
| `ASSETS` | Fetcher (static assets) | Cloudflare static-asset binding for serving the Astro-built output; falls back to `new Response('news-digest')` in tests |

All five queue consumers (`SCRAPE_COORDINATOR`, `SCRAPE_CHUNKS`, `SCRAPE_FINALIZE`, `DEDUP_SWEEP`, `PIPELINE_JOBS`) run with `max_batch_size = 1` (one isolate per message) and `max_retries = 3`. The `SCRAPE_FINALIZE` and `PIPELINE_JOBS` consumers have a DLQ (`ai-news-dlq`) configured so terminal retry exhaustion is inspectable rather than silently dropped (CF-001); the DLQ queue is provisioned by the deploy workflow, not bound in the Worker code.

## Worker Vars (non-secret)

Declared in `wrangler.toml` under `[vars]`. Forks may override per-environment via `[env.<name>.vars]`.

| Variable | Default | Required | Consumed by | Implements |
|---|---|---|---|---|
| `QUEUE_MAX_RETRIES` | `"3"` | Yes | `src/queue/*.ts` consumer batch handlers | [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-output-content-contract) |
| `DEDUP_COSINE_THRESHOLD` | `"0.88"` | Yes | `src/lib/embeddings.ts` (`readCosineThreshold`), `src/queue/scrape-finalize-consumer.ts`, `src/pages/api/admin/dedup-diag.ts` | [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-core-matching-contract) |
| `DEDUP_TIME_WINDOW_SECONDS` | `"604800"` (7d) | Yes | `src/lib/embeddings.ts`, `src/queue/dedup-sweep-consumer.ts` | [REQ-PIPE-012](../sdd/generation.md#req-pipe-012-same-story-matching-policy-variants) AC 3 (same-news-cycle window), [REQ-PIPE-013](../sdd/generation.md#req-pipe-013-same-story-cross-tick-automation-and-retention-coupling) AC 3 |
| `DEDUP_SAME_VENDOR_PENALTY` | `"0.05"` | Yes | `src/lib/embeddings.ts` | [REQ-PIPE-012](../sdd/generation.md#req-pipe-012-same-story-matching-policy-variants) AC 2 |
| `DEDUP_RERANK_FLOOR` | `"0.70"` | Yes | `src/lib/dedup-rerank.ts` | [REQ-PIPE-009](../sdd/generation.md#req-pipe-009-llm-re-rank-pass-for-borderline-same-story-candidates) |
| `DEDUP_HIGH_CONFIDENCE_COSINE` | `"0.92"` | Yes | `src/lib/embeddings.ts` | [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-core-matching-contract) AC 3 (deterministic collapse) |
| `IS_PRODUCTION` | `"true"` (prod), `"false"` (integration) | Yes | `src/pages/api/dev/login.ts`, `src/pages/api/dev/trigger-scrape.ts`, `src/pages/api/auth/[provider]/callback.ts` | [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 10 |

The 0.88 default is the post-2026-05-08 calibration ([AD39](decisions/README.md#ad39-raise-dedup-auto-merge-threshold-to-088-and-gate-merges-to-a-72h-news-cycle-window)). The prior 0.78 missed the dense-theme failure mode: independent articles on a broad topic routinely cosine-match in the 0.78-0.86 band on topical overlap alone, producing a 13-source false-merge cluster spanning 9 days. 0.88 pushes auto-merge above that band; the 0.70-0.88 stripe goes to LLM rerank.

The 7d time window (bumped 2026-05-11 from 72h) covers valuation-week and long-weekend reverberation clusters while keeping the auto-sweep Vectorize cost bounded; it also governs the auto-sweep lookback cursor so the cursor scope and the per-pair gate always match. The 0.92 high-confidence bar above the threshold catches near-duplicate-headline pairs (wire syndication) deterministically without re-litigating the threshold calibration.

Re-validate all three constants if the embedding model or corpus changes substantially. To tune the rerank band, adjust `DEDUP_RERANK_FLOOR`; setting it equal to `DEDUP_COSINE_THRESHOLD` disables rerank without removing the code path.

## Cron

Three triggers are declared in `wrangler.toml`:

| Schedule | Purpose | REQ |
|---|---|---|
| `0 */4 * * *` | Global-feed coordinator (00/04/08/12/16/20 UTC) | [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) |
| `0 3 * * *` | Daily retention + refresh-token purge | [REQ-PIPE-005](../sdd/generation.md#req-pipe-005-fourteen-day-retention-with-starred-exempt-cleanup), [REQ-AUTH-008](../sdd/authentication.md#req-auth-008-refresh-token-rotation-device-binding-reuse-detection) |
| `*/5 * * * *` | Email dispatcher + pending-discovery drain | [REQ-MAIL-003](../sdd/email.md#req-mail-003-digest-ready-email-send-policy) |

**Daily 03:00 UTC tick:** removes articles older than 14 days (starred articles are exempt). Also purges expired and old-revoked rows from the `refresh_tokens` table; the 7-day grace on revoked rows preserves reuse-detection history per REQ-AUTH-008 AC 5.

**Every-5-minute tick:** one trigger, two unrelated chores:
1. Per-user email dispatcher fan-out — sends digests to users in their local-day window.
2. Pending-discovery drain — runs LLM source discovery for newly added tags with no per-user gating.

## KV Key Conventions

The `KV` namespace uses a structured key scheme. All keys are shared across all users unless noted.

| Key pattern | Value shape | TTL | Purpose |
|---|---|---|---|
| `sources:{tag}` | `{ feeds: [{ name, url, kind }], discovered_at }` | None (permanent until evicted) | LLM-discovered feed list for a tag — globally shared; written by the discovery cron, cleared by `POST /api/admin/discovery/retry` and by the coordinator's eviction pass when all feeds for a tag are removed; the daily cron also sweeps entries whose tag is no longer owned by any user ([REQ-PIPE-007](../sdd/generation.md#req-pipe-007-orphan-tag-source-cleanup)) |
| `discovery_failures:{tag}` | per-tag failure counter (string integer) | — | Per-tag failure bookkeeping; cleared by `POST /api/admin/discovery/retry`; also swept by the daily orphan-tag cleanup when the tag is no longer owned by any user ([REQ-PIPE-007](../sdd/generation.md#req-pipe-007-orphan-tag-source-cleanup)) |
| `source_health:{url}` | Consecutive failure count (UTF-8 integer string) | 7 days | Per-URL fetch-health counter; incremented on each failed fetch, deleted on success. When the count reaches 30 (`CONSECUTIVE_FETCH_FAILURE_LIMIT`) the coordinator evicts the URL from its `sources:{tag}` entry. Implements [REQ-DISC-003](../sdd/discovery.md#req-disc-003-self-healing-feed-health-tracking). |
| `headlines:{source}:{tag}` | Array of headline objects | 10 min (600 s) | Per-source/per-tag headline cache shared across all chunk invocations within a single scrape run. Implements [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence). |
| `scrape_run:{id}:chunks_remaining` | Integer string | — | Display mirror of chunk progress for `GET /api/scrape-status` ([REQ-PIPE-006](../sdd/generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress)). Not the authoritative completion gate — that lives in D1 `scrape_chunk_completions` (migration 0007, see [AD7](decisions/README.md#ad7-d1-for-chunk-completion-tracking-replacing-kv-read-modify-write)). |
| `ratelimit:{routeClass}:{identity}:{windowIndex}` | Integer string | Window size | Rate-limit counters; see [Rate-limit rules](#rate-limit-rules) below. Implements [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9. |

### Rate-limit rules

| Rule | Limit | Scope | Fail mode |
|---|---|---|---|
| `auth_login` | 10 / 60s | IP | Fail closed ([AD23](decisions/README.md#ad23-auth-rate-limit-fail-closed-without-waf-backstop)) |
| `auth_callback` | 20 / 60s | IP | Fail closed ([AD23](decisions/README.md#ad23-auth-rate-limit-fail-closed-without-waf-backstop)) |
| `auth_refresh_ip` | 60 / 60s | IP | Fail closed |
| `auth_refresh_user` | 30 / 60s | User | Fail closed |
| `auth_logout` | 5 / 60s | IP | Fail open |
| `article_star` | 60 / 60s | User | Fail open |
| `tags_mutation` | 30 / 60s | User | Fail open |
| `set_tz` | 30 / 60s | User | Fail open |
| `discovery_status` | 120 / 60s | User | Fail open |
| `admin_force_refresh` | Per-operator hourly bucket | User | Fail open (surfaced as 429 with Retry-After) |
| `admin_pipeline_run` | Per-operator hourly bucket | User | Fail open (surfaced as 429 with Retry-After) |

The `auth_refresh_*` buckets are shared between `POST /api/auth/refresh` and the inline middleware refresh path so an attacker cannot pivot to authenticated GET routes to bypass the explicit endpoint's limit.

`set_tz` and `discovery_status` cover authenticated endpoints that legitimate clients poll on a sub-minute cadence. They key by user id and fail open so a KV outage does not degrade the settings UX.

The fail-mode split exists because sign-in must remain reachable during a KV outage — locking everyone out is worse than letting through a brief burst — while a stolen refresh cookie must not benefit from the same outage to bypass its limit.

## Compatibility

`compatibility_date = "2026-04-01"` with `compatibility_flags = ["nodejs_compat"]`. The `nodejs_compat` flag is required because some transitive dependencies use Node.js built-ins. The Worker runtime is otherwise web-standard.

## Observability

`[observability] enabled = true` — enables Cloudflare Workers Observability (structured log ingestion from `console.log`). See [REQ-OPS-001](../sdd/observability.md#req-ops-001-structured-json-logging) for the log envelope format.

## Security Headers

Security headers (CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`) are applied by `src/middleware/security-headers.ts` on every response. No configuration is required — the policy is hardcoded and tested byte-for-byte. See [REQ-OPS-003](../sdd/observability.md#req-ops-003-security-headers-on-every-response) for the exact header values.

## Configuration Files

| File | Purpose |
|---|---|
| `wrangler.toml` | Cloudflare Worker config: name, compatibility date, D1/KV/Queue/AI bindings, cron triggers |
| `astro.config.mjs` | Astro adapter (`@astrojs/cloudflare`), integrations (`@vite-pwa/astro`, `@tailwindcss/vite`) |
| `sdd/config.yml` | SDD workflow config: mode, `enforce_tdd`, test globs, allowlists |

---

## Related Documentation

- [Deployment](deployment.md) — How to set these up in dev and prod
- [Architecture](architecture.md) — Where these bindings are used
