# Deployment

<!-- doc-allow-large -->
<!-- The dev-bypass runbook is a symptom/cause/fix reference that sits naturally
     alongside the deploy steps it troubleshoots. Splitting it into a separate
     troubleshooting.md fragments operator discovery — operators hit the runbook
     immediately after a deploy, in the same context. -->

**Audience:** Developers, Operators

Local development setup and production deployment steps.

---

## Prerequisites

- Node.js 22+ (local dev only; production runs on Cloudflare Workers)
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
1. Applies D1 migrations (drift-tolerant). SQLite has no `ADD COLUMN IF NOT EXISTS`, so a migration manually run out-of-band leaves the column in place but unrecorded in `d1_migrations`. The CI step handles this with a retry loop: on a "duplicate column" or "already exists" error it stamps the failing migration name into `d1_migrations` and retries, up to 5 attempts. Real SQL errors (syntax, constraint violations) surface immediately. Both `deploy.yml` (production) and `deploy-integration.yml` run the same loop.
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
- The history-vs-digest perf-comparability test is permanently skipped (see [AD14](decisions/README.md#ad14-history-page-perf-comparability-test-permanently-skipped)).

**How to run:** Actions tab → `Playwright E2E (live)` → Run workflow. Optional `base_url` input targets a preview deploy.

**Required secret:** `DEV_BYPASS_TOKEN` (must match the Worker secret on the target deployment).

**Sandbox:** Mutations are scoped to the synthetic `__e2e__` user. Implements [REQ-READ-002](../sdd/reading.md#req-read-002-article-detail-view), [REQ-HIST-001](../sdd/history.md#req-hist-001-day-grouped-article-history).

> **Fork-friendly:** set `APP_URL` to any hostname whose apex is a zone in the same Cloudflare account. The deploy binds it automatically.

### Environment-specific configuration

| Environment | Branch | Hostname source | Trigger | Crons |
|---|---|---|---|---|
| Development | `develop` | (no deploy) | PR Checks (`test.yml`) fire on every push | n/a |
| Integration | `develop` | `vars.APP_URL` on the `integration` GitHub Environment | Manual (Actions → Deploy Integration) | OFF (explicit `[env.integration.triggers] crons = []` in `wrangler.toml` — omitting the block would inherit the top-level cron array) |
| Production | `main` | `secrets.APP_URL` (repo-level) | Auto on merge to main, gated on PR Checks success | ON |

## Integration deployment

**Purpose:** Smoke-test risky changes (major dependency bumps, schema migrations, CSP tightening, animation rewrites) on the live Cloudflare edge before they reach production. Implements [REQ-OPS-006](../sdd/observability.md#req-ops-006-integration-deployment-target). Architectural decision: [AD12](decisions/README.md#ad12-integration-env-separate-cloudflare-resources-manual-trigger-from-develop-crons-disabled).

**Workflow file:** `.github/workflows/deploy-integration.yml`

**Cloudflare resources** (all suffixed `-integration`, fully isolated from prod):

| Resource | Name |
|---|---|
| Worker | `ai-news-digest-integration` |
| D1 | `ai-news-digest-integration` |
| KV | `ai-news-digest-integration-kv` (auto-derived) |
| Queues | `scrape-coordinator-integration`, `scrape-chunks-integration`, `scrape-finalize-integration` |
| Workers AI | shared `AI` binding (no per-env isolation needed) |
| Vectorize | `ai-news-embeddings-integration` |

**One-time per-fork setup:**

1. **Create the GitHub Environment.** Repo → Settings → Environments → New environment → name it `integration`. The empty environment is what activates the secret-fallback semantics in the workflow.
2. **Set `APP_URL` as an environment variable** (Variables tab, NOT Secrets — it's a public hostname). The value is the URL the integration worker will serve, e.g., `https://news.example.com` if you have a custom domain on Cloudflare. Leave unset to deploy to the auto-assigned `*.workers.dev` URL.
3. **Confirm the OAuth callback URL is registered** with whichever providers you use — `${APP_URL}/api/auth/google/callback` and/or `${APP_URL}/api/auth/github/callback`.
4. **(Optional) Override secrets per-env.** Any secret added under Environments → integration → Secrets takes precedence over the repo-level secret with the same name. Useful for isolating `OAUTH_JWT_SECRET` between prod and integration so a leaked integration JWT can't be replayed against prod.

**How to deploy:**

1. Land the change on `develop` (PR-merged or direct push).
2. GitHub → Actions → "Deploy Integration" → "Run workflow" → green button.
3. The branch dropdown in the dispatch dialog is irrelevant — the workflow always pulls `develop`'s current HEAD.
4. ~3 minutes for first-deploy (resources provisioned), ~2 minutes for subsequent deploys.
5. After the deploy completes, hit the URL manually. There is no automated smoke step on integration — GHA runner IPs are blocked by Cloudflare bot management at the edge, so a curl from CI reliably returns `403` regardless of worker health. `wrangler deploy` exit code is the authoritative success signal. Open `vars.APP_URL` (or the `*.workers.dev` URL the deploy log prints) in a browser to confirm the worker is reachable.

**Triggering a scrape on integration** (since crons are off):

Use the **Run pipeline now** button on `/settings` (admin section) — it chains force-refresh, embed backfill, and historical dedup in one browser-side flow ([REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-from-the-settings-surface)). For scripted or headless runs:

```bash
# Sign in at your APP_URL (or use the dev-bypass runbook below), then:
curl -i ${APP_URL}/api/admin/force-refresh
```

**Promotion path** is one-way: develop → integration verify → develop merged to main → production auto-deploy. No path pushes integration changes back to develop.

**Secret resolution.** `environment: integration` enables GitHub's standard secret-resolution fallback: env-scoped secret wins when defined, otherwise the repo-level secret is used. Default state with no env-scoped secrets matches running without env scoping at all — which is exactly what you want when reusing prod credentials on integration.

## Cloudflare Resources

| Resource | Type | Name | Purpose |
|---|---|---|---|
| `DB` | D1 database | `ai-news-digest` | Primary store |
| `KV` | KV namespace | `ai-news-digest-kv` (derived: `${WORKER_NAME}-kv` in `scripts/bootstrap-resources.sh`, where `WORKER_NAME = "ai-news-digest"` from `wrangler.toml`) | Caches (headlines, sources, health) |
| `SCRAPE_COORDINATOR` | Queue | `scrape-coordinator` | Every-4-hours coordinator dispatch (00/04/08/12/16/20 UTC) |
| `SCRAPE_CHUNKS` | Queue | `scrape-chunks` | LLM chunk jobs |
| `SCRAPE_FINALIZE` | Queue | `scrape-finalize` | Same-story dedup pass; one message enqueued by the last chunk consumer per scrape run ([REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history)) |
| `AI` | Workers AI | (account-level) | LLM inference and bge-base-en-v1.5 embedding generation |
| `VECTORIZE` | Vectorize index | `ai-news-embeddings` | 768-dim cosine index for same-story dedup; provisioned by the deploy workflow via `wrangler vectorize create` ([REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history)) |

## Dependency Automation

Dependabot is configured (`.github/dependabot.yml`) to open weekly PRs every Monday at 06:00 UTC. It covers:

- **npm** — runtime deps get individual PRs; dev deps are grouped into one PR per week to keep review surface manageable.
- **GitHub Actions** — action pin bumps are PRed automatically, preventing slow-drip deprecation warnings (e.g., Node.js 20 → 22 runner transitions, CodeQL v3 → v4 upgrades).

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

A handful of operator endpoints drive LLM calls or queue work on demand — budget-sensitive operations reachable only by the site operator. The Worker gate is the security boundary; Cloudflare Access (when bound) is an additive perimeter that improves UX:

| Layer | Role | Implementation |
|---|---|---|
| **Worker-side gate** (`src/middleware/admin-auth.ts`) | **Security boundary.** Always enforced; sufficient on its own. | Baseline: session cookie + `ADMIN_EMAIL` match. Optional Layer 0 (AD29): `aud`-claim check when `CF_ACCESS_AUD` is set. Implements [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8. |
| **Cloudflare Access** (zone-level) | **Optional UX + perimeter layer.** When bound, redirects unauthenticated browsers to the Access login page. | Not required for the Worker gate to function. Forks and integration deploys without Access bound use the baseline Worker gate alone (AD29). |

The Worker gate enforces checks in order: when `CF_ACCESS_AUD` is set, the request must carry a Cloudflare Access assertion whose `aud` claim matches before the baseline session check runs; returns at the first failing layer with no observable side effect.

### Setting `CF_ACCESS_AUD` and the `*.workers.dev` perimeter (production)

When Access is bound to the custom domain, follow AD30: also bind it to the auto-assigned `*.workers.dev` URL OR disable that subdomain in Workers & Pages → Settings → Domains & Routes. Without this, an attacker hitting the worker via the unbound `workers.dev` URL bypasses the Access perimeter entirely (the baseline Worker gate still enforces session + ADMIN_EMAIL, but the Access layer's promise is broken).

See [Configuration: Setting `CF_ACCESS_AUD`](configuration.md#setting-cf_access_aud-production-when-binding-cloudflare-access) for the full setup flow.

### Paths to gate

Every admin endpoint sits under `/api/admin/*` so a **single wildcard rule** covers them all and any future endpoint added under that prefix.

| Path | What it does |
|---|---|
| `/api/admin/force-refresh` | Manually kicks the global-feed coordinator (every-4-hours cron). Implements [REQ-OPS-005](../sdd/observability.md#req-ops-005-admin-force-refresh-endpoint). Backs phase 1 of the **Run pipeline now** button ([REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-from-the-settings-surface)). |
| `/api/admin/embed-backfill` | Resumable embedding backfill. `POST ?reembed=1` re-embeds the entire corpus (backs the optional wipe phase); plain `POST` drains only `NULL`/`'failed'` rows. Backs phases 0 and 3 of **Run pipeline now** ([REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-from-the-settings-surface)). Implements [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history). See [API Reference](api-reference.md#post-apiadminembed-backfill). |
| `/api/admin/historical-dedup` | Oldest-first cross-article same-story sweep. Backs phase 4 of **Run pipeline now** ([REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-from-the-settings-surface)). Implements [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history) AC 3, AC 9, AC 11. See [API Reference](api-reference.md#post-apiadminhistorical-dedup). |
| `/api/admin/dedup-diag` | Returns cosine similarity, adjusted score, same-vendor penalty, and merge decision for a given article pair. Diagnostic only; no writes. Implements [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history) AC 10-11. See [API Reference](api-reference.md#get-apiadmindedup-diag-req-pipe-003-ac-10-ac-11). |
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

### Dev-bypass runbook (integration only)

`/api/dev/login` is the operator escape hatch for driving admin endpoints from a script when the integration deploy has no Cloudflare Access in front of it (`news.novoselec.ch`). Production (`news.graymatter.ch`) leaves `DEV_BYPASS_TOKEN` unset; the runbook below applies only to integration.

**Two secrets, two failure modes the deploy creates:**

1. `DEV_BYPASS_TOKEN` — pushed by the deploy from the `DEV_BYPASS_TOKEN` GitHub Actions secret. Past deploys have written an empty/encoded value when the GH-side secret push had a CR/LF or trailing-newline issue, leaving `/api/dev/login` returning 404 for a token the local file claims is valid.
2. `DEV_BYPASS_USER_ID` — actively **deleted** by the deploy (`wrangler secret delete DEV_BYPASS_USER_ID`, idempotent). This is intentional — it stops a stale impersonation override from outliving its testing window. Effect for the runbook: every integration deploy reverts the dev-login user to the synthetic `__e2e__` row, which does **not** match `ADMIN_EMAIL`, so admin endpoints return 401/403 even with a valid session cookie.

**After every integration deploy, re-stamp both secrets via the Cloudflare REST API.** Wrangler's `/memberships` preflight fails in this container (token has Workers Scripts edit but not Account Read) — go direct to the secrets endpoint instead:

```bash
# From the operator's local env. ACCOUNT_ID lives in the
# `CLOUDFLARE_ACCOUNT_ID` GitHub Actions repo variable; export it from
# there or copy from the Cloudflare dashboard sidebar before running.
ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID"
WORKER=ai-news-digest-integration

# 1. Re-push DEV_BYPASS_TOKEN from the local source of truth (~/tmp/.bypass_token).
curl -s -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$WORKER/secrets" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg v "$(cat /tmp/.bypass_token)" \
        '{name:"DEV_BYPASS_TOKEN",text:$v,type:"secret_text"}')"

# 2. Set DEV_BYPASS_USER_ID to the operator user_id (from D1 `users` table).
curl -s -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$WORKER/secrets" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg v "$DEV_BYPASS_USER_ID" \
        '{name:"DEV_BYPASS_USER_ID",text:$v,type:"secret_text"}')"
# DEV_BYPASS_USER_ID is the operator's user_id from the D1 `users`
# table (lookup: SELECT id FROM users WHERE email = '<your-email>').
```

Both writes propagate within ~5-10 seconds. Then mint a session and drive any admin endpoint:

```bash
# Mint a session — Origin header is required (the route enforces same-origin POST).
curl -s -X POST "https://news.novoselec.ch/api/dev/login" \
  -H "Authorization: Bearer $(cat /tmp/.bypass_token)" \
  -H "Origin: https://news.novoselec.ch" \
  -c /tmp/cookies.txt -o /dev/null -w "%{http_code}\n"   # expect 200

# Drive any admin endpoint with the cookie + Origin + Accept: application/json.
curl -s -X POST "https://news.novoselec.ch/api/admin/embed-backfill" \
  -b /tmp/cookies.txt \
  -H "Origin: https://news.novoselec.ch" \
  -H "Accept: application/json"
```

**Failure-mode quick-reference:**

| Symptom | Cause | Fix |
|---|---|---|
| `/api/dev/login` returns 404 | `DEV_BYPASS_TOKEN` empty/missing on the worker (deploy push truncated it) | Re-push via REST as above |
| `/api/dev/login` returns 200 but admin route returns 401/403 | `DEV_BYPASS_USER_ID` deleted by deploy → session is `__e2e__`, not admin | Set `DEV_BYPASS_USER_ID` via REST as above |
| `/api/dev/login` returns 403 with "Cross-site POST forbidden" | Missing `Origin: https://news.novoselec.ch` header | Add it; the route enforces same-origin POST |
| Session cookie present but admin still 401 | Session expired (5-minute access-token TTL) | Re-mint via `/api/dev/login` |

The token in `/tmp/.bypass_token` is the canonical local source of truth; treat the GitHub Actions `DEV_BYPASS_TOKEN` secret as derivative — re-push it from `/tmp/.bypass_token` whenever they appear out of sync.

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
