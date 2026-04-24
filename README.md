# ai-news-digest

> A curated, AI-summarised tech news feed for people who opened 47 tabs yesterday and closed them all this morning without reading a single one.

Hi. I'm Nikola. I built this because I could not keep up with tech news, and the existing options were each broken in their own special way:

- **Hacker News** was rewiring my brain into an angry orange rectangle.
- **Twitter / X** kept showing me celebrity feuds next to "top enterprise AI thought leadership".
- **RSS readers** became a 3,218-item mausoleum of unread posts that judged me from the sidebar.
- **Newsletters** were someone else's Monday-morning anxiety, delivered on a schedule I didn't ask for.
- **"Just ask an LLM"** requires remembering to ask. I do not remember. That is the entire problem.

So I made a thing that hires the LLM instead of me.

Every hour, it scrapes ~50 hand-picked tech sources, feeds ~500 freshly-published candidates into GPT-OSS-120B running on Cloudflare Workers AI, and pushes the cleaned-up summaries into a shared pool. My dashboard is a filter over that pool, keyed to the hashtags I care about (`#cloudflare`, `#postgres`, `#agenticai`, `#threat-intel`, etc.). I read the ones that matter. The rest vanish after seven days and I don't feel bad about it.

---

## Screenshots

### Desktop — the whole week's news, filtered to my tags

![Desktop dashboard](docs/screenshots/dashboard-desktop.png)

### Mobile — same feed, thumbed while the coffee brews

<img alt="Mobile dashboard" src="docs/screenshots/dashboard-mobile.jpg" width="320">

### Article detail — serif drop-cap, `Read at source`, nothing else

<img alt="Article detail page" src="docs/screenshots/article-detail.png" width="560">

---

## Why it's good

- **One global scrape, many users.** The LLM runs **once per hour, globally**, across ~50 curated sources — not once per user per refresh. Cost stops scaling with user count.
- **Real summaries, not headlines.** Each article gets 150–250 words, 2–3 paragraphs, structured as *what happened → how it works → why you care*. No "the article explores" filler.
- **Tag-driven everything.** Pick the hashtags that matter. The same tag strip filters the dashboard **and** Search & History. Add a tag from the URL bar, remove it with an ×. It just works.
- **Search + tags + date, all composable.** Tag by `#cloudflare`, search for `london`, scope to the 7-day window — all three combine with AND logic. The result lives in the URL so browser Back actually works.
- **Multi-source dedupe.** When the same story hits Hacker News, the vendor blog, and three aggregators, you see one card with a `(+3)` chip — click for every source in a modal.
- **Stars that survive retention.** Articles older than 7 days get swept — unless you starred them. Your saved list is forever.
- **Design that respects the eyes.** Serif headlines, sans body, tight tracking, real drop-caps on article pages, dark mode day one. No ads. No cookie banners. No "5 things you need to know" clickbait lists.
- **Cloudflare-native.** D1 for the pool, KV for discovery, Queues for the pipeline, Workers AI for the summaries, the whole thing deploys as a single Worker in ~30 seconds.
- **PWA-installable.** Add to home screen. Offline banner if the network drops. 60ms Time to Interactive on a fresh tab.
- **Private by default.** GitHub OAuth, nothing stored beyond what's needed, account deletion works in one click and actually cascades.

---

## About this repo — Codeflare SDD test run

This whole project is a test drive of **[Codeflare](https://codeflare.ai)'s spec-driven development framework** (the `/sdd` skill). Every feature in here landed via the same loop:

1. **Spec edit first** — `sdd/{domain}.md` gets a REQ with Intent + Acceptance Criteria, committed *before* any code touches `src/`.
2. **Failing test** — a `tests/{domain}/*.test.ts` names the REQ ID in its `describe` block and asserts the AC.
3. **Minimal implementation** — source files carry a `// Implements REQ-X-NNN` annotation so the `spec-reviewer` agent can match code to spec by grep.
4. **Review agents on push** — `code-reviewer`, `spec-reviewer`, and `doc-updater` run in the background after every `git push`; findings auto-commit in `unleashed` mode.
5. **CI + auto-deploy** — PR Checks + CodeQL + Scorecard gate every commit; deploy fires automatically on green `main`.

The 40+ REQ entries, per-domain breakdowns, and the full changelog live under [`sdd/`](sdd/README.md). The implementation notes live under [`documentation/`](documentation/). Nothing is hand-waved.

Codeflare itself is a cloud IDE that ships this whole workflow — spec + tests + review agents + auto-deploy — as a single, preconfigured environment. If you've ever wanted a setup where "speccing, implementing, reviewing, deploying" is one loop instead of four manual rituals, go look.

- Codeflare: <https://codeflare.ai>
- This project's spec: [sdd/README.md](sdd/README.md)
- This project's architecture: [documentation/architecture.md](documentation/architecture.md)
- This project's changelog: [sdd/changes.md](sdd/changes.md)

---

## Stack

Built on Cloudflare's edge. Zero servers to maintain.

| Layer | Choice |
|---|---|
| Framework | [Astro 5](https://astro.build) on [Cloudflare Workers](https://workers.cloudflare.com) |
| Database | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite at the edge) |
| Cache | [Cloudflare KV](https://developers.cloudflare.com/kv/) |
| Job queues | [Cloudflare Queues](https://developers.cloudflare.com/queues/) — `scrape-coordinator` + `scrape-chunks` |
| LLM | [Workers AI](https://developers.cloudflare.com/workers-ai/) — `@cf/openai/gpt-oss-120b` primary, `gpt-oss-20b` fallback |
| Email | [Resend](https://resend.com) |
| Auth | Custom GitHub OAuth + HMAC-SHA256 JWT (no auth library) |
| Styling | Global CSS + custom properties + system font stack |

## How the pipeline works

1. Cron fires `0 * * * *` (every hour) → a coordinator queue message.
2. Coordinator fetches all curated sources in parallel (10-worker semaphore), canonical-dedupes URLs, filters out candidates already in D1, chunks survivors into ~50-per-message, enqueues to `scrape-chunks`.
3. Chunk consumer calls Workers AI once per chunk with a JSON-mode prompt. Each output article echoes its input candidate's index; the consumer aligns LLM output to input **by that index**, not by position, with a title-overlap sanity check as a second gate — so a reordered or hallucinated entry can never staple the wrong summary onto a canonical URL.
4. Articles land in a single D1 batch (articles + article_sources + article_tags). Dedup groups collapse "same story, different outlet" into one primary + alt sources.
5. Dashboards and Search & History query this shared pool filtered by each user's hashtags.
6. Daily `0 3 * * *` cleanup drops articles older than 7 days *unless any user has starred them*.

## Local development

```bash
npm install
npx wrangler d1 migrations apply DB --local
npm run dev
```

Dev server at <http://localhost:4321>. Copy `.dev.vars.example` to `.dev.vars` and fill in a GitHub OAuth App client ID/secret + a random `OAUTH_JWT_SECRET` (≥32 bytes).

## License

MIT.

---

*Built with Workers AI. Not affiliated with any news source. Content belongs to the original publishers.*
