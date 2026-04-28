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

Tests reference a REQ ID in the test name so `spec-reviewer` can verify automated coverage:

```typescript
test('REQ-AUTH-003: rejects state-changing requests without matching Origin', () => {
  // ...
});
```

Import `env` and `applyD1Migrations` from `tests/fixtures/cloudflare-test.ts` (not `cloudflare:test` directly) — the fixture strips deprecated-JSDoc warnings.

## Production Deployment

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

CI/CD: `.github/workflows/deploy.yml` triggers on a `workflow_run` event — fires only when "PR Checks" on `main` completes with `success`. `workflow_dispatch` is retained for manual re-runs.

The deploy job:
1. Applies D1 migrations (idempotent).
2. Pushes Worker secrets via `wrangler secret put` (file-redirect form). Conditional secrets (`ADMIN_EMAIL`, `CF_ACCESS_AUD`, `DEV_BYPASS_USER_ID`) are pushed only when the corresponding GitHub Actions secret is non-empty.
3. Deploys the Worker.
4. Binds the custom domain extracted from `APP_URL` via the Workers Custom Domains API. Idempotent.
5. Smoke-tests `GET /` against `APP_URL`, falling back to `*.workers.dev`. Accepts `200` or `303`.

`scripts/e2e-test.sh` is manual only (`bash scripts/e2e-test.sh --force-prod`) and not part of CI deploy — running it triggers a full LLM-cost scrape and mutates the owner's account.

`Playwright E2E (live)` workflow (`.github/workflows/playwright-e2e.yml`) is `workflow_dispatch`-triggered. It exercises the live site in a real browser (view-transition snapshots, scroll restore, the morph-pair contract on `/digest` and `/history` — verified by inspecting named-card state in `event.newDocument` at `astro:before-swap`, the point at which `promoteIncomingCardForReturnMorph` has already set the `view-transition-name` on the matching card in the incoming document before the swap occurs) — the browser-side coverage curl-driven `e2e-test.sh` cannot reach. The perf-comparability test (history back-nav ≤ 1.6× digest back-nav) is permanently skipped; `/history` is structurally slower than `/digest` due to opened day-groups carrying more cards, and this is accepted. Trigger from the Actions tab; optional `base_url` input targets a preview deploy. Requires repository secret `DEV_BYPASS_TOKEN` matching the Worker secret on the target deployment. Mutations are sandboxed to the synthetic `__e2e__` user (REQ-READ-002, REQ-HIST-001).

> **Fork-friendly:** set `APP_URL` to any hostname whose apex is a zone in the same Cloudflare account. The deploy binds it automatically.

### Environment-specific configuration

| Environment | Branch | Notes |
|---|---|---|
| Development | `develop` | Active development branch; PR Checks (`test.yml`) fire on every push |
| Production | `main` | CI deploys on merge to main; deploy is gated on PR Checks success |

## Cloudflare Resources

| Resource | Type | Name | Purpose |
|---|---|---|---|
| `DB` | D1 database | `ai-news-digest` | Primary store |
| `KV` | KV namespace | `ai-news-digest-kv` (derived: `${WORKER_NAME}-kv` in `scripts/bootstrap-resources.sh`, where `WORKER_NAME = "ai-news-digest"` from `wrangler.toml`) | Caches (headlines, sources, health) |
| `SCRAPE_COORDINATOR` | Queue | `scrape-coordinator` | Every-4-hours coordinator dispatch (00/04/08/12/16/20 UTC) |
| `SCRAPE_CHUNKS` | Queue | `scrape-chunks` | LLM chunk jobs |
| `SCRAPE_FINALIZE` | Queue | `scrape-finalize` | Cross-chunk semantic dedup pass; one message enqueued by the last chunk consumer per scrape run ([REQ-PIPE-008](../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass)) |
| `AI` | Workers AI | (account-level) | LLM inference |

## Dependency Automation

Dependabot is configured (`.github/dependabot.yml`) to open weekly PRs every Monday at 06:00 UTC. It covers:

- **npm** — runtime deps get individual PRs; dev deps are grouped into one PR per week to keep review surface manageable.
- **GitHub Actions** — action pin bumps are PRed automatically, preventing slow-drip deprecation warnings (e.g., Node.js 20 → 24 runner transitions, CodeQL v3 → v4 upgrades).

CI workflows use `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'` at the workflow level so all actions run under Node.js 24 regardless of the action's bundled Node version.

### PR Checks — CI gates (`test.yml`)

Every push to `develop` (and every PR targeting `main`) runs the following gates in order. All must pass before the deploy workflow fires:

| Step | Command | What it enforces |
|---|---|---|
| Install | `npm install --no-fund --no-audit` | Dependency resolution |
| Security audit (advisory-only) | `npm audit --omit=dev --audit-level=high` with `continue-on-error: true` | Surfaces HIGH+ advisories in runtime dep tree but does NOT fail the build. Worker runtime is workerd, not Node.js, so most advisories live in build tooling (`@astrojs/cloudflare`, `wrangler`, `miniflare`, `undici`) and don't reach the deployed bundle. Operators read the advisory list from CI logs and act via Dependabot PRs; failing the build on these would block legitimate work without improving production security. |
| Lint | `npm run lint` | Oxlint rules |
| REQ backlink coverage | `node scripts/check-req-backlinks.mjs` | Every `REQ-X-NNN` reference in `src/`, `tests/`, `documentation/`, and `migrations/` resolves to a header in `sdd/`. Fails the build if any reference points at a REQ ID that does not exist in the spec (CF-069). |
| Dead code | `npm run knip` | No unused exports or files |
| Unit + integration tests | `npx vitest run` | Vitest suite |

Security advisories surfaced by the audit step are non-blocking — Dependabot opens PRs weekly for runtime dep upgrades, which is the project's enforcement path.

When the REQ backlink gate fails, either the referenced REQ-ID needs to be added to `sdd/` (if it is a new requirement), or the stale reference in the source/doc file needs to be updated to point at the correct live REQ.

## Admin-only routes (Cloudflare Access gating)

A handful of operator endpoints drive LLM calls or queue work on demand — budget-sensitive operations that must be reachable only by the site operator. These endpoints are protected by two independent layers:

1. **Cloudflare Access (zone-level):** every request to `/api/admin/*` must carry a valid `Cf-Access-Jwt-Assertion` header. Without it, Access redirects the browser to the Access login page before the Worker ever sees the request.
2. **Worker-side gate (`src/middleware/admin-auth.ts`):** even when the Access header is present, the Worker enforces three additional checks — (a) the CF Access JWT header must be present; (b) the requester must hold a valid Worker session cookie; (c) the session user's email must match `ADMIN_EMAIL` (case-insensitive). When `CF_ACCESS_AUD` is also configured, a fourth check validates the `aud` claim of the Access JWT. Each failing check returns at the first failure with no observable side effect. Implements [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8.

This dual-layer design means a misconfigured or disabled Access policy does **not** silently open the endpoints — the Worker gate is an independent backstop.

### Paths to gate

Every admin endpoint sits under `/api/admin/*` so a **single wildcard rule** covers them all and any future endpoint added under that prefix.

| Path | What it does |
|---|---|
| `/api/admin/force-refresh` | Manually kicks the global-feed coordinator (every-4-hours cron). Implements [REQ-OPS-005](../sdd/observability.md#req-ops-005-admin-force-refresh-endpoint). |
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

Keep the Cloudflare Access policy in sync with deploys — Access is the first layer and improves user experience (login-page redirect instead of a bare 403). Both layers must be correctly configured for full protection.

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
- [Security Policy](../SECURITY.md) — Vulnerability reporting scope and contact
