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
2. Runs the same two-step security audit as PR Checks (advisory HIGH+, blocking CRITICAL) as a defence-in-depth gate — catches CVEs introduced between the merge and the deploy (transient transitive bumps, Dependabot lockfile regenerations, etc.).
3. Pushes Worker secrets via `wrangler secret put` (file-redirect form). Conditional secrets (`ADMIN_EMAIL`, `CF_ACCESS_AUD`, `DEV_BYPASS_USER_ID`) are pushed only when the corresponding GitHub Actions secret is non-empty.
4. Deploys the Worker.
5. Binds the custom domain extracted from `APP_URL` via the Workers Custom Domains API. Idempotent.
6. Smoke-tests `GET /` against `APP_URL`, falling back to `*.workers.dev`. Accepts `200` or `303`.

`scripts/e2e-test.sh` is manual only (`bash scripts/e2e-test.sh --force-prod`) and not part of CI deploy — running it triggers a full LLM-cost scrape and mutates the owner's account.

### Playwright E2E (live)

Manually-triggered browser-side coverage that complements the curl-driven `e2e-test.sh`. Workflow file: `.github/workflows/playwright-e2e.yml`.

**What it covers:**
- View-transition snapshots
- Per-path scroll save / restore
- Navigation correctness on `/digest` and `/history` back-nav (URL transitions cleanly, originating card remains in DOM)

**What it does NOT cover:**
- The morph-pair structural contract lives in `tests/layouts/base.test.ts` — Playwright cannot observe Astro lifecycle timing from outside the browser, so a static source-grep is the right layer for that class.
- The history-vs-digest perf-comparability test is permanently skipped (see `.user-overrides.md`: `skipped-test:REQ-READ-002,REQ-HIST-001`).

**How to run:** Actions tab → `Playwright E2E (live)` → Run workflow. Optional `base_url` input targets a preview deploy.

**Required secret:** `DEV_BYPASS_TOKEN` (must match the Worker secret on the target deployment).

**Sandbox:** Mutations are scoped to the synthetic `__e2e__` user. Implements [REQ-READ-002](../sdd/reading.md#req-read-002-article-detail-view), [REQ-HIST-001](../sdd/history.md#req-hist-001-day-grouped-article-history).

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
| `SCRAPE_FINALIZE` | Queue | `scrape-finalize` | Finalize pass (cross-chunk semantic dedup); one message enqueued by the last chunk consumer per scrape run ([REQ-PIPE-008](../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass)) |
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
| Security audit (advisory) | `npm audit --omit=dev --audit-level=high` (continue-on-error) | HIGH+ advisories surface in the CI log for operator triage via Dependabot but never block the build — the Worker runtime is `workerd`, not Node.js, so most HIGH findings live in build tooling that never reaches the deployed bundle. |
| Security audit (blocking) | `npm audit --omit=dev --audit-level=critical` | Blocks on CRITICAL CVEs in the production-dep tree. |
| Lint | `npm run lint` | Oxlint rules |
| REQ backlink coverage | `node scripts/check-req-backlinks.mjs` | Every `REQ-X-NNN` reference in `src/`, `tests/`, `documentation/`, and `migrations/` resolves to a header in `sdd/`. Fails the build if any reference points at a REQ ID that does not exist in the spec (CF-069). |
| Dead code | `npm run knip` | No unused exports or files |
| Unit + integration tests | `npx vitest run` | Vitest suite |

**Why the audit gates on CRITICAL only:** the deployed bundle runs on `workerd`, not Node.js, so most HIGH+ advisories live in build tooling and never reach production. CRITICAL still blocks the worst CVEs; HIGH+ remains visible in CI logs for Dependabot triage. The deploy job re-runs the same CRITICAL check as defence-in-depth.

When the REQ backlink gate fails, either the referenced REQ-ID needs to be added to `sdd/` (if it is a new requirement), or the stale reference in the source/doc file needs to be updated to point at the correct live REQ.

## Admin-only routes (Cloudflare Access gating)

A handful of operator endpoints drive LLM calls or queue work on demand — budget-sensitive operations reachable only by the site operator. Two independent layers protect them, and the layers play different roles:

| Layer | Role | Implementation |
|---|---|---|
| **Worker-side gate** (`src/middleware/admin-auth.ts`) | **Security boundary.** Sufficient on its own. | Enforces three checks — Access JWT header present, valid Worker session cookie, session email matches `ADMIN_EMAIL` (case-insensitive). With `CF_ACCESS_AUD` set, a fourth check validates the JWT `aud` claim. Each layer returns at the first failure with no observable side effect. Implements [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8. |
| **Cloudflare Access** (zone-level) | **UX layer.** Redirects unauthenticated browsers to the Access login page instead of returning a bare 403. | Every request to `/api/admin/*` must carry a valid `Cf-Access-Jwt-Assertion` header; Access enforces this at the edge before the Worker is invoked. |

Because the Worker gate alone is sufficient, a misconfigured or disabled Access policy does not silently open the endpoints. The two layers complement each other: Access improves the UX of unauthorized access (login redirect, no bare 403); the Worker gate provides the actual security guarantee.

### Setting `CF_ACCESS_AUD` (strongly recommended in production)

`CF_ACCESS_AUD` is technically optional, but **production deployments where Cloudflare Access is bound to a custom domain should set it.** Without it, the Worker only checks `Cf-Access-Jwt-Assertion` header presence — an attacker hitting the same Worker via the `*.workers.dev` URL (where Access is not bound) can forge any JWT-shaped value in the header and pass Layer 1. The session + `ADMIN_EMAIL` checks (Layers 2 + 3) still gate, but the perimeter check is missing.

Two ways to close that gap:
1. **Set `CF_ACCESS_AUD`** — the audience tag of the Access application fronting the custom domain. The Worker validates the JWT `aud` claim; a forged header on `workers.dev` is rejected at Layer 1. Recommended for any deploy that binds Access.
2. **Disable `*.workers.dev`** — Workers & Pages → your worker → Settings → Domains & Routes → disable workers.dev. Forks without Access should leave it enabled; forks with Access in production should disable it.

When Access is bound and `CF_ACCESS_AUD` is unset, the structured log `admin.auth.aud_unset_warning` is emitted once per Worker isolate (isolates cycle roughly every 30 minutes under load) so the misconfiguration is visible via `wrangler tail` or Logpush without flooding Logpush during brute-force probes. Forks without Access bound still see admin unreachable at Layer 1 and never trigger this warning.

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

Keep the Cloudflare Access policy in sync with deploys so unauthorized clicks land on the login page rather than a bare 403. The Worker gate is the security boundary; Access tunes the UX around it.

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
