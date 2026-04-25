# Configuration

**Audience:** Operators, Developers

Environment variables, secrets, and platform bindings required to run the system.

---

## Worker Secrets

Stored via `wrangler secret put <name>`. Never committed to git.

| Secret | Description |
|---|---|
| `OAUTH_CLIENT_ID` | GitHub OAuth App client ID |
| `OAUTH_CLIENT_SECRET` | GitHub OAuth App client secret |
| `OAUTH_JWT_SECRET` | 32+ character random string used to HMAC-sign session JWTs |
| `RESEND_API_KEY` | Resend API key for digest-ready emails (starts with `re_`); optional — when unset the runtime short-circuits silently and no email is sent |
| `RESEND_FROM` | Sender address for emails, e.g., `News Digest <digest@example.com>`; domain must be verified in Resend |
| `APP_URL` | Canonical origin, e.g., `https://digest.example.com`; used in email CTA links, OAuth redirect URI construction, and as the reference value for the Origin CSRF check ([REQ-AUTH-003](../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)) |

## GitHub Actions Secrets (CI deploy only)

| Secret | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token with Workers Scripts:Edit scope for deployment |
| `CLOUDFLARE_ACCOUNT_ID` | Target account id |

CI pushes the Worker secrets during each deploy via `wrangler secret put` using the file-redirect form (safer than piping under some CI environments).

## Platform Bindings

Declared in `wrangler.toml`:

| Binding | Type | Purpose |
|---|---|---|
| `DB` | D1 database | Primary strongly-consistent store — users, articles, scrape_runs, pending_discoveries, stars |
| `KV` | KV namespace | Edge cache for discovered sources, headlines, source health |
| `SCRAPE_COORDINATOR` | Queue producer | Producer binding — one message per hourly cron tick kicks the coordinator |
| `SCRAPE_CHUNKS` | Queue producer | Producer binding — one message per ~100-candidate LLM chunk |
| `AI` | Workers AI | LLM inference for chunk summarization and source discovery |
| `ASSETS` | Fetcher (static assets) | Cloudflare static-asset binding for serving the Astro-built output; falls back to `new Response('news-digest')` in tests |

Both queue consumers run with `max_batch_size = 1` (one isolate per message) and `max_retries = 3`.

## Cron

Three triggers are declared in `wrangler.toml`:

| Schedule | Purpose |
|---|---|
| `0 * * * *` | Hourly global-feed coordinator — fires the scrape pipeline ([REQ-PIPE-001](../sdd/generation.md#req-pipe-001-hourly-global-scrape-and-summarise-pipeline)) |
| `0 3 * * *` | Daily retention cleanup — removes articles older than 7 days ([REQ-PIPE-005](../sdd/generation.md#req-pipe-005-seven-day-retention-with-starred-exempt-cleanup)) |
| `*/5 * * * *` | Every-5-minute tick — email dispatcher and discovery drain ([REQ-MAIL-001](../sdd/email.md#req-mail-001-digest-ready-email), [REQ-DISC-003](../sdd/discovery.md#req-disc-003-feed-health-tracking-and-auto-eviction) *(Deprecated 2026-04-24)*) |

## KV Key Conventions

The `KV` namespace uses a structured key scheme. All keys are shared across all users unless noted.

| Key pattern | Value shape | TTL | Purpose |
|---|---|---|---|
| `sources:{tag}` | `{ feeds: [{ name, url, kind }], discovered_at }` | None (permanent until evicted) | LLM-discovered feed list for a tag — globally shared; written by the discovery cron, cleared by `POST /api/admin/discovery/retry` and by the coordinator's eviction pass when all feeds for a tag are removed |
| `discovery_failures:{tag}` | per-tag failure counter (string integer) | — | Per-tag failure bookkeeping; cleared by `POST /api/admin/discovery/retry` |
| `source_health:{url}` | Consecutive failure count (UTF-8 integer string) | 7 days | Per-URL fetch-health counter; incremented on each failed fetch, deleted on success. When the count reaches 30 (`CONSECUTIVE_FETCH_FAILURE_LIMIT`) the coordinator evicts the URL from its `sources:{tag}` entry. Implements [REQ-DISC-003](../sdd/discovery.md#req-disc-003-self-healing-feed-health-tracking). |
| `headlines:{source}:{tag}` | Array of headline objects | 10 min (600 s) | Per-source/per-tag headline cache shared across all chunk invocations within a single scrape tick. Implements [REQ-GEN-003](../sdd/generation.md#req-gen-003-source-fan-out-with-caching). |
| `scrape_run:{id}:chunks_remaining` | Integer string | — | Running chunk countdown written by the coordinator and polled by `GET /api/scrape-status`. |

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
