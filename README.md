# News Digest

Keeping up with tech news was a part-time job I didn't sign up for, didn't get paid for, and couldn't quit. So I fired myself and hired an LLM — 99% pay cut, zero complaints. Pick your hashtags: it does the reading, you take the credit. You're welcome.

**Live:** <https://news.graymatter.ch> · GitHub or Google sign-in · pick your hashtags · done.

<p align="center">
  <img alt="Mobile dashboard"  src="docs/screenshots/dashboard-mobile.jpg"  height="260">
  <img alt="Desktop dashboard" src="docs/screenshots/dashboard-desktop.png" height="260">
  <img alt="Article detail"    src="docs/screenshots/article-detail.png"    height="260">
</p>

## What's in it

- **20 tags preloaded** (`#ai`, `#cloudflare`, `#postgres`, `#agenticai`…). My opinions, helpfully pre-formed for you. Tap × to drop, `+ add` to add.
- **Composable filters on Search & History** — tag + search + date AND together, all in the URL.
- **Multi-source dedupe** — HN, vendor blog, and three aggregators "discovered" the same story? One card, `(+3)` chip.
- **Summaries that earn their word count** — 150–200 words: *what happened → how it works → why you care*.
- **Hallucinations dropped on sight** — every LLM output echoes its candidate index AND shares a real token with the source title. A fabricated summary never reaches the database. (Ask me how I learned that.)
- **Starred articles outlive the cron** — 7-day retention, unless you starred it. Your saved list is forever; your unread list was a lie anyway.
- **One Worker, no servers** — Cloudflare D1 + KV + Queues + Workers AI. Ships in 30 seconds. Rollback is `wrangler rollback`, which I've used more times than I'd like to admit.

## What's *not* in it

No ads. No cookie banner. No paywall. No newsletter pop-up. No auto-playing video. No exit-intent modal. No chat widget asking if it can help me find what I'm looking for (I was looking for the article, which you covered up, with yourself). No tracking pixels, no Hotjar, no A/B paywall experiment.

No fake news either. The LLM summarises real sources and links straight back. If the source is lying, the source is lying — I just put fewer adjectives on it.

The bar for "doesn't spy on you or sell you anything" is, in fairness, embarrassingly low. I cleared it.

## Why

Honestly? I wanted to read news like it's 1995 — before ads outnumbered words and every outlet copy-pasted the same wire story under a different headline. The internet promised choice. It delivered the same article, twelve times, behind twelve cookie banners.

Newsletters arrive on someone else's clock. RSS readers turn into 3,000-item guilt-trips. Social feeds optimise for outrage. Asking an LLM requires remembering to ask.

News Digest hires the LLM. It remembers so you don't. This isn't enlightenment. This is delegation.

## Built with Codeflare's spec-driven development framework

This project was built end-to-end as a real-world test of [Codeflare](https://codeflare.ch) ([repo](https://github.com/nikolanovoselec/codeflare))'s **spec-driven development** (SDD) framework. Every feature follows the same loop: write the contract first in `sdd/{domain}.md`, write a failing test that names the requirement (`REQ-X-NNN`), write the minimal code to make it pass with an `// Implements REQ-X-NNN` annotation, then push — three review agents (code, spec, docs) run automatically and the deploy fires on green.

The result: 40+ written requirements across 10 product domains (auth, generation, reading, history, email, etc.), each with a test that proves it works and a source file that points back to it. [Spec](sdd/README.md) · [Architecture](documentation/architecture.md) · [Changelog](sdd/changes.md)

## Stack

| Layer | Choice |
|---|---|
| Framework | [Astro 5](https://astro.build) on [Cloudflare Workers](https://workers.cloudflare.com) |
| DB / Cache / Queues | [D1](https://developers.cloudflare.com/d1/) · [KV](https://developers.cloudflare.com/kv/) · [Queues](https://developers.cloudflare.com/queues/) |
| LLM | [Workers AI](https://developers.cloudflare.com/workers-ai/): `gpt-oss-120b` primary, `gpt-oss-20b` fallback |
| Email | [Resend](https://resend.com) |
| Auth | GitHub OAuth + Google OIDC + HMAC-SHA256 JWT |

## Deploy your own

Three steps. The Deploy workflow handles D1, KV, queues, migrations, and secret push — no `wrangler deploy` from your laptop.

1. **Fork the repo.** You know how.

2. **Set repo secrets.** In your fork: `Settings` > `Secrets and variables` > `Actions` > `New repository secret`. Four required, plus at least one OAuth provider pair (GitHub or Google or both — the landing page renders one button per configured provider, alphabetical).

   - `CLOUDFLARE_API_TOKEN` — see [token scopes](#api-token-scopes) below
   - `CLOUDFLARE_ACCOUNT_ID` — find it on any zone overview in the Cloudflare dashboard
   - `OAUTH_JWT_SECRET` — HMAC key for session cookies. Generate: `openssl rand -base64 32`
   - `APP_URL` — canonical origin (your `*.workers.dev` URL or custom domain)

3. **Run the Deploy workflow.** `Actions` > `Deploy` > `Run workflow` > Branch: `main` > **Run workflow**. Takes ~2 minutes. Future pushes to `main` deploy automatically.

<details>
<summary><strong>Full secret reference (OAuth providers, optional integrations)</strong></summary>

| Secret | Required | What it's for |
|---|---|---|
| `GH_OAUTH_CLIENT_ID` | one provider pair required | GitHub OAuth App client id. Create at github.com → Settings → Developer settings → OAuth Apps → New. Authorization callback URL is `<APP_URL>/api/auth/github/callback`. The `GH_` prefix (not `GITHUB_`) is mandatory — GitHub Actions reserves the `GITHUB_*` namespace for its built-in tokens. |
| `GH_OAUTH_CLIENT_SECRET` | with the id | Generated alongside the GitHub client id. Server-side only. |
| `GOOGLE_OAUTH_CLIENT_ID` | one provider pair required | Google OAuth 2.0 client id. Create at console.cloud.google.com → APIs & Services → Credentials → OAuth client ID → Web application. Authorized redirect URI is `<APP_URL>/api/auth/google/callback`. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | with the id | Generated alongside the Google client id. Server-side only. |
| `RESEND_API_KEY` | optional | [Resend](https://resend.com) key for the daily "your digest is ready" email. When unset, digests still generate in the app — only the email step is skipped. |
| `RESEND_FROM` | optional | Sender address (e.g. `News Digest <hello@yourdomain.com>`). Required when `RESEND_API_KEY` is set. |
| `DEV_BYPASS_TOKEN` | optional | Enables `/api/dev/login` for `scripts/e2e-test.sh`. When unset, the endpoint returns 404. |

A pair with only one field set is rejected by the deploy workflow so a half-configured provider never reaches runtime.

</details>

<details>
<summary><strong>API token scopes</strong></summary>
<a id="api-token-scopes"></a>

Custom token via [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens):

| Scope | Permission | Access | Why |
|---|---|---|---|
| Account | Workers Scripts | Edit | Deploys the Worker |
| Account | Workers KV Storage | Edit | Auto-creates the KV namespace |
| Account | D1 | Edit | Auto-creates the D1 database and applies migrations |
| Account | Queues | Edit | Auto-creates `scrape-coordinator` and `scrape-chunks` |
| Account | Workers AI | Read | LLM inference for summaries + source discovery |
| Zone | Zone | Read | Only when binding a custom domain — discovers the zone |
| Zone | Workers Routes | Edit | Only when binding a custom domain — attaches the hostname |

The Zone scopes are skipped automatically when `APP_URL` is a `*.workers.dev` URL.

</details>

<details>
<summary><strong>What the workflow does</strong></summary>

1. Resolves (or creates) the D1 database, KV namespace, and queues via [`scripts/bootstrap-resources.sh`](scripts/bootstrap-resources.sh)
2. Applies D1 migrations
3. Pushes Worker secrets (Resend pair skipped when unset)
4. `wrangler deploy`
5. Binds `APP_URL` to the Worker (skipped on `*.workers.dev`)
6. Smoke-tests `GET /` returns 200

</details>

<details>
<summary><strong>Custom domain only: gate the admin endpoints</strong></summary>

Three operator endpoints under `/api/admin/*` (force-refresh + re-discover) need an extra gate so other signed-in users can't trigger them. Cloudflare Access at the zone level — [setup walkthrough](documentation/deployment.md#admin-only-routes-cloudflare-access-gating). On `*.workers.dev` your account is already the only signed-in user, so this step is unnecessary.

</details>

## Local dev

```bash
npm install
npx wrangler d1 migrations apply DB --local
npm run dev
```

Copy `.dev.vars.example` to `.dev.vars`, add at least one OAuth client ID + secret pair (GitHub, Google, or both) and a random `OAUTH_JWT_SECRET` (≥32 bytes).

## License

MIT.
