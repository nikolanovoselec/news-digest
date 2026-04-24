# Constraints

Cross-cutting architectural and technology decisions that apply to every domain.

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | Astro on Cloudflare Workers | Server-rendered Astro with the `astrojs/cloudflare` adapter; islands for interactive UI only where needed. |
| Database | Cloudflare D1 | Strong consistency for users, digests, articles, pending discoveries. |
| Cache / KV | Cloudflare KV | Eventually-consistent edge-distributed cache for discovered sources, headlines, source health. |
| Job queue | Cloudflare Queues | Single `digest-jobs` queue absorbs thundering herds; consumer runs with isolate-per-message concurrency. |
| LLM | Cloudflare Workers AI | Model user-selectable from a hardcoded `MODELS` list; prompts centralized in `src/lib/prompts.ts`. |
| Email | Resend | Transactional "your digest is ready" notifications with verified sending domain. |
| Auth | Custom GitHub OAuth + HMAC-SHA256 JWT | Pattern adopted from the codeflare repo; no third-party auth library. |
| PWA | `@vite-pwa/astro` | Manifest, service worker, install prompt. |
| Styling | Tailwind CSS 4 | Utility classes + CSS custom properties for theme tokens. |
| Base theme | AstroPaper (MIT) | Minimal reading surface; auth/settings UI built on top. |

## Non-Functional Requirements

### CON-TECH-001: Cloudflare Workers runtime

The app runs entirely on the Cloudflare Workers runtime. No Node-only APIs are used. All persistence is Cloudflare-native (D1, KV, Queues).

**Applies To:** All source code

### CON-AUTH-001: Custom GitHub OAuth + HMAC-SHA256 JWT

Authentication is implemented without a third-party auth library. Sessions are stateless HMAC-SHA256 JWTs stored in an `__Host-` prefixed HttpOnly+Secure+SameSite=Lax cookie. The pattern is adopted from the codeflare repo (~250 lines). Revocation is handled via a `session_version` integer on the users row.

**Applies To:** Authentication domain

### CON-SEC-001: Strict content security policy

All responses include a strict CSP with no inline scripts (`script-src 'self'`), HSTS with preload, `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and a locked-down `Permissions-Policy`. The theme-init script is served as an external file with `defer`, accepting a small first-paint theme flash in exchange for CSP simplicity.

**Applies To:** All responses

### CON-SEC-002: No server-side article-body fetching

The system never issues server-side GET requests to article URLs. LLM summaries are produced from titles and snippets returned by the search APIs. This eliminates SSRF, redirect-chasing, and bot-detection concerns entirely.

**Applies To:** Digest generation, source discovery

### CON-SEC-003: Plaintext-only LLM output

The LLM prompt requires plaintext output (no markdown, no HTML). Article summaries are stored as JSON arrays of plaintext strings and rendered via `textContent`. No markdown parser, no HTML sanitizer. XSS is impossible by construction.

**Applies To:** Digest generation, reading experience

### CON-A11Y-001: Accessibility minimum

WCAG 2.1 AA is the floor. Full keyboard navigation, visible focus rings, semantic landmarks, skip-to-content link. All motion respects `prefers-reduced-motion`. Theme selection respects `prefers-color-scheme` as the default when no user override is set.

**Applies To:** All user-facing pages

### CON-PERF-001: 100-user thundering-herd target

The architecture is sized to handle up to 100 users who may all schedule their digest at the same local HH:MM. Generation is queue-buffered; the cron dispatcher runs in <1 second regardless of user count. Discovery processes up to 3 tags per 5-minute invocation.

**Applies To:** Digest generation, source discovery

### CON-COST-001: Target monthly cost ≈ $42 at 100 users

Budget expectations: Workers Paid (~$21/mo including Workers AI Neurons) + Resend Pro (~$20/mo) + domain (~$1/mo). D1 and KV fit within free tiers at this scale.

**Applies To:** Operational planning

### CON-DATA-001: Strong consistency in D1, edge cache in KV

D1 stores users, digests, articles, and pending_discoveries — anything where a read-after-write race would produce wrong behavior. KV stores caches (discovered sources, headlines, source health) where ~60-second eventual consistency is tolerable.

**Applies To:** All persistence

### CON-LLM-001: Centralized deterministic prompts

All LLM prompts (digest generation, source discovery) live in `src/lib/prompts.ts` with shared inference parameters: `temperature: 0.2`, `max_tokens: 4096`, `response_format: { type: 'json_object' }`. Prompts fence user-controlled content with triple backticks to limit prompt injection.

**Applies To:** Digest generation, source discovery

## Boundaries

Things the system intentionally does NOT do:

- **Fetch article page bodies** — see CON-SEC-002
- **Use a third-party auth library** — see CON-AUTH-001
- **Support multiple digests per day per user** — one scheduled + rate-limited manual refreshes
- **Persist cache state in D1** — caches live in KV; D1 is reserved for consistent state
- **Render user-generated or LLM-generated markdown / HTML** — plaintext only, rendered via `textContent`
- **Rely on Durable Objects or WebSockets** — polling every 5 seconds is the progress transport
