# Architecture Decision Records

<!-- doc-allow-large: index + full ADR bodies colocated by design; individual ADRs cannot be split without breaking cross-references -->

Decisions made during implementation, with rationale.

**Audience:** Developers

Each ADR documents a non-obvious design choice and the trade-offs considered. Decisions cite related requirements via REQ-X-N format.

---

## Decision Index

| ID | Decision | Category | Date |
|----|----------|----------|------|
| AD1 | Custom federated OAuth/OIDC (GitHub, Google) + HMAC-SHA256 JWT, no third-party auth library | Security | 2026-04-22 |
| AD2 | Cloudflare Queues for digest generation under thundering herd | Architecture | 2026-04-22 |
| AD3 | Server-side article-body fetching with SSRF guard | Security | 2026-04-27 |
| AD4 | Plaintext-only LLM output; no markdown parser or HTML sanitizer | Security | 2026-04-22 |
| AD5 | KV for caches, D1 for consistent state | Storage | 2026-04-22 |
| AD6 | Polling instead of SSE or WebSockets for scrape-run progress | UI | 2026-04-22 |
| AD7 | D1 for chunk completion tracking, replacing KV read-modify-write (CF-002) | Storage | 2026-04-27 |
| AD8 | Cookie attributes are the security contract — kept inline in REQ-AUTH-002/003 | Security | 2026-05-03 |
| AD9 | Storage-shape names (D1 columns, KV keys) are the persistence contract — kept inline in REQ-DISC/AUTH/SET | Storage | 2026-05-03 |
| AD10 | Atomic conditional UPDATE as the once-per-run idempotency gate — no `acquireOnceLock` helper | Architecture | 2026-05-03 |

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

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence). Original framing was for the per-user generation pipeline (REQ-GEN-001, REQ-GEN-002, both Deprecated 2026-04-23 in the global-feed rework); the queue mechanism survived the rework intact.

---

### AD3: Server-side article-body fetching with SSRF guard

**Status:** Accepted (supersedes AD3-original, 2026-04-22, which prohibited server-side fetching)

**Decision:** When a feed snippet is too thin to ground a useful summary, the chunk consumer fetches the article body directly. Each fetch is SSRF-guarded, time-bounded (8 s), and size-capped (1.5 MB); a failed fetch falls back to the snippet, never blocking a summary.

**Context:** The original AD3 (2026-04-22) banned all server-side fetching to avoid SSRF risk and Cloudflare-range rate-limiting by publishers. Reversed on 2026-04-27 during the global-feed rework when it became clear that feed snippets are often too short to summarise faithfully, and that an SSRF denylist plus strict timeout and size caps reduce the original risk to negligible. Richer prompt context measurably improved summary quality on short-snippet feeds.

**Alternatives considered:**
- Keep the no-fetch posture and accept thin summaries on short-snippet feeds.
- Use a residential-IP scraping service.

**Rationale:** An SSRF denylist, 8 s timeout, and 1.5 MB size cap bring the risk to negligible. Fan-out is bounded-concurrency at 20 workers. The quality improvement on short-snippet feeds justifies the added complexity.

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) AC 8

---

### AD4: Plaintext-only LLM output

**Decision:** The LLM prompt requires plaintext output (no markdown, no HTML); summaries are stored as JSON arrays of plaintext strings and rendered via `textContent`.

**Context:** LLMs can be prompt-injected via hostile article titles to produce markdown with `javascript:` links or `<script>` tags. A markdown parser + HTML sanitizer pipeline is a non-trivial surface to keep secure across dependency updates.

**Alternatives considered:**
- Store markdown, render client-side with `marked` + DOMPurify.
- Store markdown, render server-side with sanitize-html.

**Rationale:** Plaintext + `textContent` makes XSS impossible by construction. One less dependency, one less configuration surface, zero sanitizer updates to track. Detail paragraphs are stored as a `string[]` and rendered via `textContent`, so the same invariant holds regardless of how many paragraphs the LLM returns. The constraint survived the 2026-04-23 global-feed rework (which retired the per-user generation REQs REQ-GEN-002/006) and now applies via REQ-PIPE-002.

**Related requirements:** [REQ-PIPE-002](../../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract), [REQ-READ-002](../../sdd/reading.md#req-read-002-article-detail-view) (original decision applied to REQ-GEN-005, Deprecated 2026-04-23, Replaced By REQ-PIPE-002)

---

### AD5: KV for caches, D1 for consistent state

**Decision:** KV holds discovered sources, headlines, and source-health counters. D1 holds users, digests, articles, and pending_discoveries.

**Context:** KV is eventually consistent (~60 s) and globally edge-replicated; D1 is strongly consistent but single-region. Each has a shape it's optimal for.

**Alternatives considered:**
- Put everything in D1 for strong consistency everywhere.
- Put everything in KV for speed.

**Rationale:** Caches tolerate ~60 s lag and benefit from edge reads. Pending discovery work needs transactional semantics (`SELECT ... LIMIT 3` + `DELETE`) that KV's list/scan can't provide cleanly. Using each primitive for what it's designed for keeps both simpler.

**Related requirements:** [REQ-DISC-001](../../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery), [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) (original decision applied to REQ-GEN-003, Deprecated 2026-04-23, Replaced By REQ-PIPE-001)

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

**Context (CF-002):** The original KV implementation used a read-modify-write decrement: each chunk consumer read the counter, decremented it, and wrote it back. Under Cloudflare Queues' at-least-once delivery, this exposed two races:

1. **Decrement race:** two concurrent last-chunk consumers read the same value before either wrote. Both saw "zero remaining", both enqueued a finalize pass, and both stamped the run as `ready`.
2. **Send-gate race:** even if the count check held, both consumers could call `SCRAPE_FINALIZE.send` before either set the KV gate.

KV's eventual consistency made both races effectively undetectable via testing in non-adversarial conditions.

**Alternatives considered:**
- Durable Object for serialized counter updates — correct, but adds a DO dependency to a pipeline that runs without one today.
- KV with Compare-And-Swap (`getWithMetadata` + `put` with `expirationTtl` as a CAS surrogate) — fragile; KV has no native CAS and the surrogate is not atomic.

**Rationale:** AD5's own principle applies directly: completion counting needs transactional semantics. `INSERT OR IGNORE` into a table keyed by `(scrape_run_id, chunk_index)` is idempotent under redelivery and gives an exact count via `SELECT COUNT(*)` — no race. The finalize-enqueue gate is collapsed into a single atomic `UPDATE … WHERE finalize_enqueued = 0`; D1 returns `meta.changes` for exactly one consumer. The KV counter (`scrape_run:{id}:chunks_remaining`) is retained as a derived mirror for the `/api/scrape-status` progress display but is no longer authoritative. Implements [REQ-PIPE-002](../../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract) and [REQ-PIPE-008](../../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass) AC 1 and AC 9.

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-PIPE-002](../../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract), [REQ-PIPE-008](../../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass)

---

### AD8: Cookie attributes are the security contract

**Status:** Accepted (2026-05-03)

**Overrides:** `mechanism-leakage:REQ-AUTH-002`, `mechanism-leakage:REQ-AUTH-003`

**Decision:** Keep the session-cookie attributes (`__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`) inline in REQ-AUTH-002 AC 1 and REQ-AUTH-003 AC 3. Treat them as part of the security contract, not implementation detail.

**Context:** `spec-discipline.md`'s mechanism-leakage rule lists cookie attributes as belonging in `documentation/security.md` and recommends rewriting AC bullets to user-observable consequences (e.g., "JavaScript on the page cannot read the session token"). A `/sdd clean` run on 2026-05-03 escalated this as a MEDIUM JUDGMENT against the two auth REQs.

**Alternatives considered:**
- Rewrite AC 1 to user-observable language and create `documentation/security.md` with the attribute table behind a backlink.
- Add to `sdd/.user-overrides.md` as an opaque skip entry (today's mechanism, but hides the decision from anyone reading the codebase — see [codeflare#266](https://github.com/nikolanovoselec/codeflare/issues/266)).

**Rationale:**
- The attributes are load-bearing identifiers — security reviewers grep `__Host-`, `HttpOnly`, `SameSite=Lax` directly to verify the contract holds in source, tests, and the rendered Set-Cookie header.
- Translating to user-observable language loses information: the AC then doesn't constrain whether `__Host-` vs `__Secure-` prefix is used, doesn't pin the SameSite policy, doesn't require Path scoping. A future contributor reading the AC would not know the contract still constrains these.
- Same precedent as the existing `email_enabled` exception in `sdd/.user-overrides.md` (column name IS the contract because it's the shared identifier across UI, DB, dispatcher).

**Consequences:**
- spec-reviewer skips these two REQs via the `Overrides:` header above.
- Future cookie-policy changes update both the affected REQ AC and this ADR (and the corresponding security tests) in lockstep.
- `documentation/security.md` is not required by this decision — when it is eventually written, it backlinks here, not the other way around.

**Related requirements:** [REQ-AUTH-002](../../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation), [REQ-AUTH-003](../../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

---

### AD9: Storage-shape names are the persistence contract

**Status:** Accepted (2026-05-03)

**Overrides:** `mechanism-leakage:REQ-DISC-001`, `mechanism-leakage:REQ-DISC-002`, `mechanism-leakage:REQ-AUTH-002`, `mechanism-leakage:REQ-SET-001`, `mechanism-leakage:REQ-SET-005`

**Decision:** Keep D1 column names (`session_version`, `hashtags_json`, `digest_hour`, `email_enabled`, `pending_discoveries`) and KV key shapes (`sources:{tag}`) inline in their respective REQs' acceptance criteria. Treat them as part of the persistence contract surface, not implementation detail.

**Context:** `spec-discipline.md`'s mechanism-leakage rule lists "database column names" and "internal storage shapes" as belonging in `documentation/architecture.md` schema sections. A `/sdd clean` run on 2026-05-03 escalated this as a MEDIUM JUDGMENT against five REQs across the Discovery, Authentication, and Settings domains.

**Alternatives considered:**
- Rewrite each AC to describe the user-visible behavior abstractly, with a doc-backlink to a schema section in `documentation/architecture.md`.
- Add per-REQ entries to `sdd/.user-overrides.md` as opaque skip rules (today's mechanism, see [codeflare#266](https://github.com/nikolanovoselec/codeflare/issues/266)).
- Split each REQ into a behavior REQ (in `sdd/`) and a schema doc (in `documentation/`) — substantial AC reshape risk.

**Rationale:**
- These names are the load-bearing identifiers shared across SQL, the Workers runtime, and any future migration tooling. They are how `INSERT OR IGNORE INTO pending_discoveries`, `SELECT session_version FROM users`, and `KV.get('sources:' + tag)` are written in source — and how reviewers grep to verify a behavior holds.
- Same precedent as the existing `email_enabled` exception in `sdd/.user-overrides.md` (the column name IS the contract noun shared across UI, DB, dispatcher).
- The mechanism-leakage rule was authored against frontend-heavy projects where storage names are usually behind ORM abstractions. This project is intentionally close-to-the-metal (raw SQL strings, no ORM, KV keys hand-built) — the storage names are *the* user-facing surface for anyone who runs migrations or writes new queries.

**Consequences:**
- spec-reviewer skips these five REQs via the `Overrides:` header above.
- Schema changes update both the affected REQ AC and this ADR (and the corresponding migration files) in lockstep.
- `documentation/architecture.md` references the storage shapes in §4.2 (libraries) and §4.5 (Worker, queue, and migrations); `documentation/configuration.md` documents the KV bindings and naming conventions. This ADR explains why those high-level references coexist with the inline persistence names in the REQs.

**Related requirements:** [REQ-DISC-001](../../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery), [REQ-DISC-002](../../sdd/discovery.md#req-disc-002-discovery-progress-visibility), [REQ-AUTH-002](../../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation), [REQ-SET-001](../../sdd/settings.md#req-set-001-unified-first-run-and-edit-flow), [REQ-SET-005](../../sdd/settings.md#req-set-005-email-notification-preference)

---

### AD10: Atomic conditional UPDATE as the once-per-run idempotency gate

**Status:** Accepted (2026-05-03)

**Decision:** Idempotency for once-per-scrape-run side effects (queue-finalize enqueue, finalize stats fold) is enforced by a single conditional `UPDATE` against a dedicated `scrape_runs` column with a `WHERE col = 0` clause. The caller inspects `meta.changes` to decide whether to proceed (`changes === 1` → won the race) or short-circuit (`changes === 0` → another isolate already won). No separate `acquireOnceLock(...)` helper is introduced.

**Context:** Two existing call sites use this shape today: (a) `scrape-chunk-consumer.ts` flips `finalize_enqueued` 0→1 to gate the `SCRAPE_FINALIZE.send` (REQ-PIPE-008 AC 3); (b) `scrape-finalize-consumer.ts` flips `finalize_recorded` 0→1 inside the same UPDATE that also folds tokens + cost into the run's totals (REQ-PIPE-008 AC 5/AC 7). Code-review on 2026-04-29 (CF-026) flagged the duplicated shape and proposed a generic `acquireOnceLock(db, table, id, column)` helper.

**Alternatives considered:**
- **`acquireOnceLock` helper:** generic boolean-returning wrapper. The chunk-consumer site fits cleanly, but the finalize-consumer site fuses the gate with the per-attempt stats fold inside one atomic statement — extracting a bare "did I win?" helper would force splitting that into a lock + a separate UPDATE, losing the atomicity that protects against a transient mid-statement error leaving the gate flipped without the stats recorded.
- **`scrape_run_locks` keyed table** (one row per `scrape_run_id` × `lock_name`): cleaner if the number of gates grows beyond two. Today's two-site count doesn't justify the migration + new repo layer; revisit when a third gate would land.

**Rationale:**
- The pattern is two lines of SQL plus a meta.changes check. Wrapping it in a function adds an indirection the reader must follow with no ergonomics win on the call sites that exist.
- The composite UPDATE in finalize-consumer is genuinely load-bearing for atomicity — refactoring to "lock then stats" would re-introduce the failure mode that the consolidated atomic UPDATE was specifically designed (in PR #166) to eliminate.
- Source-grep for `WHERE finalize_recorded = 0` and `WHERE finalize_enqueued = 0` is sufficient to find every gate site; the duplication is at the syntactic surface, not at the semantic level.

**Consequences:**
- Both gate sites stay inline. Each is documented in-place with the `meta.changes` semantics and a comment explaining why the WHERE clause carries the gate value.
- The third gate that would warrant the keyed-table refactor is treated as the trigger; this ADR is the artifact future readers find when they look for "why isn't there an `acquireOnceLock` helper?".
- New gate sites SHOULD copy the pattern verbatim and document the meta.changes semantics inline; if a fourth or fifth site lands without the trigger refactor, this ADR is the place to revisit.

**Related requirements:** [REQ-PIPE-008](../../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass)

---

## Related Documentation

- [Architecture](../architecture.md) — System overview and component map
- [Configuration](../configuration.md) — Env vars, bindings, KV key conventions

---
