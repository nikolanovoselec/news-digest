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
| Auth | [Better Auth](https://better-auth.com/) + GitHub OAuth provider |
| Database | Cloudflare D1 |
| Sessions | Cloudflare KV |
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
| `/settings` | Hashtag chips, custom hashtag input, time picker, timezone, model dropdown |
| `/digest` | Today's digest — card grid with one-line summaries, "Refresh now" button, execution/cost footer |
| `/digest/:id/:slug` | Article detail — longer summary with critical points and source link |
| `/history` | Past digests, each with its own execution/cost metrics |

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

-- sessions table managed by Better Auth
```

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

Cloudflare Workers. Cron Trigger configured in `wrangler.toml` to run every 15 minutes. D1 and KV bindings provisioned via `wrangler`. GitHub OAuth client ID/secret and Cloudflare account ID configured as Worker secrets.
