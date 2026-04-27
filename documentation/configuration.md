# Configuration

**Audience:** Operators, Developers

Environment variables, secrets, and platform bindings required to run the system.

---

## Worker Secrets

Stored via `wrangler secret put <name>`. Never committed to git.

| Secret | Description |
|---|---|
| `GH_OAUTH_CLIENT_ID` | GitHub OAuth App client ID. Optional per-provider — at least one provider pair (GitHub or Google) must be configured. The `GH_` prefix is required because GitHub Actions reserves the `GITHUB_*` secret namespace for its built-in tokens. |
| `GH_OAUTH_CLIENT_SECRET` | GitHub OAuth App client secret. Required when `GH_OAUTH_CLIENT_ID` is set. |
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth 2.0 client ID (web application type). Optional per-provider. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth 2.0 client secret. Required when `GOOGLE_OAUTH_CLIENT_ID` is set. |
| `OAUTH_JWT_SECRET` | 32+ character random string used to HMAC-sign session JWTs (provider-agnostic — required regardless of which providers are enabled) |
| `RESEND_API_KEY` | Resend API key for digest-ready emails (starts with `re_`); optional — when unset the runtime short-circuits silently and no email is sent |
| `RESEND_FROM` | Sender address for emails, e.g., `digest@example.com` or `News Digest <digest@example.com>`; domain must be verified in Resend. A bare address (no `<`) is automatically wrapped in `News Digest <address>` display-name format before sending so recipients see a friendly name in their inbox regardless of the stored format. |
| `APP_URL` | Canonical origin, e.g., `https://digest.example.com`; used in email CTA links, OAuth redirect URI construction, and as the reference value for the Origin CSRF check ([REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)) |
| `ADMIN_EMAIL` | Operator email that gates `/api/admin/*` ([REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8). Required in production; when unset, every admin endpoint returns HTTP 403. Match is case-insensitive against `users.email`. |
| `CF_ACCESS_AUD` | Optional Cloudflare Access audience tag. When set, `/api/admin/*` additionally validates that the `aud` claim of the `Cf-Access-Jwt-Assertion` header matches. When unset, only header presence is required (the JWT signature is trusted because Cloudflare Access already verified it before forwarding). |
| `DEV_BYPASS_TOKEN` | Optional Bearer token that gates `/api/dev/login` and `/api/dev/trigger-scrape` for local + e2e flows. When unset, those endpoints return HTTP 404. Set only on dev/staging deployments, never production. |
| `DEV_BYPASS_USER_ID` | Optional override for the user id minted by `/api/dev/login`. When unset, the endpoint defaults to the synthetic `__e2e__` row from `migrations/0006_e2e_user.sql` so e2e tests never mutate the operator's account. Set this manually (via `wrangler secret put`) only for unusual cases like impersonating a specific staging account. The deploy workflow does not propagate this — there is no fork-onboarding scenario where an operator would know the right value. |

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
| `CF_ACCESS_AUD` | Optional | Cloudflare Access audience tag for `aud`-claim validation on the admin JWT; when unset, only header presence is required ([REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8) |

The deploy job also runs `wrangler secret delete DEV_BYPASS_USER_ID` (idempotent, silenced on not-found) on each deploy to wipe any pre-migration value that would defeat the synthetic `__e2e__` sandbox. This secret is no longer propagated by the workflow; operators who need it must set it manually via `wrangler secret put`.

CI pushes Worker secrets using the file-redirect form (safer than piping under some CI environments).

## Platform Bindings

Declared in `wrangler.toml`:

| Binding | Type | Purpose |
|---|---|---|
| `DB` | D1 database | Primary strongly-consistent store — users, articles, scrape_runs, pending_discoveries, stars |
| `KV` | KV namespace | Edge cache for discovered sources, headlines, source health |
| `SCRAPE_COORDINATOR` | Queue producer | Producer binding — one message per every-4-hours cron tick kicks the coordinator |
| `SCRAPE_CHUNKS` | Queue producer | Producer binding — one message per ~100-candidate LLM chunk |
| `SCRAPE_FINALIZE` | Queue producer | Producer binding — one message per scrape tick, enqueued by the last chunk consumer after the run is stamped `ready`; triggers the cross-chunk semantic dedup pass ([REQ-PIPE-008](../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass)) |
| `AI` | Workers AI | LLM inference for chunk summarization, source discovery, and cross-chunk dedup finalize pass |
| `ASSETS` | Fetcher (static assets) | Cloudflare static-asset binding for serving the Astro-built output; falls back to `new Response('news-digest')` in tests |

All three queue consumers run with `max_batch_size = 1` (one isolate per message) and `max_retries = 3`.

## Cron

Three triggers are declared in `wrangler.toml`:

| Schedule | Purpose |
|---|---|
| `0 */4 * * *` | Every-4-hour global-feed coordinator — fires the scrape pipeline at 00/04/08/12/16/20 UTC ([REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence)) |
| `0 3 * * *` | Daily retention cleanup — removes articles older than 7 days ([REQ-PIPE-005](../sdd/generation.md#req-pipe-005-seven-day-retention-with-starred-exempt-cleanup)) |
| `*/5 * * * *` | Every-5-minute tick — email dispatcher fan-out per user ([REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email)) |
| `*/5 * * * *` | Every-5-minute tick — pending-discovery drain (LLM source discovery for newly added tags) — *previously also covered by [REQ-DISC-003](../sdd/discovery.md#req-disc-003-self-healing-feed-health-tracking) per-user-generation rate limiting (Deprecated 2026-04-24)*; now implemented purely as a worker queue + cron consumer with no per-user gating |

## KV Key Conventions

The `KV` namespace uses a structured key scheme. All keys are shared across all users unless noted.

| Key pattern | Value shape | TTL | Purpose |
|---|---|---|---|
| `sources:{tag}` | `{ feeds: [{ name, url, kind }], discovered_at }` | None (permanent until evicted) | LLM-discovered feed list for a tag — globally shared; written by the discovery cron, cleared by `POST /api/admin/discovery/retry` and by the coordinator's eviction pass when all feeds for a tag are removed; the daily cron also sweeps entries whose tag is no longer owned by any user ([REQ-PIPE-007](../sdd/generation.md#req-pipe-007-orphan-tag-source-cleanup)) |
| `discovery_failures:{tag}` | per-tag failure counter (string integer) | — | Per-tag failure bookkeeping; cleared by `POST /api/admin/discovery/retry`; also swept by the daily orphan-tag cleanup when the tag is no longer owned by any user ([REQ-PIPE-007](../sdd/generation.md#req-pipe-007-orphan-tag-source-cleanup)) |
| `source_health:{url}` | Consecutive failure count (UTF-8 integer string) | 7 days | Per-URL fetch-health counter; incremented on each failed fetch, deleted on success. When the count reaches 30 (`CONSECUTIVE_FETCH_FAILURE_LIMIT`) the coordinator evicts the URL from its `sources:{tag}` entry. Implements [REQ-DISC-003](../sdd/discovery.md#req-disc-003-self-healing-feed-health-tracking). |
| `headlines:{source}:{tag}` | Array of headline objects | 10 min (600 s) | Per-source/per-tag headline cache shared across all chunk invocations within a single scrape tick. Implements [REQ-GEN-003](../sdd/generation.md#req-gen-003-source-fan-out-with-caching). |
| `scrape_run:{id}:chunks_remaining` | Integer string | — | Derived mirror of chunk progress — written by the coordinator (total) and decremented by each chunk consumer for display purposes only. The authoritative completion gate moved to D1 (`scrape_chunk_completions` table, migration 0007) to eliminate the TOCTOU race window. This KV key is polled by `GET /api/scrape-status` for the in-flight progress display ([REQ-PIPE-006](../sdd/generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress)) and is **not** the completion signal. |
| `ratelimit:{routeClass}:{identity}:{windowIndex}` | Integer string (request count) | TTL = window size in seconds | Application-layer rate-limit counters written and read by `src/lib/rate-limit.ts`. `routeClass` is one of `auth_login`, `auth_callback`, `article_star`, `tags_mutation`. `identity` is the client IP for unauthenticated routes and the user id for authenticated mutation routes. `windowIndex` is `Math.floor(Date.now() / 1000 / windowSeconds)`. Implements [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9. |

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
| `astro.config.mjs` | Astro adapter (`@astrojs/cloudflare`), integrations (`@vite-pwa/astro`, `@astrojs/tailwind`) |
| `sdd/config.yml` | SDD workflow config: mode, `enforce_tdd`, test globs, allowlists |

---

## Related Documentation

- [Deployment](deployment.md) — How to set these up in dev and prod
- [Architecture](architecture.md) — Where these bindings are used
