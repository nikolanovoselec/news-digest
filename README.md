# News Digest

Keeping up with tech news was a part-time job I didn't sign up for, didn't get paid for, and couldn't quit. So I fired myself and hired an LLM — 99% pay cut, zero complaints. Pick your hashtags: it reads the industry, you read the summaries. You're welcome.

**Live:** <https://news.graymatter.ch> · GitHub sign-in · pick your hashtags · done.

<p align="center">
  <img alt="Mobile dashboard"  src="docs/screenshots/dashboard-mobile.jpg"  height="260">
  <img alt="Desktop dashboard" src="docs/screenshots/dashboard-desktop.png" height="260">
  <img alt="Article detail"    src="docs/screenshots/article-detail.png"    height="260">
</p>

## What's in it

- **20 tags preloaded** (`#ai`, `#cloudflare`, `#postgres`, `#agenticai`…). My opinions, helpfully pre-formed for you. Tap × to drop, `+ add` to add.
- **Composable filters on Search & History** — tag + search + date AND together, all in the URL.
- **Multi-source dedupe** — HN, vendor blog, and three aggregators "discovered" the same story? One card, `(+3)` chip.
- **Summaries that earn their word count** — 150–250 words: *what happened → how it works → why you care*.
- **Hallucinations dropped on sight** — every LLM output echoes its candidate index AND shares a real token with the source title. A fabricated summary never reaches the database. (Ask me how I learned that.)
- **Starred articles outlive the cron** — 7-day retention, unless you starred it. Your saved list is forever; your unread list was a lie anyway.
- **One Worker, no servers** — Cloudflare D1 + KV + Queues + Workers AI. Ships in 30 seconds. Rollback is `wrangler rollback`, which I've used more times than I'd like to admit.

## What's *not* in it

No ads. No cookie banner. No paywall. No newsletter pop-up. No auto-playing video. No exit-intent modal. No chat widget asking if it can help me find what I'm looking for (I was looking for the article, which you covered up, with yourself). No tracking pixels, no Hotjar, no A/B paywall experiment.

No fake news either. The LLM summarises real sources and links straight back. If the source is lying, the source is lying — I just put fewer adjectives on it.

The bar for "doesn't spy on you or sell you anything" is, in fairness, embarrassingly low. I cleared it.

## Why

Newsletters arrive on someone else's clock. RSS readers turn into 3,000-item guilt-trips. Social feeds optimise for outrage. Asking an LLM requires remembering to ask.

News Digest hires the LLM. It remembers so you don't. This isn't enlightenment. This is delegation.

## Codeflare SDD test run

Test drive of [Codeflare](https://codeflare.ch) ([repo](https://github.com/nikolanovoselec/codeflare))'s spec-driven workflow. Every feature: spec first (`sdd/{domain}.md`) → failing test → minimal code annotated `// Implements REQ-X-NNN` → review agents on push → auto-deploy on green.

40+ REQs across 10 domains. The review agents are thorough — they caught me trying to write this paragraph without a REQ. [Spec](sdd/README.md) · [Architecture](documentation/architecture.md) · [Changelog](sdd/changes.md)

## Stack

| Layer | Choice |
|---|---|
| Framework | [Astro 5](https://astro.build) on [Cloudflare Workers](https://workers.cloudflare.com) |
| DB / Cache / Queues | [D1](https://developers.cloudflare.com/d1/) · [KV](https://developers.cloudflare.com/kv/) · [Queues](https://developers.cloudflare.com/queues/) |
| LLM | [Workers AI](https://developers.cloudflare.com/workers-ai/): `gpt-oss-120b` primary, `gpt-oss-20b` fallback |
| Email | [Resend](https://resend.com) |
| Auth | GitHub OAuth + HMAC-SHA256 JWT |

## Local dev

```bash
npm install
npx wrangler d1 migrations apply DB --local
npm run dev
```

Copy `.dev.vars.example` to `.dev.vars`, add GitHub OAuth client ID + secret and a random `OAUTH_JWT_SECRET` (≥32 bytes).

## License

MIT.
