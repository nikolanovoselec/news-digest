# Deployment

**Audience:** Developers, Operators

Local development setup and production deployment steps.

---

## Prerequisites

- Node.js 24+ (local dev only; production runs on Cloudflare Workers)
- Cloudflare account with Workers Paid plan enabled
- GitHub OAuth App created (Settings → Developer Settings → OAuth Apps)
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

Or via GitHub Actions (`.github/workflows/deploy.yml`), which:
1. Runs tests.
2. Applies D1 migrations against the production database.
3. Pushes Worker secrets (Resend credentials, etc.) via `wrangler secret put`.
4. Deploys the Worker.
5. Binds the custom domain: extracts the hostname from the `APP_URL` secret, walks parent domains to find the matching Cloudflare zone in the account, then calls the Workers Custom Domains API (`PUT /accounts/{id}/workers/domains`) to attach the hostname to the Worker. The call is idempotent — safe to re-run on every deploy. Skipped if `APP_URL` is not set.
6. Smoke-tests `GET /` against `APP_URL` first (the hostname users actually reach); falls back to the `*.workers.dev` URL if the custom domain has not propagated yet. Accepts `200` or `303` as passing. Uses `--max-time 15` to avoid hung connections.
7. Runs `scripts/e2e-test.sh --force-prod` against the freshly-deployed Worker. Requires the `DEV_BYPASS_TOKEN` repository secret (used both to acquire a session via `/api/dev/login` and to trigger the full-cycle scrape via `POST /api/dev/trigger-scrape`). **If the secret is absent the step exits 0 and the deploy is still considered successful** — the e2e suite is an optional safety net, not a gate. The script exercises auth, tags, stars, discovery, and the account-delete transport. The full-cycle scrape section triggers a real scrape (coordinator → chunks → LLM → D1), polls `/api/scrape-status` until the run completes, then asserts that at least one article was ingested and that the first article's `details` field is ≥ 150 words (the prompt target is 150–250 words, 2–3 paragraphs per [REQ-PIPE-002](../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract) AC 3). Every mutating assertion follows a snapshot-save → mutate → assert → restore cycle, so the owner account is left in exactly the state it was found in. The suite is safe to run against production — not just preview deploys — because all mutations are reverted before the script exits.

> **Fork-friendly:** set `APP_URL` to any hostname whose apex domain is a Cloudflare zone in the same account — the deploy step binds it automatically. No edits to `wrangler.toml` are required.

### Environment-specific configuration

| Environment | Branch | Notes |
|---|---|---|
| Development | any local | `wrangler d1 --local`; dev server at localhost:4321 |
| Production | `main` | CI deploys on push to main |

## Cloudflare Resources

| Resource | Type | Name | Purpose |
|---|---|---|---|
| `DB` | D1 database | `ai-news-digest` | Primary store |
| `KV` | KV namespace | `news-digest-kv` | Caches (headlines, sources, health) |
| `SCRAPE_COORDINATOR` | Queue | `scrape-coordinator` | Hourly coordinator dispatch |
| `SCRAPE_CHUNKS` | Queue | `scrape-chunks` | LLM chunk jobs |
| `AI` | Workers AI | (account-level) | LLM inference |

## Dependency Automation

Dependabot is configured (`.github/dependabot.yml`) to open weekly PRs every Monday at 06:00 UTC. It covers:

- **npm** — runtime deps get individual PRs; dev deps are grouped into one PR per week to keep review surface manageable.
- **GitHub Actions** — action pin bumps are PRed automatically, preventing slow-drip deprecation warnings (e.g., Node.js 20 → 24 runner transitions, CodeQL v3 → v4 upgrades).

CI workflows use `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'` at the workflow level so all actions run under Node.js 24 regardless of the action's bundled Node version.

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
