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
| `RESEND_API_KEY` | Resend API key for digest-ready emails (starts with `re_`) |
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
| `DB` | D1 database | Primary strongly-consistent store — users, digests, articles, pending_discoveries |
| `KV` | KV namespace | Edge cache for discovered sources, headlines, source health |
| `DIGEST_JOBS` | Queue producer | Producer binding used by cron + refresh handler |
| `AI` | Workers AI | LLM inference for summarization and source discovery |
| `ASSETS` | Fetcher (static assets) | Cloudflare static-asset binding for serving the Astro-built output; falls back to `new Response('news-digest')` in tests |

Queue consumer binding is configured in the `[[queues.consumers]]` section of `wrangler.toml`, consuming from the same `digest-jobs` queue. The consumer runs with `max_batch_size = 1` (one isolate per message) and `max_retries = 3`.

## Cron

`crons = ["*/5 * * * *"]` — every 5 minutes at minute 0, 5, 10, ..., 55 UTC.

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
