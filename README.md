# News Digest

AI-summarised tech news keyed to the hashtags you actually care about. One global pipeline scrapes ~50 curated sources every hour, summarises ~500 candidates per run via Workers AI, and serves the result as a shared pool that your dashboard filters down to your tags.

<p align="center">
  <img alt="Mobile dashboard" src="docs/screenshots/dashboard-mobile.jpg" width="320">
</p>

---

## Screenshots

**Desktop — the full pool filtered to your tags**

![Desktop dashboard](docs/screenshots/dashboard-desktop.png)

**Article detail — serif drop-cap, direct Read-at-source, nothing else**

![Article detail page](docs/screenshots/article-detail.png)

---

## Features

- Global scrape — the LLM runs once per hour across all users, not once per user per refresh. Cost stops scaling with user count.
- Tag-driven filtering — pick the hashtags that matter. The same tag strip works on the dashboard and on Search & History.
- Composable filters — tag + search + date-scope, all combined with AND logic. Result lives in the URL so browser Back works.
- 150–250 word summaries — 2-3 paragraphs, structured as *what happened / how it works / why you care*. No filler.
- Multi-source dedupe — the same story across Hacker News, vendor blog, and aggregators collapses into one card with a `(+N)` chip and a modal listing every source.
- Starred-retention carve-out — articles older than 7 days get swept by the daily cleanup cron, unless any user has starred them.
- Title-overlap sanity check — defends against LLM misalignment (the chunk consumer requires each output article to echo its input candidate's index AND share at least one non-stopword token with the candidate's title).
- PWA-installable, dark mode, offline banner, no ads, no cookie banner.
- GitHub OAuth, custom HMAC-SHA256 JWT, account deletion cascades.

## About this repo — Codeflare SDD test run

This project is a test drive of [Codeflare](https://codeflare.ch)'s spec-driven development framework. Every feature landed via the same loop:

1. **Spec edit first** — `sdd/{domain}.md` gets a REQ with Intent + Acceptance Criteria, committed before any code touches `src/`.
2. **Failing test** — a `tests/{domain}/*.test.ts` names the REQ ID in its `describe` block and asserts the AC.
3. **Minimal implementation** — source files carry a `// Implements REQ-X-NNN` annotation so `spec-reviewer` can match code to spec by grep.
4. **Review agents on push** — `code-reviewer`, `spec-reviewer`, and `doc-updater` run in the background after every push; findings auto-commit in `unleashed` mode.
5. **CI + auto-deploy** — PR Checks + CodeQL + Scorecard gate every commit; deploy fires on green `main`.

40+ REQs across 10 domains, with `enforce_tdd: true`. Nothing is hand-waved.

- Codeflare: <https://codeflare.ch>
- Specification: [sdd/README.md](sdd/README.md)
- Architecture: [documentation/architecture.md](documentation/architecture.md)
- Changelog: [sdd/changes.md](sdd/changes.md)

## Stack

| Layer | Choice |
|---|---|
| Framework | [Astro 5](https://astro.build) on [Cloudflare Workers](https://workers.cloudflare.com) |
| Database | [Cloudflare D1](https://developers.cloudflare.com/d1/) |
| Cache | [Cloudflare KV](https://developers.cloudflare.com/kv/) |
| Job queues | [Cloudflare Queues](https://developers.cloudflare.com/queues/) — `scrape-coordinator` + `scrape-chunks` |
| LLM | [Workers AI](https://developers.cloudflare.com/workers-ai/) — `@cf/openai/gpt-oss-120b` primary, `gpt-oss-20b` fallback |
| Email | [Resend](https://resend.com) |
| Auth | Custom GitHub OAuth + HMAC-SHA256 JWT |

## Pipeline

1. Cron `0 * * * *` → coordinator queue message.
2. Coordinator fetches all curated sources in parallel (10-worker semaphore), canonical-dedupes URLs, filters out candidates already in D1, chunks survivors into ~50-per-message, enqueues to `scrape-chunks`.
3. Chunk consumer calls Workers AI once per chunk with a JSON-mode prompt. Each output article echoes its input candidate's index; the consumer aligns LLM output to input by that echoed value plus a title-overlap check — so a reordered or hallucinated entry can never staple the wrong summary onto the wrong canonical URL.
4. Articles land in a single D1 batch. Dedup groups collapse "same story, different outlet" into one primary + alt sources.
5. Dashboard + Search & History query this shared pool filtered by each user's hashtags.
6. Daily `0 3 * * *` cleanup drops articles older than 7 days unless any user has starred them.

## Local development

```bash
npm install
npx wrangler d1 migrations apply DB --local
npm run dev
```

Dev server at <http://localhost:4321>. Copy `.dev.vars.example` to `.dev.vars` and fill in a GitHub OAuth App client ID/secret plus a random `OAUTH_JWT_SECRET` (≥32 bytes).

## License

MIT.
