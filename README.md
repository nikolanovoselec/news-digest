# AI News Digest

> Your personalized daily tech news, curated by AI from the topics you actually care about.

Sign in with GitHub. Pick the hashtags that matter to you — `#cloudflare`, `#agenticai`, `#mcp`, whatever. Every morning at the time *you* choose, a Workers AI model reads hundreds of fresh headlines from Hacker News, Google News, Reddit, and feeds it discovers automatically for each of your tags — then writes you a tight, scannable digest. One email lands in your inbox when it's ready.

No feeds to maintain. No algorithm to game. No infinite scroll. Just the ten stories you'd actually read, summarized in plain language, with links back to the source.

---

## Why another digest?

Because every existing option gets it wrong.

- **Newsletters** — someone else's interests, someone else's schedule.
- **RSS readers** — mountains of unread items, none of them summarized.
- **Social feeds** — engagement-optimized noise, not information.
- **LLM chat** — you have to remember to ask.

AI News Digest flips it. *You* declare what you want to follow. The system does the rest, once a day, on your clock. The digest is disposable by design — you read today's, tomorrow brings fresh ten. No guilt about "getting behind".

## What makes it good

- **Tag-driven discovery** — type `#langchain`, get LangChain's blog automatically discovered and monitored. No feed management.
- **Choose your model** — dropdown of Workers AI models from tiny & cheap (Llama 3.2 1B) to frontier (Kimi K2.6). See the per-digest cost before you switch.
- **Transparent** — every digest shows exactly how long it took, how many tokens it burned, and what it cost (in fractions of a cent).
- **Beautiful** — Swiss-minimal reading surface. Dark mode from day one. Installable as a PWA on your phone.
- **Fast** — inline skeleton during generation, email notification when done. Open when ready; never wait.
- **Private** — your hashtags, your digests, your data. GitHub OAuth, nothing stored beyond what's needed, account deletion in one click.

## Stack

Built on Cloudflare's edge. Zero servers to maintain.

| Layer | Choice |
|---|---|
| Framework | [Astro 5](https://astro.build) on [Cloudflare Workers](https://workers.cloudflare.com) |
| Database | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite at the edge) |
| Cache | [Cloudflare KV](https://developers.cloudflare.com/kv/) |
| Job queue | [Cloudflare Queues](https://developers.cloudflare.com/queues/) |
| LLM | [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) |
| Email | [Resend](https://resend.com) |
| Auth | Custom GitHub OAuth + HMAC-SHA256 JWT (no auth library) |
| Styling | Tailwind + system font stack |

## How it works under the hood

1. A Cron Trigger fires every 5 minutes.
2. It finds users whose local HH:MM matches the current window.
3. Enqueues a digest-generation job per user.
4. The Queue consumer fans out fetches across Hacker News, Google News, Reddit, and any tag-specific feeds the system discovered via LLM (validated against SSRF, HTTPS-only, real-feeds only).
5. Three hundred fresh headlines go to your chosen Workers AI model in one call. It picks the top ten and writes plaintext summaries.
6. Stored in D1. Email sent via Resend. Your phone buzzes. You read.

Full spec in [`sdd/`](sdd/README.md). Architecture decisions in [`documentation/decisions/`](documentation/decisions/README.md).

## Status

Building in public. Spec is locked ([40 requirements](sdd/README.md), [10 domains](sdd/), enforce-TDD throughout). Implementation in progress — track progress via `Status: Implemented` in each `sdd/*.md` domain file.

## Documentation

| Document | Purpose |
|---|---|
| [Product Specification](sdd/README.md) | Requirements, acceptance criteria, design intent |
| [Architecture](documentation/architecture.md) | System overview, components, data flow |
| [API Reference](documentation/api-reference.md) | Endpoints + request/response shapes |
| [Configuration](documentation/configuration.md) | Env vars, secrets, Cloudflare bindings |
| [Deployment](documentation/deployment.md) | Local dev + production deploy |
| [Architecture Decisions](documentation/decisions/README.md) | Trade-offs and rationale |

## Local development

```bash
npm install
npx wrangler d1 migrations apply DB --local
npm run dev
```

Dev server at [http://localhost:4321](http://localhost:4321). Copy `.dev.vars.example` to `.dev.vars` and fill in your GitHub OAuth App credentials + a random `OAUTH_JWT_SECRET`.

## License

MIT.

---

*Built with Workers AI. Not affiliated with any news source. Content belongs to the original publishers.*
