# News Digest

Tech news for people who would rather read ten good summaries than three thousand unread RSS items.

**Live:** <https://news.graymatter.ch> · GitHub sign-in · pick your hashtags · wait for the next tick · done.

<p align="center">
  <img alt="Mobile dashboard"  src="docs/screenshots/dashboard-mobile.jpg"  height="260">
  <img alt="Desktop dashboard" src="docs/screenshots/dashboard-desktop.png" height="260">
  <img alt="Article detail"    src="docs/screenshots/article-detail.png"    height="260">
</p>

Every 4 hours, ~50 curated sources get scraped, ~500 fresh candidates get batched into ~10 chunks and fed to GPT-OSS-120B on [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/), and the output lands in a shared pool. Your dashboard is a filter over that pool. The rest expires in seven days. Your inbox is left alone.

## Features

- **One global LLM run, every user benefits.** GPT-OSS-120B summarises the whole pool every 4 hours, billed to my Cloudflare account, not yours, and way cheaper than the coffee I was going to drink while ignoring Hacker News anyway.
- **20 tags preloaded.** New accounts land with a curated starter set (`#ai`, `#cloudflare`, `#postgres`, `#agenticai`…). Tap × on any chip to drop it. Tap `+ add` to add your own. No settings form, no onboarding wizard.
- **Composable filters on Search & History.** Tag + search + date all AND together and live in the URL, so browser Back restores the exact view. *"cloudflare articles this week mentioning london"* is three taps.
- **Multi-source dedupe.** HN, the vendor blog, and three aggregators all "discovered" the same story at 9am. You get one card with a `(+3)` chip.
- **Summaries that earn their word count.** 150–250 words in 2–3 paragraphs: *what happened → how it works → why you care*. No "the article explores" filler.
- **LLM hallucinations dropped on sight.** Every output must echo its input index **and** share a meaningful token with the candidate title. A reordered or fabricated summary never reaches the database. Ask me how I learned this lesson.
- **Starred articles outlive the cron.** Seven-day retention, unless you starred it. Your saved pile is forever; your unread pile is a lie you're no longer telling yourself.
- **One Worker. No servers, no Docker, no Nginx dying at 3 am.** Cloudflare D1 + Cloudflare KV + Cloudflare Queues + Cloudflare Workers AI. Ships in 30 seconds.
- **No ads. None. Zero.** Also no cookie banners, no newsletter pop-ups, no "accept all" dark patterns, no paywall that promises "just one free article this month". PWA-installable, dark mode, offline banner. A list of things the internet taught us to tolerate and didn't need to.

## Why it exists

Tech news in 2026 has four shapes, all broken:

- **Newsletters.** Someone else's interests, someone else's schedule, someone else's Monday-morning anxiety delivered on their clock.
- **RSS readers.** 3,218 unread items side-eyeing you from the sidebar. Each one is a tiny "I told you so".
- **Social feeds.** Outrage optimised for engagement, which is not the same thing as information.
- **Asking an LLM.** Requires remembering to ask. If remembering were the user's strong suit, none of this would be a problem.

News Digest hires the LLM instead. Every 4 hours, 6 times a day. On its own clock.

## Built with Codeflare SDD

This repo is a test drive of [Codeflare](https://codeflare.ch)'s spec-driven development framework. Every feature travels through the same loop:

1. **Spec first.** A REQ with Intent + Acceptance Criteria lands in `sdd/{domain}.md` before any code touches `src/`.
2. **Failing test.** `tests/{domain}/*.test.ts` names the REQ ID and asserts the AC.
3. **Minimal code.** Source files carry `// Implements REQ-X-NNN` so `spec-reviewer` can grep code against spec.
4. **Review agents on every push.** `code-reviewer`, `spec-reviewer`, `doc-updater` run in the background. Findings auto-commit in `unleashed` mode.
5. **Auto-deploy on green.** PR Checks + CodeQL + Scorecard gate every commit. Deploy fires on a green `main`.

40+ REQs across 10 domains, `enforce_tdd: true`, nothing hand-waved. [Spec](sdd/README.md) · [Architecture](documentation/architecture.md) · [Changelog](sdd/changes.md)

## Stack

| Layer | Choice |
|---|---|
| Framework | [Astro 5](https://astro.build) on [Cloudflare Workers](https://workers.cloudflare.com) |
| Database | [Cloudflare D1](https://developers.cloudflare.com/d1/) |
| Cache | [Cloudflare KV](https://developers.cloudflare.com/kv/) |
| Job queues | [Cloudflare Queues](https://developers.cloudflare.com/queues/) |
| LLM | [Workers AI](https://developers.cloudflare.com/workers-ai/). `gpt-oss-120b` primary, `gpt-oss-20b` fallback |
| Email | [Resend](https://resend.com) |
| Auth | GitHub OAuth + HMAC-SHA256 JWT |

## Local development

```bash
npm install
npx wrangler d1 migrations apply DB --local
npm run dev
```

Dev server at <http://localhost:4321>. Copy `.dev.vars.example` to `.dev.vars`, drop in a GitHub OAuth App client ID + secret and a random `OAUTH_JWT_SECRET` (≥32 bytes).

## License

MIT.
