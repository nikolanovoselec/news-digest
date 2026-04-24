# news-digest — Product Specification

## Vision

A personalized daily tech news digest. Users sign in with GitHub, curate interests as hashtags, and receive an AI-curated digest at their chosen time each day. Swiss-minimal reading experience with cost transparency on every digest, email notifications, and PWA-installable on mobile.

## Actors

| Actor | Description |
|-------|-------------|
| **User** | A signed-in GitHub user curating hashtags and reading digests |

"System" (cron, Queue consumer, service worker) is a qualifier, not an actor.

## Design Principles

1. **Simplicity first, efficiency second, UX third** — every component must earn its weight against these priorities, in that order
2. **Content follows explicit interest** — hashtags drive every fetch and every LLM ranking decision; there is no implicit recommendation engine
3. **Transparency by default** — every digest surfaces execution time, token count, and estimated cost, so users always know what it took to produce
4. **Email is the completion signal** — the app never demands real-time attention; client polling is only a fallback for active-page manual refresh
5. **Beautiful reading is MVP, not v2** — Swiss-minimal aesthetic with purposeful motion and dark mode are part of the first ship
6. **Strong consistency where decisions hinge on it, edge caching everywhere else** — D1 for user/digest/queue state, KV for caches that tolerate eventual consistency
7. **Security by construction** — no inline scripts, no server-side fetching of article bodies, LLM output rendered as plaintext only

## Domains

| # | Domain | File | Priority | Description |
|---|--------|------|----------|-------------|
| 1 | Authentication | [authentication.md](authentication.md) | P0 | GitHub OAuth, HMAC-JWT sessions, revocation, CSRF, auth rate limiting, account deletion |
| 2 | Onboarding & Settings | [settings.md](settings.md) | P0 | First-run flow, hashtag curation, schedule (HH:MM + tz), model selection, email toggle |
| 3 | Source Discovery | [discovery.md](discovery.md) | P0 | LLM-assisted per-tag feed discovery, SSRF-filtered validation, health tracking, retry |
| 4 | Digest Generation | [generation.md](generation.md) | P0 | Cron dispatcher, Queue consumer, source fan-out, LLM summarization, rate limits, stuck-sweeper |
| 5 | Reading Experience | [reading.md](reading.md) | P0 | Overview grid, article detail with bullets, loading/error states, polling, read tracking |
| 6 | Email Notifications | [email.md](email.md) | P0 | Resend integration, digest-ready template, per-user email_enabled toggle |
| 7 | History & Stats | [history.md](history.md) | P1 | Past digests paginated, stats widget (digests, articles read, tokens, cost) |
| 8 | Design System | [design.md](design.md) | P0 | Typography, palette, light/dark toggle, motion, prefers-reduced-motion |
| 9 | PWA & Mobile | [pwa.md](pwa.md) | P1 | Manifest, service worker, offline, install prompt, mobile layout, safe-area insets |
| 10 | Observability | [observability.md](observability.md) | P1 | Structured JSON logs, sanitized error surfaces, security headers |

## Out of Scope

The following were considered and intentionally excluded from the MVP:

- **Multiple digests per day** — one scheduled run per user per local day, with rate-limited manual refreshes
- **Slack, Telegram, or RSS output channels** — email is the only notification channel in MVP
- **User-added feeds / OPML import** — discovery via LLM + generic search APIs covers both default and custom hashtags without per-user feed management
- **Sharing, bookmarking, cross-user recommendations** — the product is personal, not social
- **Embeddings or vector search** — a single LLM call handles ranking; embeddings would add a dependency without measurable quality gain at this scale
- **Fetching article page bodies** — summaries are produced from search-API headlines and snippets; this eliminates an entire class of SSRF risk
- **Admin actor / multi-tenancy** — single actor (User) for MVP
- **Cloudflare WAF-based OAuth rate limiting** — infrastructure policy, not product behaviour; handled outside the spec if ever needed
- **Sender domain verification walkthrough** — operational setup task; deployment docs already cover Resend DNS configuration
- **Offline reading via service worker cache** — PWA installability (REQ-PWA-001) ships without offline content caching; the dashboard requires network on launch

## Constraints

See [constraints.md](constraints.md) for the cross-cutting technology stack and CON-* guardrails.

## Glossary

See [glossary.md](glossary.md) for canonical term definitions.

## Documentation

Implementation documentation lives in `documentation/`:
- [`architecture.md`](../documentation/architecture.md) — System overview, components, data flow
- [`api-reference.md`](../documentation/api-reference.md) — All API endpoints
- [`configuration.md`](../documentation/configuration.md) — Env vars, secrets, bindings
- [`deployment.md`](../documentation/deployment.md) — Dev setup and deployment steps
- [`decisions/README.md`](../documentation/decisions/README.md) — Architecture Decision Records

## Changelog

See [changes.md](changes.md) for specification history.
