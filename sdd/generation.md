# Digest Generation

A global scrape-and-summarise pipeline that runs every 4 hours: one cron-triggered coordinator run per tick assembles candidates from the curated source registry, canonical-URL-dedupes them, and fans chunks out to the LLM consumer. The consumer writes summaries + tags + cluster groupings into a shared article pool. The per-user dashboard then reads from that pool filtered by each user's active tags, so cost scales with the world (one LLM pass per tick) rather than with users × refreshes. Starred articles survive the 14-day retention cutoff.

---

### REQ-PIPE-001: Global scrape-and-summarise pipeline on a fixed cadence

**Intent:** One shared scrape per cadence feeds every user's dashboard, so adding users does not multiply LLM spend — the system runs the LLM the same number of times whether 10 people are signed up or 10,000. The pipeline is independent of individual user accounts: it runs once per tick regardless of how many users are signed up.

**Applies To:** Admin

**Acceptance Criteria:**
1. A Cron Trigger fires every 4 hours on the hour (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC) and kicks off a single coordinator run for all users.
2. The coordinator partitions candidates across one or more chunk jobs whose size is capped to fit the model's context window so LLM calls stay within budget and partial failures only lose one chunk.
3. Each run is tracked by a `scrape_runs` row that transitions `running` → `ready` on success (or `failed` on abort), with a chunk counter that drops to zero when the last chunk finishes.
4. Article-pool ingestion (URL deduplication, source-list aggregation, first-ingestion timestamp preservation, and per-item publisher resolution) is governed by [REQ-PIPE-017](#req-pipe-017-article-pool-ingestion-contract).
5. Body-fetch behaviour for candidates with thin feed snippets is governed by [REQ-PIPE-010](#req-pipe-010-body-fetch-for-thin-feed-snippets).
6. Every tag in the union of (default-seed hashtags ∪ curated source tags ∪ discovered KV tags) gets a per-tag Google News query-RSS source added to the tick's source list as a long-tail backstop. Tags already served by a bespoke hand-tuned Google News curated entry are skipped (no double-fetch). The aggregator-vs-direct dedup pass already prefers a direct publisher copy over a Google News copy that lands in the same tick, so wide GN fan-out gives every tag baseline coverage without polluting the article pool with aggregator duplicates when direct sources also surface the story.
7. A run that has been waiting on its scrape phase to complete for longer than the configured budget exits with a failed status rather than looping silently. The dashboard surfaces the failed state on the next history refresh so the operator sees the stall promptly and can re-kick the pipeline, instead of the run staying in `running` indefinitely until queue retries exhaust.

**Constraints:** [CON-LLM-001](constraints.md#con-llm-001-centralized-deterministic-prompts), [CON-PERF-001](constraints.md#con-perf-001-100-user-thundering-herd-target), [CON-SEC-002](constraints.md#con-sec-002-outbound-article-body-fetches-flow-through-the-ssrf-guarded-helper)

**Priority:** P0

**Dependencies:** [REQ-PIPE-004](#req-pipe-004-curated-source-registry-with-50-feeds-spanning-the-21-system-tags), [REQ-PIPE-010](#req-pipe-010-body-fetch-for-thin-feed-snippets), [REQ-PIPE-011](#req-pipe-011-candidate-filtering-rules), [REQ-PIPE-017](#req-pipe-017-article-pool-ingestion-contract)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-PIPE-017: Article-pool ingestion contract

**Intent:** When candidate URLs land in the global pipeline, the pool deduplicates on canonical URL, aggregates source lists across re-discoveries, preserves first-ingestion timestamps so dashboard ordering reflects when stories first entered, and resolves per-item publisher attribution when a feed entry names an outlet distinct from the feed itself.

**Applies To:** Admin

**Acceptance Criteria:**
1. Candidates whose canonical URL is already present in the article pool are skipped on subsequent ticks so the same story is never re-summarised.
2. When a re-discovered URL arrives from a source that wasn't already on the article's source list, the new source is appended to the article's source list (multi-source aggregation).
3. An article's first-ingestion timestamp is preserved across every subsequent re-discovery so the dashboard ordering reflects when each story first entered the pool, not how recently a feed re-emitted it.
4. When a feed entry identifies a per-item publisher distinct from the feed itself (for example a Google News item that names the underlying outlet), the per-item publisher is used as the source name in the article's source list; absent or empty per-item publishers fall back to the feed-level name.

**Constraints:** [CON-PERF-001](constraints.md#con-perf-001-100-user-thundering-herd-target)

**Priority:** P0

**Dependencies:** [REQ-PIPE-001](#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-PIPE-002: Chunked LLM output content contract

**Intent:** Candidate articles are summarised in batches whose JSON output adheres to a fixed shape (title, body, tags drawn from an allowlist) so the reading surface receives consistent, properly-tagged article content. The chunk pass is summarisation-only; same-story collapse is delegated to the dedup pass in REQ-PIPE-003.

**Applies To:** Admin

**Acceptance Criteria:**
1. Each chunk yields a JSON payload shaped `{articles: [{title, details[], tags[]}]}` and no other top-level keys. Every input candidate gets its own entry.
2. Titles are NYT-style headlines, 45 to 80 characters, active voice, rewritten rather than copied from the source feed. The 45 to 80 range is the prompt-side target; the consumer additionally enforces a hard sanity range of 5 to 500 characters server-side, dropping titles outside that range so genuinely broken cases (single-character labels, paragraph-as-title) never reach the reading surface.
3. `details` is a plaintext body of 100 to 150 words split into 2 or 3 paragraphs (WHAT happened, HOW it works, and optionally IMPACT for the reader), each 2 to 4 sentences, with no lists, HTML, or Markdown.
4. The 100 to 150 word range is the prompt-side contract; the consumer additionally enforces an 80-word backstop server-side, dropping responses below that threshold so a model that ships a single-sentence stub cannot reach the reading surface. The backstop is a true sanity floor (genuinely truncated outputs), not the model's normal operating range.
5. `tags` values come exclusively from the system-approved allowlist: the union of the default-seed hashtag list shared with new accounts plus every tag for which a discovered-source cache currently exists. Any tag the LLM invents outside that union is discarded server-side before persistence, and an article that ends up with zero valid tags is dropped.

**Constraints:** [CON-LLM-001](constraints.md#con-llm-001-centralized-deterministic-prompts), [CON-SEC-003](constraints.md#con-sec-003-plaintext-only-llm-output)

**Priority:** P0

**Dependencies:** [REQ-PIPE-001](#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-PIPE-015: Chunk processing robustness

**Intent:** A single chunk failure, a mis-aligned LLM response, or a topically-unrelated summary never corrupts the tick. Failed chunks isolate to themselves, summaries align to the correct source URL, and topically-broken responses are dropped before they reach the reading surface.

**Applies To:** Admin

**Acceptance Criteria:**
1. A chunk failure marks only that chunk's portion of the run as failed; other chunks in the same tick still persist their articles.
2. Every article returned by the LLM echoes its input candidate's index; the consumer aligns output back to the input by that echoed value, dropping any article whose index is missing, invalid, or does not match an input candidate so a summary can never be stapled to the wrong canonical URL.
3. Before a summary is persisted, the consumer verifies the LLM-generated title shares at least one substantive non-stopword token with the source candidate's headline; summaries with zero topical overlap are dropped so a mis-wired LLM response can never appear as a real article.

**Constraints:** [CON-LLM-001](constraints.md#con-llm-001-centralized-deterministic-prompts), [CON-SEC-003](constraints.md#con-sec-003-plaintext-only-llm-output)

**Priority:** P0

**Dependencies:** [REQ-PIPE-002](#req-pipe-002-chunked-llm-output-content-contract)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-PIPE-003: Same-story dedupe — core matching contract

**Intent:** The same story published by five outlets appears as one primary card with four alternative-source links rather than five duplicate cards. Two outlets that paraphrase the same event under different headlines collapse to a single card even when they share almost no surface vocabulary, and the collapse holds across scrape ticks so a story discovered today never produces a second card when a different outlet covers the same event tomorrow.

**Applies To:** Admin

**Acceptance Criteria:**
1. URLs are canonicalised by stripping `utm_*` and `fbclid` tracking parameters, trimming trailing slashes, and removing default ports before any comparison. A canonical URL already present in the article pool is skipped on subsequent ticks so re-ingestion never produces a duplicate primary card.
2. Articles describing the same news event are collapsed to a single primary card regardless of whether their headlines share vocabulary. Same-event detection runs across the entire surviving article pool (not only the current scrape tick), so a story already in the pool absorbs a newly-arrived duplicate as an alternative source even when the duplicate landed in a later scrape run.
3. Near-duplicate articles whose textual similarity is overwhelming collapse deterministically across sources, so wire copies of one press release land as a single primary card with the others as alternative sources regardless of publisher identity.
4. When a newly-arrived article and an already-stored article describe the same news event, the merge happens regardless of which side was ingested first, which side carries the earlier publication time, or how many calendar days separate them within the same-news-cycle bound ([REQ-PIPE-012](#req-pipe-012-same-story-matching-policy-variants) AC 3). A duplicate that lands several days after its already-stored match still collapses to a single card without waiting for an operator-triggered sweep; the survivor is always the article with the earlier publication time (per [REQ-PIPE-018](#req-pipe-018-same-story-collapse-mechanics-survivor-selection-and-data-merge) AC 1).

**Constraints:** [CON-SEC-002](constraints.md#con-sec-002-outbound-article-body-fetches-flow-through-the-ssrf-guarded-helper)

**Priority:** P0

**Dependencies:** [REQ-PIPE-001](#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-PIPE-012](#req-pipe-012-same-story-matching-policy-variants), [REQ-PIPE-013](#req-pipe-013-same-story-cross-tick-automation-and-retention-coupling), [REQ-PIPE-014](#req-pipe-014-same-story-operator-surfaces), [REQ-PIPE-018](#req-pipe-018-same-story-collapse-mechanics-survivor-selection-and-data-merge)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-PIPE-018: Same-story collapse mechanics — survivor selection and data merge

**Intent:** Once two articles are recognised as the same story, deterministic rules pick the surviving primary card, fold the loser's per-user data and source attribution onto the survivor, prefer direct publisher copies over aggregator wrappers, and persist single-source articles with no alternative-source rows so the data shape is always consistent.

**Applies To:** Admin

**Acceptance Criteria:**
1. When two articles are recognised as the same story, the article with the earlier publication time survives as the primary card and the later one is recorded as an alternative source on it.
2. Two same-story articles that share an identical publication time (including wire-syndicated stories whose publication times match to the second) still collapse to a single card via a deterministic tie-break that picks the survivor, rather than being silently kept apart by timestamp granularity.
3. When the same story appears under both a direct publisher / community link and an aggregator-wrapper link whose canonical form differs from the publisher's (for example a Google News URL), the aggregator-wrapper copy is dropped in favour of the direct copy and any tag-of-discovery state from the dropped copy is merged onto the surviving direct article. When no direct copy is present, the aggregator-wrapper copy is kept so coverage of stories no direct source surfaced is preserved.
4. Source links, tag union, stars, and read marks from the later article are preserved on the surviving primary card so a user never loses a star or a read by virtue of dedup.
5. A single-source article (no same-story matches) is persisted with zero alternative-source rows.

**Constraints:** [CON-SEC-002](constraints.md#con-sec-002-outbound-article-body-fetches-flow-through-the-ssrf-guarded-helper)

**Priority:** P0

**Dependencies:** [REQ-PIPE-003](#req-pipe-003-same-story-dedupe-core-matching-contract)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-PIPE-004: Curated source registry with ≥50 feeds spanning the 21 system tags

**Intent:** The product covers the full breadth of cloud, AI, security, DevOps, languages, databases, and observability topics without relying on any single aggregator.

**Applies To:** Admin

**Acceptance Criteria:**
1. The registry contains at least 50 entries, each declaring a slug, human-readable name, feed URL, feed kind, and at least one tag.
2. Every one of the 21 system tags is covered by at least one source.
3. Every source declares at least one tag drawn from the system tag list.
4. Every feed URL uses HTTPS.
5. A live-fetch validator can be run on demand to detect dead feeds so operators can swap them out before they pollute the pool.

**Constraints:** [CON-SEC-002](constraints.md#con-sec-002-outbound-article-body-fetches-flow-through-the-ssrf-guarded-helper)

**Priority:** P0

**Dependencies:** None

**Verification:** Automated test

**Status:** Implemented

---

### REQ-PIPE-005: Fourteen-day retention with starred-exempt cleanup

**Intent:** The global pool stays small and fast by dropping stories older than two weeks, but articles any user has starred are preserved indefinitely.

**Applies To:** Admin

**Acceptance Criteria:**
1. A daily cron fires at 03:00 UTC and deletes articles whose published-at timestamp is older than 14 days, when no user has starred the article.
2. An article starred by any user is preserved regardless of age.
3. Deletion cascades remove the article's alternative sources, tag rows, and read-tracking rows so no orphans remain.
4. The cleanup run is independent of the global scrape run and never blocks ingestion.

**Constraints:** [CON-DATA-001](constraints.md#con-data-001-strong-consistency-in-d1-edge-cache-in-kv)

**Priority:** P1

**Dependencies:** [REQ-PIPE-001](#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-STAR-001](reading.md#req-star-001-star-and-unstar-articles)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-PIPE-006: scrape_runs aggregation surfaces stats, history, and in-flight progress

**Intent:** The per-tick token, cost, article, and dedupe counters feed the user-facing stats widget and history page without having to re-derive totals from article rows, and surface live progress while a run is in flight so users who trigger or wait on a scrape know the system is working.

**Applies To:** Admin

**Acceptance Criteria:**
1. Each run records its start time, finish time, articles ingested, articles deduplicated, input and output token counts, estimated cost in USD, model identifier, chunk count, and final status.
2. The stats widget reads global token and cost totals as sums over the scrape-run aggregation.
3. The history page reads its per-day aggregates and per-tick expansions from the same aggregation, not from article rows.
4. Status transitions running to ready on success, or running to failed when the run aborts. Once a run leaves running its status is terminal: a late-arriving failed chunk whose retries exhausted after the run already reached ready does not flap the dashboard back to failed, and a late success message after a run was already marked failed does not flip it back to ready.
5. A lightweight status endpoint reports whether a scrape is currently running; while running it returns the run identifier, start time, chunks completed, total chunks, and articles ingested so far.
6. The reading surface uses the status endpoint to replace its "Next update in Xm" countdown with an "Update in progress, X/Y chunks" indicator, and the settings surface shows the same progress alongside its manual-refresh control. Both indicators hide themselves automatically when the run finishes.

**Constraints:** [CON-DATA-001](constraints.md#con-data-001-strong-consistency-in-d1-edge-cache-in-kv)

**Priority:** P1

**Dependencies:** [REQ-PIPE-001](#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-PIPE-016: scrape_runs idempotency and stuck-run cleanup

**Intent:** Counter accuracy and operator unblock-paths around the scrape-run aggregation: queue redeliveries never inflate per-tick token, cost, or article counts; and a run whose state machine got stuck never blocks the operator from kicking a fresh pipeline.

**Applies To:** Admin

**Acceptance Criteria:**
1. The recorded finish time reflects when the run actually completed, not when the queue happened to redeliver the closing message. A redelivered last-chunk message that re-enters the closing path leaves the existing finish time intact, so the per-tick duration shown on the history page does not drift forward across retries.
2. The per-tick token, cost, articles-ingested, and articles-deduplicated counters advance exactly once per chunk regardless of how many times the queue redelivers that chunk's message. A redelivered chunk that has already been recorded as completed for the run leaves these counters at their existing values, so the stats widget and history page never show inflated tokens, cost, or article counts attributable to retry traffic rather than real LLM work.
3. The daily cleanup pass also retires runs whose state machine never reached a terminal status. Any run still tagged as in-progress well after the longest plausible tick duration is force-failed so its row no longer blocks the operator from kicking a fresh pipeline, and the history page surfaces the row as failed rather than indefinitely as running.

**Constraints:** [CON-DATA-001](constraints.md#con-data-001-strong-consistency-in-d1-edge-cache-in-kv)

**Priority:** P1

**Dependencies:** [REQ-PIPE-006](#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-PIPE-007: Orphan-tag source cleanup

**Intent:** When the last user who selected a tag removes it (or deletes their account), the discovered-feed cache for that tag becomes orphan: no user sees its articles, but the scrape coordinator keeps fetching its feeds and the LLM keeps summarising them on every tick — wasted work and quiet article-pool bloat. The daily cleanup pass deletes those orphan caches so cost scales only with tags that at least one user still cares about.

**Applies To:** Admin

**Acceptance Criteria:**
1. The same daily cron that prunes old articles also enumerates the discovered-feed cache, identifies entries whose tag does not appear in any user's saved tag list, and deletes them.
2. Tags configured by at least one user are preserved regardless of how stale their feed list is — the self-healing eviction loop is the only path that mutates an actively-owned tag's cache.
3. The cleanup pass is idempotent: a second immediate run is a no-op because the first run already removed every orphan.
4. The pass logs the number of orphan caches deleted so operators can watch for unexpected churn (a sudden mass deletion would indicate a bad tag-list write rather than legitimate user de-selection).
5. A failure in the orphan sweep never blocks the article-retention sweep that runs in the same cron, and vice versa — the two halves succeed or fail independently.

**Constraints:** [CON-DATA-001](constraints.md#con-data-001-strong-consistency-in-d1-edge-cache-in-kv)

**Priority:** P2

**Dependencies:** [REQ-PIPE-005](#req-pipe-005-fourteen-day-retention-with-starred-exempt-cleanup), [REQ-DISC-001](discovery.md#req-disc-001-llm-assisted-per-tag-feed-discovery)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-PIPE-009: LLM re-rank pass for borderline same-story candidates

**Intent:** When two articles describe the same news event but their summaries take different angles (e.g., one frames the event as "PM ousted in no-confidence vote" and another as "government collapses as far-right coalition forms"), embedding similarity alone places them in a borderline band that is too low to auto-merge but too high to safely call them distinct. A targeted same-event judgment by the language model decides those borderline pairs without lowering the auto-merge bar that protects against false merges between distinct same-day stories from the same source.

**Applies To:** Admin

**Acceptance Criteria:**
1. Same-story candidates whose similarity falls in a configured borderline band (above a floor and below the auto-merge threshold from REQ-PIPE-003) trigger a single same-event judgment by the language model. Pairs at or above the auto-merge threshold are merged without an LLM call; pairs below the floor stay distinct without an LLM call.
2. The same-event judgment receives only the two articles' titles and short body excerpts. The judgment is binary and conservative: an unparseable, ambiguous, or failed response is treated as "different events" so a borderline pair never collapses on the strength of an unreliable model answer.
3. A pair the model marks as the same event is merged using the same first-source-wins rule as REQ-PIPE-003: the earlier-published article survives as the primary card and the later one becomes an alternative source on it.
4. The same borderline gate runs on both the per-tick cross-tick pass and the operator-initiated historical re-run sweep, so re-running the sweep after a threshold change picks up borderline pairs the original ingest missed.
5. Each invocation is bounded by a wall-clock budget rather than a fixed count of borderline judgments, so an operator-triggered sweep over a large corpus still converges without dropping borderline pairs silently. Per-invocation rerank counts are recorded in operator-visible logs so an operator can see how much rerank work each batch performed.
6. When a single newly-arrived article has multiple borderline candidates rather than one, the same-event judgment is invoked on the candidates in best-first order until a same-event verdict accepts or a small per-article cap is reached, so a genuine same-event sibling that happens not to be the top-scoring nearest neighbour is not silently dropped.
7. The borderline floor is operator-tunable at runtime through the same configuration mechanism as the auto-merge threshold, so an operator can widen or narrow the LLM-judgment band without a code change.

**Constraints:** [CON-LLM-001](constraints.md#con-llm-001-centralized-deterministic-prompts)

**Priority:** P1

**Dependencies:** [REQ-PIPE-003](#req-pipe-003-same-story-dedupe-core-matching-contract)

**Verification:** Automated test

**Status:** Implemented

---
### REQ-PIPE-010: Body-fetch for thin feed snippets

**Intent:** When a feed entry's summary is too short to ground a faithful LLM summary, the pipeline fetches the article body directly so summarisation has real content to work with. Body-fetch is a sub-feature of the coordinator pipeline (REQ-PIPE-001) carved out per the AC count cap.

**Applies To:** Admin

**Acceptance Criteria:**
1. When a candidate's feed snippet is too thin to ground a faithful summary, the pipeline fetches the article body directly.
2. The body fetch is HTTPS-only and passes an SSRF filter.
3. The body fetch is bounded by a network timeout and a maximum download size.
4. Readable plaintext is extracted from a successful body fetch and attached to the candidate.
5. When body-fetch extraction yields too little text, the candidate falls back to whatever the feed itself provided.
6. A failed body-fetch never blocks a summary.

**Constraints:** [CON-SEC-002](constraints.md#con-sec-002-outbound-article-body-fetches-flow-through-the-ssrf-guarded-helper)

**Priority:** P0

**Dependencies:** [REQ-PIPE-001](#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-PIPE-011: Candidate filtering rules

**Intent:** Coordinator-level filters keep stale, undated, or blocklisted candidates out of the LLM pipeline so summarisation budget and dashboard surface area stay clean. Filtering is a sub-feature of the coordinator pipeline (REQ-PIPE-001) carved out per the AC count cap.

**Applies To:** Admin

**Acceptance Criteria:**
1. Each candidate's published-at timestamp reflects the source feed's real publish date (parsed from the feed entry) rather than the ingestion tick time, so a story first published three weeks ago is never displayed as "today" on the dashboard. When a feed entry provides no usable publish date, or the parsed value is implausible (pre-2000 or more than one day in the future), the ingestion time is used as a safe fallback.
2. Candidates whose parsed publish date is older than 48 hours before the current tick are dropped before LLM summarisation so stale backlog items do not consume LLM budget or clutter the dashboard. Candidates with no parsable publish date (which fall back to the ingestion time) are kept — a missing date is not treated the same as a stale date.
3. Headlines from publishers that an AI tech news product would never surface — primarily financial / stock-pump aggregators that Google News routes into tech tags when a vendor's ticker matches — are dropped at the coordinator before clustering, embedding, or LLM summarisation. The blocklist is matched against both the article URL's host and the per-item publisher name reported by the feed entry, so an aggregator-wrapped item (whose URL points at a redirect envelope rather than the publisher's site) is still recognised by the publisher name the feed exposes. The blocklist applies uniformly across every tag and every user — a user with a tag that matches a tech vendor's ticker never sees those stock-pump articles in their digest. The blocklist is operator-maintained at the source level rather than configurable per user, so the contract is a single project-wide list, not a personal mute list.

**Constraints:** [CON-PERF-001](constraints.md#con-perf-001-100-user-thundering-herd-target)

**Priority:** P0

**Dependencies:** [REQ-PIPE-001](#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-PIPE-012: Same-story matching policy variants

**Intent:** Same-story collapse is constrained by three policy bounds that prevent over-merging: research outputs with conflicting numerics stay distinct, same-publisher pairs face a stricter threshold to resist house-style false-positives, and merges respect a same-news-cycle calendar window so topical clusters do not collapse into one card.

**Applies To:** Admin

**Acceptance Criteria:**
1. Two studies, audits, or benchmarks on the same topic that cite different numbers, methodologies, or authors are treated as distinct stories and never merged — even when they discuss identical subject matter — so conflicting findings on the same topic remain visible as separate cards on the dashboard.
2. Two articles published by the same publisher must clear a stricter same-story bar than two articles from different publishers, so a publisher's recurring writing style does not push unrelated stories from the same outlet over the same-story threshold. "Same publisher" means both articles' direct URLs identify the same real publisher; pairs whose URLs route through an aggregator-wrapper host (which carries no publisher identity of its own) are treated as cross-publisher for this purpose so two aggregator-wrapped copies of the same story are not blocked from folding by the same-publisher penalty. The diagnostic surface from [REQ-PIPE-014](#req-pipe-014-same-story-operator-surfaces) AC 2 reports both the raw cosine and the stricter score actually used by the merge decision so an operator can see why a same-publisher pair was kept apart.
3. Articles describing the same event are merged across sources only when their publishing dates fall within roughly the same news cycle; pairs whose publication times are far apart on calendar terms are kept as distinct cards even when their topics overlap. Dense theme clusters (e.g., a topic where many independent stories appear over a multi-day stretch) therefore stay separated by event rather than collapsing on topical similarity alone.

**Constraints:** [CON-LLM-001](constraints.md#con-llm-001-centralized-deterministic-prompts)

**Priority:** P0

**Dependencies:** [REQ-PIPE-003](#req-pipe-003-same-story-dedupe-core-matching-contract)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-PIPE-013: Same-story cross-tick automation and retention coupling

**Intent:** Same-story matching does not block ingestion: articles become visible the moment a scrape run reaches `ready`, with cross-tick matching folding duplicates onto existing primary cards asynchronously. The matching surface stays consistent with retention so deleted articles cannot resurface as phantom matches.

**Applies To:** Admin

**Acceptance Criteria:**
1. Articles become visible to users as soon as the scrape run reaches `ready`. Cross-tick same-story matching runs asynchronously after that, so a user may briefly see two cards for the same story; the window is bounded by the queue's processing latency and the second card is replaced by an alternative-source row on the surviving card on the next pass of the asynchronous matcher.
2. The retention sweep (REQ-PIPE-005) that drops articles older than 14 days also removes the corresponding entries from the same-story index, so a deleted article can never be cited as a "match" for a future article and starred articles preserved past the retention window keep their same-story matching capability.
3. Cross-tick same-story matching keeps running automatically after every scrape tick. The window between an article becoming visible and its absorption as an alternative source onto an existing duplicate is bounded by the cadence of the automatic post-tick matching, not by the operator-triggered sweep on the operator surface. The operator surface still exists for sweeping the entire historical pool when matching across older stories is needed; routine cross-tick collapse no longer requires the operator to take any action.
4. The reach of the automatic post-tick matching covers the same span as the same-news-cycle window from REQ-PIPE-012 AC 3, so any pair the dedup logic would accept as same-event by publication-time proximity is reachable by the automatic path. Cross-day clusters that span up to the full same-news-cycle window collapse via the automatic matching alone, without an operator-triggered full-corpus sweep, regardless of the order in which the cluster's siblings arrived.

**Constraints:** [CON-PERF-001](constraints.md#con-perf-001-100-user-thundering-herd-target)

**Priority:** P0

**Dependencies:** [REQ-PIPE-003](#req-pipe-003-same-story-dedupe-core-matching-contract), [REQ-PIPE-005](#req-pipe-005-fourteen-day-retention-with-starred-exempt-cleanup), [REQ-PIPE-012](#req-pipe-012-same-story-matching-policy-variants)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-PIPE-014: Same-story operator surfaces

**Intent:** Operators need to validate, re-run, and recover same-story matching against the full historical pool: on-demand sweeps to fold matches the automatic path missed, a pair-similarity diagnostic to evaluate threshold changes, embedding regeneration for corpus rebuilds, and a partial-outage protocol that pauses rather than skips when the index is unreachable.

**Applies To:** Admin

**Acceptance Criteria:**
1. An operator can re-run same-story matching across the entire historical article pool on demand (admin-gated). The sweep runs to completion in the background after the operator triggers it, and closing or navigating away from the operator surface does not interrupt the sweep.
2. While a historical sweep is in flight, progress (articles scanned, duplicates merged, articles remaining) is observable both during the sweep and on the next visit to the operator surface.
3. The articles-scanned, duplicates-merged, and remaining counters advance exactly once per batch regardless of how many times the queue redelivers that batch's message, so a redelivered batch that has already been folded into the run leaves these counters at their existing values and the operator never sees inflated scanned or merged totals attributable to retry traffic rather than real matching work.
4. An operator can inspect the cosine similarity between any two articles' stored embeddings on demand (admin-gated) alongside the currently-effective same-story threshold and a flag for whether the two articles come from the same publisher, so a threshold change can be evaluated against known true-positive and false-positive pairs before it is committed. The diagnostic reports an explicit not-found when either article or either embedding is missing rather than silently returning a misleading similarity.
5. An operator can re-run embedding generation across the entire historical article pool on demand (admin-gated), so the corpus can be rebuilt against an improved embedding input without waiting for natural churn or re-scraping.
6. When the similarity index is fully unreachable for a batch of the operator-triggered historical sweep (every per-article lookup against it fails), the sweep pauses on that batch with its cursor preserved and the batch is redelivered until the index is reachable again. Cross-tick duplicates that landed during an outage therefore still collapse on a later attempt instead of being silently skipped past forever. A partial-outage batch where at least one lookup succeeded still advances the cursor; only the all-failed case halts.

**Constraints:** [CON-SEC-002](constraints.md#con-sec-002-outbound-article-body-fetches-flow-through-the-ssrf-guarded-helper)

**Priority:** P0

**Dependencies:** [REQ-PIPE-003](#req-pipe-003-same-story-dedupe-core-matching-contract)

**Verification:** Automated test

**Status:** Implemented

---

## Out of Scope

The following REQs described the previous per-user digest generation pipeline. They are superseded by REQ-PIPE-* in the 2026-04-23 global-feed rework and are preserved here verbatim for decision history.

---