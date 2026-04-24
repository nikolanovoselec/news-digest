# News Digest

Try it live: **<https://news.graymatter.ch>** — sign in with GitHub, pick a few hashtags, wait for the next hourly tick.

<p align="center">
  <img alt="Mobile dashboard"  src="docs/screenshots/dashboard-mobile.jpg"  height="260">
  <img alt="Desktop dashboard" src="docs/screenshots/dashboard-desktop.png" height="260">
  <img alt="Article detail"    src="docs/screenshots/article-detail.png"    height="260">
</p>

AI-summarised tech news keyed to the hashtags you actually care about. One global pipeline scrapes ~50 curated sources every hour, runs ~500 fresh candidates through Workers AI, and serves the result as a shared pool. Your dashboard is a filter over that pool, keyed to your tags. You see the stories worth reading; the rest vanish after seven days and you don't have to feel bad about it.

The tag strip is the sole editor for your hashtags — no tag form in settings. Type a tag, hit enter, it's persisted. Tap the × on a chip to drop it. Tap the chip itself to filter. The same strip lives on Search & History with counts scoped to the 7-day window, so you can narrow *"cloudflare articles from this week that mention 'london'"* in three taps.

Articles show a 2–3 paragraph summary (150–250 words, structured as *what happened / how it works / why you care*), a star toggle, and a tag count badge. Multi-source stories (vendor blog + Hacker News mirror + aggregator) collapse into one card with a `(+N)` chip; the detail-page `Read at source` button fans them out in a modal when tapped. The lead paragraph on the detail page gets a newspaper-style drop-cap via CSS `initial-letter: 2`, with a tuned float fallback for browsers that don't support it yet. The back control returns you to wherever you came from — search results, starred list, history day view — not always `/digest`.

## Why it was built

Tech-news discovery in 2026 is broken in specific ways:

- Newsletters arrive on someone else's schedule with someone else's interests.
- RSS readers turn into 3,000-item graveyards that judge you from the sidebar.
- Social feeds reward outrage over information.
- Asking an LLM requires remembering to ask, which defeats the point.

News Digest flips the contract. You declare what you want to follow; the pipeline does the rest, once an hour, on its clock. You read what matters; the rest expires. There's no "unread count" to feel guilty about — if an article's still around in seven days and nobody starred it, it gets swept.

## About this repo — Codeflare SDD test run

This project is a test drive of [Codeflare](https://codeflare.ch)'s spec-driven development framework. Every feature landed via the same loop:

1. **Spec edit first** — `sdd/{domain}.md` gets a REQ with Intent + Acceptance Criteria, committed before any code touches `src/`.
2. **Failing test** — a `tests/{domain}/*.test.ts` names the REQ ID in its `describe` block and asserts the AC.
3. **Minimal implementation** — source files carry a `// Implements REQ-X-NNN` annotation so `spec-reviewer` can match code to spec by grep.
4. **Review agents on push** — `code-reviewer`, `spec-reviewer`, and `doc-updater` run in the background after every push; findings auto-commit in `unleashed` mode.
5. **CI + auto-deploy** — PR Checks + CodeQL + Scorecard gate every commit; deploy fires on green `main`.

40+ REQs across 10 domains, with `enforce_tdd: true`. Nothing is hand-waved. The three review agents are the enforcement layer: `spec-reviewer` keeps `sdd/` honest, `code-reviewer` catches quality and security regressions, `doc-updater` keeps `documentation/` in sync with what shipped. A finding that's HIGH or CRITICAL blocks a green main; everything else auto-fixes on the next push.

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
