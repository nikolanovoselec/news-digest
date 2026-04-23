# Architecture Decision Records

Decisions made during implementation, with rationale.

**Audience:** Developers

Each ADR documents a non-obvious design choice and the trade-offs considered. Decisions cite related requirements via REQ-X-N format.

---

## Decision Index

| ID | Decision | Category | Date |
|----|----------|----------|------|
| AD1 | Custom GitHub OAuth + HMAC-SHA256 JWT, no third-party auth library | Security | 2026-04-22 |
| AD2 | Cloudflare Queues for digest generation under thundering herd | Architecture | 2026-04-22 |
| AD3 | No server-side article-body fetching; summaries from headlines only | Security | 2026-04-22 |
| AD4 | Plaintext-only LLM output; no markdown parser or HTML sanitizer | Security | 2026-04-22 |
| AD5 | KV for caches, D1 for consistent state | Storage | 2026-04-22 |
| AD6 | 5-second client polling instead of SSE or WebSockets for live generation | UI | 2026-04-22 |

---

### AD1: Custom GitHub OAuth + HMAC-SHA256 JWT

**Decision:** Implement sign-in from scratch (~250 lines of TypeScript) instead of adopting Better Auth, Auth.js, or Lucia.

**Context:** Sessions need to be stateless, revocable, and tied to a single-provider (GitHub) OAuth flow. The project has no password, no 2FA, no passkeys, no multi-provider roadmap in MVP.

**Alternatives considered:**
- Better Auth + D1 adapter — pulls in an ORM-ish abstraction; version churn risk.
- Auth.js — heavier dependency footprint; GitHub provider module adds little value here.
- Lucia — deprecated at the time of decision; would have required migration anyway.

**Rationale:** The codeflare repo has a proven pattern at this exact shape. Writing ~250 lines avoids a dependency with ~50 transitive ones, eliminates ORM coupling, and simplifies deployment. Migration to Better Auth later is a bounded one-day project if scope expands.

**Related requirements:** [REQ-AUTH-001](../../sdd/authentication.md#req-auth-001-sign-in-with-github), [REQ-AUTH-002](../../sdd/authentication.md#req-auth-002-session-cookie-and-instant-revocation)

---

### AD2: Cloudflare Queues for digest generation

**Decision:** Use Cloudflare Queues to buffer scheduled and manual digest jobs. Cron dispatches; consumer generates.

**Context:** Target scale is 100 users. Worst realistic case: all 100 schedule the same HH:MM and generate at once. Inline cron generation at concurrency 5 × 60 s per digest = 30 minutes, which exceeds the 15-minute cron wall-time.

**Alternatives considered:**
- Inline cron with concurrency cap 20 — fits wall time (7.5 min) but risks OOM (20 × 5 MB = 100 MB of 128 MB limit) and hits Workers AI per-account concurrency limits.
- `ctx.waitUntil` on refresh only — doesn't solve the scheduled-herd problem.
- Durable Object alarms per user — more precision than needed; adds DO complexity.

**Rationale:** Queues give natural per-message isolation (each job in its own isolate, no shared memory), default 10-wide concurrency with built-in backpressure, and 3-retry semantics. Cron stays a tiny dispatcher. This is the primitive Cloudflare built exactly for this shape of problem.

**Related requirements:** [REQ-GEN-001](../../sdd/generation.md#req-gen-001-scheduled-generation-via-cron-dispatcher), [REQ-GEN-002](../../sdd/generation.md#req-gen-002-manual-refresh-with-rate-limiting)

---

### AD3: No server-side article-body fetching

**Decision:** The system never fetches article pages from the Worker. Summaries are produced from titles and snippets returned by the search APIs.

**Context:** Workers running from Cloudflare datacenter IPs face a real SSRF surface if they resolve arbitrary URLs from external feeds. Reddit and many publishers also rate-limit or block Cloudflare IP ranges, so even if we wanted article bodies, we'd get inconsistent coverage.

**Alternatives considered:**
- Fetch article bodies for richer LLM context, with an SSRF filter.
- Use a residential-IP scraping service.

**Rationale:** Every headline from HN Algolia, Google News RSS, and Reddit includes a title and URL (and often a snippet). Workers AI can rank and summarize from this alone. Dropping the fetch eliminates SSRF entirely, removes Reddit/Google News blocking concerns for our own fetching, and keeps the pipeline fast and simple.

**Related requirements:** [REQ-GEN-003](../../sdd/generation.md#req-gen-003-source-fan-out-with-caching), [REQ-GEN-004](../../sdd/generation.md#req-gen-004-url-canonicalization-and-dedupe)

---

### AD4: Plaintext-only LLM output

**Decision:** The LLM prompt requires plaintext output (no markdown, no HTML); summaries are stored as JSON arrays of plaintext strings and rendered via `textContent`.

**Context:** LLMs can be prompt-injected via hostile article titles to produce markdown with `javascript:` links or `<script>` tags. A markdown parser + HTML sanitizer pipeline is a non-trivial surface to keep secure across dependency updates.

**Alternatives considered:**
- Store markdown, render client-side with `marked` + DOMPurify.
- Store markdown, render server-side with sanitize-html.

**Rationale:** Plaintext + `textContent` makes XSS impossible by construction. One less dependency, one less configuration surface, zero sanitizer updates to track. Detail paragraphs are stored as a `string[]` and rendered via `textContent`, so the same invariant holds regardless of how many paragraphs the LLM returns.

**Related requirements:** [REQ-GEN-005](../../sdd/generation.md#req-gen-005-single-call-llm-summarization), [REQ-READ-002](../../sdd/reading.md#req-read-002-article-detail-view)

---

### AD5: KV for caches, D1 for consistent state

**Decision:** KV holds discovered sources, headlines, and source-health counters. D1 holds users, digests, articles, and pending_discoveries.

**Context:** KV is eventually consistent (~60 s) and globally edge-replicated; D1 is strongly consistent but single-region. Each has a shape it's optimal for.

**Alternatives considered:**
- Put everything in D1 for strong consistency everywhere.
- Put everything in KV for speed.

**Rationale:** Caches tolerate ~60 s lag and benefit from edge reads. Pending discovery work needs transactional semantics (`SELECT ... LIMIT 3` + `DELETE`) that KV's list/scan can't provide cleanly. Using each primitive for what it's designed for keeps both simpler.

**Related requirements:** [REQ-DISC-001](../../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery), [REQ-GEN-003](../../sdd/generation.md#req-gen-003-source-fan-out-with-caching)

---

### AD6: 5-second polling, not SSE or WebSockets

**Decision:** During live generation, the client polls `GET /api/digest/:id` every 5 seconds until `status` is `ready` or `failed`.

**Context:** Generation takes ~60 s. Users mostly see the finished digest via the email link, not live — polling only matters when they manually refresh and stay on the page.

**Alternatives considered:**
- Server-Sent Events streaming phase updates — no clean transport between the Queue consumer and the SSE HTTP handler without adding Durable Objects.
- WebSockets via per-user DO — works for codeflare (terminals), overkill here.

**Rationale:** 12 polling requests over a 60-second generation at 500 bytes each is negligible overhead. No DO complexity, no WebSocket protocol, no phase-update machinery. The UX difference is imperceptible for a one-shot status flip.

**Related requirements:** [REQ-READ-004](../../sdd/reading.md#req-read-004-live-generation-state)

---
