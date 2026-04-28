# Architecture Decision Records

Decisions made during implementation, with rationale.

**Audience:** Developers

Each ADR documents a non-obvious design choice and the trade-offs considered. Decisions cite related requirements via REQ-X-N format.

---

## Decision Index

| ID | Decision | Category | Date |
|----|----------|----------|------|
| AD1 | Custom federated OAuth/OIDC (GitHub, Google) + HMAC-SHA256 JWT, no third-party auth library | Security | 2026-04-22 |
| AD2 | Cloudflare Queues for digest generation under thundering herd | Architecture | 2026-04-22 |
| AD3 | Server-side article-body fetching with SSRF guard *(revised 2026-04-27)* | Security | 2026-04-27 |
| AD4 | Plaintext-only LLM output; no markdown parser or HTML sanitizer | Security | 2026-04-22 |
| AD5 | KV for caches, D1 for consistent state | Storage | 2026-04-22 |
| AD6 | Polling instead of SSE or WebSockets for scrape-run progress | UI | 2026-04-22 |
| AD7 | D1 for chunk completion tracking, replacing KV read-modify-write (CF-002) | Storage | 2026-04-27 |

---

### AD1: Custom federated OAuth/OIDC (GitHub, Google) + HMAC-SHA256 JWT

**Decision:** Implement sign-in from scratch (~250 lines of TypeScript) instead of adopting Better Auth, Auth.js, or Lucia.

**Context:** Sessions need to be stateless, revocable, and tied to an OAuth/OIDC authorization-code flow. The project has no password, no 2FA, no passkeys. The implementation supports multiple providers (GitHub, Google) via a shared provider registry — each provider adds one registry entry and a `fetchProfile` adapter, with no per-provider branching in the auth routes.

**Alternatives considered:**
- Better Auth + D1 adapter — pulls in an ORM-ish abstraction; version churn risk.
- Auth.js — heavier dependency footprint; GitHub provider module adds little value here.
- Lucia — deprecated at the time of decision; would have required migration anyway.

**Rationale:** The codeflare repo has a proven pattern at this exact shape. Writing ~250 lines avoids a dependency with ~50 transitive ones, eliminates ORM coupling, and simplifies deployment. Migration to Better Auth later is a bounded one-day project if scope expands.

**Related requirements:** [REQ-AUTH-001](../../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider), [REQ-AUTH-002](../../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation)

---

### AD2: Cloudflare Queues for digest generation

**Decision:** Use Cloudflare Queues to buffer scheduled and manual digest jobs. Cron dispatches; consumer generates.

**Context:** Target scale is 100 users. Worst realistic case: all 100 schedule the same HH:MM and generate at once. Inline cron generation at concurrency 5 × 60 s per digest = 30 minutes, which exceeds the 15-minute cron wall-time.

**Alternatives considered:**
- Inline cron with concurrency cap 20 — fits wall time (7.5 min) but risks OOM (20 × 5 MB = 100 MB of 128 MB limit) and hits Workers AI per-account concurrency limits.
- `ctx.waitUntil` on refresh only — doesn't solve the scheduled-herd problem.
- Durable Object alarms per user — more precision than needed; adds DO complexity.

**Rationale:** Queues give natural per-message isolation (each job in its own isolate, no shared memory), default 10-wide concurrency with built-in backpressure, and 3-retry semantics. Cron stays a tiny dispatcher. This is the primitive Cloudflare built exactly for this shape of problem.

**Related requirements:** [REQ-GEN-001](../../sdd/generation.md#req-gen-001-scheduled-generation-via-cron-dispatcher), [REQ-GEN-002](../../sdd/generation.md#req-gen-002-manual-refresh-with-rate-limiting) *(Deprecated 2026-04-23 — superseded by REQ-PIPE-001)*

---

### AD3: Server-side article-body fetching with SSRF guard

**Decision (2026-04-27):** The chunk consumer fetches article HTML bodies for candidates whose feed snippet is below 400 characters. Fetches are SSRF-guarded, time-bounded, and size-capped; a failed fetch falls back to the feed snippet, never blocking a summary.

**Context:** Workers running from Cloudflare datacenter IPs face a real SSRF surface if they resolve arbitrary URLs from external feeds. Many publishers also rate-limit or block Cloudflare IP ranges. The original posture was therefore "no server-side fetch at all" — summaries from titles and feed snippets only.

**Why the original posture was reversed:** under the global-feed pipeline (REQ-PIPE-001 AC 8) feed snippets are often too short to ground a useful summary, and the SSRF concern is mitigated by an SSRF denylist filter in `src/lib/ssrf.ts` (HTTPS-only; rejects private, loopback, link-local, CGNAT, IPv6 ULA, and metadata-host destinations), an 8-second timeout, and a 1.5 MB download cap. Readable plaintext is extracted and used as the prompt snippet when it is longer than the feed snippet. Fan-out is bounded-concurrency via `src/lib/concurrency.ts` (`mapConcurrent`, 20 workers).

**Alternatives considered:**
- Keep the no-fetch posture and accept thin summaries on short-snippet feeds.
- Use a residential-IP scraping service.

**Rationale:** The SSRF guard and the size/time caps reduce the original risk to negligible. Richer prompt context measurably improved summary quality on short-snippet feeds.

**History:** The original AD3 (2026-04-22) prohibited any server-side fetching; superseded by this entry on 2026-04-27 during the global-feed rework.

**Related requirements:** [REQ-GEN-003](../../sdd/generation.md#req-gen-003-source-fan-out-with-caching), [REQ-GEN-004](../../sdd/generation.md#req-gen-004-url-canonicalization-and-dedupe), [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence)

---

### AD4: Plaintext-only LLM output

**Decision:** The LLM prompt requires plaintext output (no markdown, no HTML); summaries are stored as JSON arrays of plaintext strings and rendered via `textContent`.

**Context:** LLMs can be prompt-injected via hostile article titles to produce markdown with `javascript:` links or `<script>` tags. A markdown parser + HTML sanitizer pipeline is a non-trivial surface to keep secure across dependency updates.

**Alternatives considered:**
- Store markdown, render client-side with `marked` + DOMPurify.
- Store markdown, render server-side with sanitize-html.

**Rationale:** Plaintext + `textContent` makes XSS impossible by construction. One less dependency, one less configuration surface, zero sanitizer updates to track. Detail paragraphs are stored as a `string[]` and rendered via `textContent`, so the same invariant holds regardless of how many paragraphs the LLM returns. The constraint survived the 2026-04-23 global-feed rework (which retired the per-user generation REQs REQ-GEN-002/006) and now applies via REQ-PIPE-002.

**Related requirements:** [REQ-GEN-005](../../sdd/generation.md#req-gen-005-single-call-llm-summarization), [REQ-PIPE-002](../../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract), [REQ-READ-002](../../sdd/reading.md#req-read-002-article-detail-view)

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

### AD6: Polling for scrape-run progress, not SSE or WebSockets

**Decision:** While a scrape run is in progress, the client polls `GET /api/scrape-status` every 5 seconds to drive the "Update in progress" indicator and the Force Refresh progress display on `/settings`.

**Context:** Scrape runs take ~60 s end-to-end. Users mostly see finished articles on their next visit; real-time progress is a quality-of-life indicator for operators watching `/settings` after triggering a force-refresh. The per-user live-generation polling pattern (REQ-READ-004, deprecated 2026-04-23) is no longer applicable — the dashboard always renders from the article pool.

**Alternatives considered:**
- Server-Sent Events streaming phase updates — no clean transport between the Queue consumer and the SSE HTTP handler without adding Durable Objects.
- WebSockets via per-user DO — works for codeflare (terminals), overkill here.

**Rationale:** Polling `GET /api/scrape-status` (one D1 SELECT + one KV get) is negligible overhead at the operator-only volume this endpoint serves. No DO complexity, no WebSocket protocol, no phase-update machinery. The UX difference is imperceptible for a one-shot status flip.

**Related requirements:** [REQ-PIPE-006](../../sdd/generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress)

---

### AD7: D1 for chunk completion tracking, replacing KV read-modify-write

**Decision:** Move the "last chunk done" gate from a KV decrement (`scrape_run:{id}:chunks_remaining`) to a D1 `INSERT OR IGNORE` + `SELECT COUNT(*)` pattern on a dedicated `scrape_chunk_completions` table, with a follow-up conditional `UPDATE scrape_runs SET finalize_enqueued = 1 WHERE finalize_enqueued = 0` to gate the finalize handoff.

**Context (CF-002):** The original KV implementation used a read-modify-write decrement: each chunk consumer read the counter, decremented it, and wrote it back. Under Cloudflare Queues' at-least-once delivery, two concurrent last-chunk consumers could both read the same value before either wrote, producing the same decremented target — both would see "zero remaining" and both would enqueue a second finalize pass and double-stamp the run as `ready`. A second race remained after the count check: both consumers could pass the count check and both call `SCRAPE_FINALIZE.send` before either set the KV gate. KV's eventual consistency made both races effectively undetectable via testing in non-adversarial conditions.

**Alternatives considered:**
- Durable Object for serialized counter updates — correct, but adds a DO dependency to a pipeline that runs without one today.
- KV with Compare-And-Swap (`getWithMetadata` + `put` with `expirationTtl` as a CAS surrogate) — fragile; KV has no native CAS and the surrogate is not atomic.

**Rationale:** AD5's own principle applies directly: completion counting needs transactional semantics. `INSERT OR IGNORE` into a table keyed by `(scrape_run_id, chunk_index)` is idempotent under redelivery and gives an exact count via `SELECT COUNT(*)` — no race. The finalize-enqueue gate is collapsed into a single atomic `UPDATE … WHERE finalize_enqueued = 0`; D1 returns `meta.changes` for exactly one consumer. The KV counter (`scrape_run:{id}:chunks_remaining`) is retained as a derived mirror for the `/api/scrape-status` progress display but is no longer authoritative. Implements [REQ-PIPE-002](../../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract) and [REQ-PIPE-008](../../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass) AC 1 and AC 9.

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-PIPE-002](../../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract), [REQ-PIPE-008](../../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass)

---

## Related Documentation

- [Architecture](../architecture.md) — System overview and component map
- [Configuration](../configuration.md) — Env vars, bindings, KV key conventions

---
