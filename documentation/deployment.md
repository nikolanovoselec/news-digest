# Deployment

**Audience:** Developers, Operators

Local development setup and production deployment steps.

---

## Prerequisites

- Node.js 24+ (local dev only; production runs on Cloudflare Workers)
- Cloudflare account with Workers Paid plan enabled
- At least one OAuth provider configured: GitHub (Settings → Developer Settings → OAuth Apps) and/or Google (console.cloud.google.com → APIs & Services → Credentials → OAuth 2.0 Client IDs)
- Resend account with a verified sending domain
- `wrangler` CLI installed (`npm i -g wrangler` or use `npx wrangler`)

## Local Development

```bash
npm install
npx wrangler d1 migrations apply DB --local
npm run dev
```

The dev server runs at `http://localhost:4321`.

## Tests

```bash
npm test
```

Tests are organized so each test references a REQ ID — `spec-reviewer` reads test files to verify which Implemented REQs have automated coverage. Example:

```typescript
test('REQ-AUTH-003: rejects state-changing requests without matching Origin', () => {
  // ...
});
```

**Test fixture for Cloudflare bindings:** import `env` and `applyD1Migrations` from `tests/fixtures/cloudflare-test.ts` rather than directly from `cloudflare:test`. The fixture re-exports these with the `@deprecated` JSDoc stripped, eliminating ~90 `ts(6385)` typecheck warnings that otherwise drown real CI failures in noise. If a future release of the upstream package removes the deprecation tag, delete the fixture and revert test imports to the direct `cloudflare:test` path.

## Production Deployment

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

Or via GitHub Actions (`.github/workflows/deploy.yml`), which triggers on a `workflow_run` event — it fires only when the "PR Checks" workflow on `main` completes with a `success` conclusion. This closes the window where a plain `push: [main]` trigger would have run the deploy in parallel with checks off the same SHA. `workflow_dispatch` is retained for manual re-runs of a stuck deploy.

The deploy job:
1. Applies D1 migrations against the production database.
2. Pushes Worker secrets (Resend credentials, etc.) via `wrangler secret put`.
3. Deploys the Worker.
4. Binds the custom domain: extracts the hostname from the `APP_URL` secret, walks parent domains to find the matching Cloudflare zone in the account, then calls the Workers Custom Domains API (`PUT /accounts/{id}/workers/domains`) to attach the hostname to the Worker. The call is idempotent — safe to re-run on every deploy. Skipped if `APP_URL` is not set.
5. Smoke-tests `GET /` against `APP_URL` first (the hostname users actually reach); falls back to the `*.workers.dev` URL if the custom domain has not propagated yet. Accepts `200` or `303` as passing. Uses `--max-time 15` to avoid hung connections.

The `scripts/e2e-test.sh` script still exists for manual invocation (`bash scripts/e2e-test.sh --force-prod`) but no longer runs automatically on every deploy — running it on every deploy triggers a full-cycle scrape (LLM cost and ~10 min wall-clock) and mutates the owner's account state (tags/stars/settings). The reachability smoke above plus PR Checks on the preceding commit are sufficient to confirm a healthy deploy.

> **Fork-friendly:** set `APP_URL` to any hostname whose apex domain is a Cloudflare zone in the same account — the deploy step binds it automatically. No edits to `wrangler.toml` are required.

### Environment-specific configuration

| Environment | Branch | Notes |
|---|---|---|
| Development | `develop` | Active development branch; PR Checks (`test.yml`) fire on every push |
| Production | `main` | CI deploys on merge to main; deploy is gated on PR Checks success |

## Cloudflare Resources

| Resource | Type | Name | Purpose |
|---|---|---|---|
| `DB` | D1 database | `ai-news-digest` | Primary store |
| `KV` | KV namespace | `news-digest-kv` | Caches (headlines, sources, health) |
| `SCRAPE_COORDINATOR` | Queue | `scrape-coordinator` | Every-4-hours coordinator dispatch (00/04/08/12/16/20 UTC) |
| `SCRAPE_CHUNKS` | Queue | `scrape-chunks` | LLM chunk jobs |
| `AI` | Workers AI | (account-level) | LLM inference |

## Dependency Automation

Dependabot is configured (`.github/dependabot.yml`) to open weekly PRs every Monday at 06:00 UTC. It covers:

- **npm** — runtime deps get individual PRs; dev deps are grouped into one PR per week to keep review surface manageable.
- **GitHub Actions** — action pin bumps are PRed automatically, preventing slow-drip deprecation warnings (e.g., Node.js 20 → 24 runner transitions, CodeQL v3 → v4 upgrades).

CI workflows use `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'` at the workflow level so all actions run under Node.js 24 regardless of the action's bundled Node version.

## Admin-only routes (Cloudflare Access gating)

A handful of operator endpoints drive LLM calls or queue work on demand — budget-sensitive operations that must be reachable only by the site operator. Authentication via the site session is not sufficient: any signed-in user could forge a form POST. These endpoints are gated at the zone level by **Cloudflare Access**, so only the configured admin email can reach them regardless of session state.

### Paths to gate

Every admin endpoint sits under `/api/admin/*` so a **single wildcard rule** covers them all and any future endpoint added under that prefix.

| Path | What it does |
|---|---|
| `/api/admin/force-refresh` | Manually kicks the global-feed coordinator (every-4-hours cron). |
| `/api/admin/discovery/retry` | Re-queues a single tag for LLM-assisted source discovery. |
| `/api/admin/discovery/retry-bulk` | Re-queues every "stuck" (empty-feeds) tag for the session user in one shot — backs the **Discover missing sources** button on `/settings`. |

### Setup (one-time, operator console)

1. Cloudflare dashboard → Zero Trust → **Access** → Applications → Add an application → Self-hosted.
2. Application domain: `<your-app-host>` (e.g. `news.example.com` or `ai-news-digest.<your-user>.workers.dev`), path: `/api/admin/*` (single wildcard covers all admin endpoints, current and future). Include both `POST` and `GET` — Access gates the whole route.
3. Identity provider: any already-configured IdP that supports email assertion (Google, GitHub, One-Time PIN).
4. Access policy: **Include** → Emails → `<admin@example>` (replace with the operator's email). Session lifetime: 24h or shorter per operator preference.
5. Save. The Access edge now issues a `CF_Authorization` JWT cookie on successful auth; requests to the gated paths without it are redirected to the Access login page.

The pages containing these buttons (`/settings`, the dashboard footer) are **not** gated by Access — every authenticated user can render them. The buttons post to the gated endpoints, so a non-admin clicking one sees the Access login prompt rather than the action succeeding. This matches REQ-DISC-004 AC 5: the surface is shown, but execution is restricted.

The dev-bypass endpoint at `/api/dev/login` is gated separately by the `DEV_BYPASS_TOKEN` Worker secret (returns 404 when the secret is unset) and does **not** need a Cloudflare Access policy.

No worker-side admin detection is performed — Cloudflare Access is the only gate for the routes above. Disabling or misconfiguring the Access policy silently opens the endpoint; keep its configuration in sync with deploys.

## Resend domain verification

1. Log in to Resend dashboard.
2. Add the sending domain under "Domains".
3. Copy the DNS records (MX, TXT for SPF, DKIM CNAMEs, DMARC TXT) into your DNS provider.
4. Wait for verification (typically minutes to hours).
5. Update the `RESEND_FROM` Worker secret to use an address on the verified domain.
6. Until verified, Resend sends from a sandbox address — useful for local dev, not for users.

---

## Related Documentation

- [Configuration](configuration.md) — Env vars and secrets
- [Architecture](architecture.md) — System overview
