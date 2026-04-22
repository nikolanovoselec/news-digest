# news-digest

A personalized daily tech news digest. Sign in with GitHub, pick your interests as hashtags, and get an AI-curated digest once per day at a time you choose. No feeds to manage — hashtags drive what gets scraped.

## How it works

1. **Sign in with GitHub** — account is created on first login
2. **Pick your interests** — tap hashtags from 20 defaults or type your own
3. **Set your digest time** — one scheduled generation per day in your timezone
4. **Read** — overview grid with one-line summaries, click any card for the full brief with source link
5. **Refresh on demand** — manual "refresh now" button any time

Every digest shows execution time, token count, and estimated cost, so you can see what the LLM actually did.

## Stack

| Layer | Choice |
|---|---|
| Framework | Astro 5 on Cloudflare Workers |
| Theme base | [AstroPaper](https://github.com/satnaing/astro-paper) (MIT, minimal reading surface) |
| Auth | Custom GitHub OAuth + HMAC-SHA256 session JWT (no auth library) |
| Database | Cloudflare D1 |
| Sessions | Stateless JWT in HttpOnly cookie |
| LLM | Workers AI (user-selectable model) |
| Scheduling | Cloudflare Cron Trigger (scans every 15 min) |
| Styling | Tailwind CSS 4 |

## Content sources

No feed table, no OPML, no per-user feed management. For each hashtag the user has selected, four free query-able sources are hit in parallel at generation time:

| Source | Endpoint | Purpose |
|---|---|---|
| Google News RSS | `news.google.com/rss/search?q={tag}+when:1d` | General tech news coverage, last 24h |
| Hacker News (Algolia) | `hn.algolia.com/api/v1/search_by_date?query={tag}&tags=story` | Developer-focused stories |
| Reddit | `reddit.com/search.json?q={tag}&t=day&sort=top` | Community discussion signal |
| arXiv | `export.arxiv.org/api/query?search_query=all:{tag}` | Research papers (for AI/ML tags) |

Results are deduplicated by resolved URL, then a single LLM call ranks the top 10 across all hashtags and writes the one-line + longer summary for each.

**Google News caveat**: Google News links redirect through `news.google.com/articles/...`. We resolve the final URL with a HEAD request before storing so the source link points to the real publisher.

## Default hashtag proposals

Shown as toggleable chips on the settings page. User may select any subset and add custom hashtags.

```
#cloudflare  #agenticai  #mcp         #aws            #aigateway
#llm         #ragsystems #vectordb    #workersai      #durableobjects
#typescript  #rust       #webassembly #edgecompute    #postgres
#openai      #anthropic  #opensource  #devtools       #observability
```

## Model selection

The settings page renders a dropdown populated from the Cloudflare API:

```
GET https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/models/search?task=Text+Generation
```

The result is cached in KV for one hour. The dropdown displays each model's name and description; the selected model ID is stored on the user row. The model used for each digest is also stored on the digest row, so the history view shows which model produced each result.

**Default**: `@cf/meta/llama-3.1-8b-instruct-fast`.

## Pages

| Route | Purpose |
|---|---|
| `/` | Landing page with "Sign in with GitHub" |
| `/onboarding` | First-run configuration: hashtags, digest time, model. Only reachable before first digest is set up. |
| `/settings` | Same form as onboarding, edit-mode. Also hosts logout, account deletion, install-app prompt |
| `/digest` | Today's digest — card grid with one-line summaries, "Refresh now" button, execution/cost footer |
| `/digest/:id/:slug` | Article detail — longer summary with critical points and source link |
| `/history` | Past digests, each with its own execution/cost metrics |

## Onboarding flow

First-run experience after a brand-new user signs in with GitHub.

```
1. GitHub OAuth callback creates the users row (github_id, email, tz) — tz is
   captured from the browser via Intl.DateTimeFormat().resolvedOptions().timeZone
   and posted to the callback as a query param from the landing page.
2. Callback checks if hashtags IS NULL OR digest_hour IS NULL.
   - Yes  → redirect to /onboarding
   - No   → redirect to /digest
3. /onboarding is a single-page form with three inline sections:
   a. Interests — 20 default hashtag chips, custom text input, min 1 required
   b. Schedule — hour picker (0-23, local time). Timezone shown read-only as
      "detected: Europe/Zurich" with no edit control.
   c. Model — Workers AI model dropdown, default pre-selected, collapsible
      "Advanced" disclosure hides this by default.
4. Submit button: "Generate my first digest".
5. On submit: UPDATE users SET hashtags, digest_hour, model_id, then trigger
   the digest pipeline immediately and redirect to /digest with a loading
   state while generation runs.
```

### Middleware gating

Every authenticated request checks: if `hashtags IS NULL OR digest_hour IS NULL` AND path is not `/onboarding` or an auth route → redirect to `/onboarding`. Once both are set, visiting `/onboarding` redirects to `/settings` (edit-mode reuse of the same form component).

### Timezone handling

Captured once at first login from the browser and stored on the users row. Not user-editable. If the browser's timezone changes between visits (user travels), the app continues to use the stored value unless the user explicitly re-logs in. Cron scans compute each user's "due" moment as `digest_hour` interpreted in their stored `tz`.

## Data model (D1)

```sql
users (
  id              TEXT PRIMARY KEY,
  github_id       TEXT UNIQUE,
  email           TEXT,
  tz              TEXT,               -- IANA timezone
  digest_hour     INTEGER,            -- 0-23 local time
  hashtags        TEXT,               -- comma-separated
  model_id        TEXT,               -- Workers AI model id
  next_due_at     INTEGER,            -- unix ts, for cron scan
  created_at      INTEGER
)

digests (
  id              TEXT PRIMARY KEY,
  user_id         TEXT,
  generated_at    INTEGER,
  execution_ms    INTEGER,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  model_id        TEXT,
  status          TEXT                -- pending | ready | failed
)

articles (
  id              TEXT PRIMARY KEY,
  digest_id       TEXT,
  source_url      TEXT,
  title           TEXT,
  one_liner       TEXT,               -- <=120 chars
  detail_md       TEXT,               -- longer summary, markdown
  published_at    INTEGER,
  rank            INTEGER
)

-- no sessions table: sessions are stateless JWTs in HttpOnly cookies
```

## Authentication

Custom implementation, no third-party auth library. Pattern lifted from the codeflare repo — proven, ~250 lines of TypeScript, zero ORM or dependency churn.

### Flow

```
/api/auth/github/login
  1. Generate random UUID for CSRF state
  2. Set oauth_state cookie (HttpOnly, Secure, SameSite=Lax, 5 min TTL)
  3. Redirect to github.com/login/oauth/authorize with client_id, redirect_uri,
     scope=user:email, state

/api/auth/github/callback
  1. Validate state cookie === state query param (reject 403 if mismatch)
  2. Clear oauth_state cookie
  3. POST code to github.com/login/oauth/access_token → access token
  4. GET api.github.com/user and /user/emails in parallel → extract primary
     verified email, numeric id, login
  5. INSERT OR IGNORE into users (github_id, email, ...) for JIT provisioning
  6. Sign HMAC-SHA256 JWT with { sub: github_id, email, ghLogin, iat, exp }
  7. Set news_digest_session cookie (HttpOnly, Secure, SameSite=Lax, 1h TTL)
  8. Redirect to /digest

/api/auth/github/logout
  1. Clear news_digest_session cookie (Max-Age=0)
  2. Redirect to /
```

### Session validation

Every protected Astro route and API endpoint calls a shared helper that reads `news_digest_session`, verifies the HMAC signature with `OAUTH_JWT_SECRET`, checks `exp`, and returns the user row from D1. Unauthenticated requests redirect to `/`.

### Session auto-refresh

A middleware runs on every response. If the JWT has less than 15 minutes remaining, it issues a fresh 1-hour JWT and updates the cookie. Users stay signed in as long as they visit at least once per hour.

### Secrets

Deployed via `wrangler secret put`:

| Secret | Purpose |
|---|---|
| `OAUTH_CLIENT_ID` | GitHub OAuth App client ID |
| `OAUTH_CLIENT_SECRET` | GitHub OAuth App client secret |
| `OAUTH_JWT_SECRET` | Random 32+ char string for HMAC signing |
| `CLOUDFLARE_API_TOKEN` | For the Workers AI models catalog lookup |

### Why no auth library

- Single provider (GitHub), no passwords, no 2FA, no passkeys, no teams — library features we'd never use
- Stateless JWT + 1h TTL means a stolen token dies quickly even without a revocation list
- No ORM dependency pulled in by Better Auth / Auth.js adapters
- If scope later demands multi-provider, passkeys, or session management UI, a one-day migration to Better Auth is bounded — not worth paying that cost up front

## Generation pipeline

```
1. Cron Worker runs every 15 min
2. SELECT users WHERE next_due_at <= now()
3. For each due user (or on manual refresh):
   a. For each hashtag, fan out 4 queries (Google News, HN, Reddit, arXiv)
   b. Dedupe by resolved URL
   c. Single Workers AI call with selected model:
      "User cares about [hashtags]. From these N headlines, pick top 10
       and return {title, url, one_liner, detail}"
   d. Insert digest + articles rows, capturing execution_ms and token usage
   e. Update users.next_due_at to next local digest_hour
4. Manual refresh: same pipeline, rate-limited to once per 5 min per user
```

## Cost and time transparency

Every digest view renders a footer like:

```
Generated 07:59 CET  ·  2.4s  ·  3,847 tokens  ·  ~$0.0012  ·  llama-3.1-8b-instruct-fast
```

Values come from the `execution_ms`, `tokens_in + tokens_out`, and `model_id` columns on the digest row. Cost is computed from the model's published per-token price.

## What is explicitly out of scope for MVP

- Email delivery (read in-app only)
- Multiple digests per day
- Slack, Telegram, or RSS output
- OPML import, user-added feeds
- Sharing, bookmarking, cross-user recommendations
- Embeddings or vector search (single LLM call handles ranking)
- R2 archive of digest HTML (D1 stores markdown directly; digests are small)

These may be revisited after v1 ships.

## Deployment

Cloudflare Workers. Cron Trigger configured in `wrangler.toml` to run every 15 minutes. D1 and KV bindings provisioned via `wrangler` (KV is used only for caching the Workers AI model catalog, not for sessions). GitHub OAuth client ID/secret, `OAUTH_JWT_SECRET`, and Cloudflare API token configured as Worker secrets.
