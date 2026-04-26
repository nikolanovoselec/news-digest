# Digest Generation

A global scrape-and-summarise pipeline that runs every 4 hours: one cron-triggered coordinator run per tick assembles candidates from the curated source registry, canonical-URL-dedupes them, and fans chunks out to the LLM consumer. The consumer writes summaries + tags + cluster groupings into a shared article pool. The per-user dashboard then reads from that pool filtered by each user's active tags, so cost scales with the world (one LLM pass per tick) rather than with users × refreshes. Starred articles survive the 7-day retention cutoff.

---

### REQ-PIPE-001: Global scrape-and-summarise pipeline on a fixed cadence

**Intent:** Every 4 hours, the system fetches from the curated source registry, canonical-URL-dedupes candidates, and queues LLM summarization so the per-user dashboard reads from a single up-to-date pool rather than running the LLM per user. Cost scales O(1) in users instead of O(users × refreshes).

**Applies To:** System

**Acceptance Criteria:**
1. A Cron Trigger fires every 4 hours on the hour (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC) and kicks off a single coordinator run for all users.
2. The coordinator enqueues one chunk job per ~100 candidates so LLM calls stay within the model's context window and partial failures only lose one chunk.
3. Each run is tracked by a `scrape_runs` row that transitions `running` → `ready` on success (or `failed` on abort), with a chunk counter that drops to zero when the last chunk finishes.
4. Candidates whose canonical URL is already present in the article pool are skipped on subsequent ticks so the same story is never re-summarised; the coordinator still marks each such re-seen article as freshly sighted so the reading surface can distinguish articles currently trending in live feeds from articles that have dropped out of every feed.
5. The pipeline is independent of individual user accounts — it runs once per tick regardless of how many users are signed up, and adding users does not multiply LLM spend.
6. Each candidate's published-at timestamp reflects the source feed's real publish date (parsed from the feed entry) rather than the ingestion tick time, so a story first published three weeks ago is never displayed as "today" on the dashboard. When a feed entry provides no usable publish date, or the parsed value is implausible (pre-2000 or more than one day in the future), the ingestion time is used as a safe fallback.
7. Candidates whose parsed publish date is older than 48 hours before the current tick are dropped before LLM summarisation so stale backlog items do not consume LLM budget or clutter the dashboard. Candidates with no parsable publish date (which fall back to the ingestion time) are kept — a missing date is not treated the same as a stale date.
8. When a candidate's feed snippet is too thin to ground a faithful summary, the coordinator fetches the article URL directly over HTTPS with an SSRF filter applied, a bounded network timeout, and a capped download size. Readable plaintext is extracted and attached to the candidate; when extraction yields too little text the candidate falls back to whatever the feed itself provided, so a failed body-fetch never blocks a summary.

**Constraints:** CON-LLM-001, CON-PERF-001, CON-SEC-002
**Priority:** P0
**Dependencies:** REQ-PIPE-004
**Verification:** Integration test
**Status:** Implemented

---

### REQ-PIPE-002: Chunked LLM processing with JSON output contract

**Intent:** Candidate articles are summarised in batches of ~100 per LLM call so prompt size stays under the model's context window and partial failures only lose one chunk, not the whole tick.

**Applies To:** System

**Acceptance Criteria:**
1. Each chunk yields a JSON payload shaped `{articles: [{title, details[], tags[]}], dedup_groups: [[…]]}` and no other top-level keys.
2. Titles are NYT-style headlines, 45–80 characters, active voice, rewritten rather than copied from the source feed.
3. `details` is a plaintext body of 150–200 words split into 2 or 3 paragraphs (WHAT happened, HOW it works, and optionally IMPACT for the reader), each 3–5 sentences, with no lists, HTML, or Markdown. Responses under ~120 words are treated as malformed.
4. `tags` values come exclusively from the system-approved allowlist — the union of the default-seed hashtag list shared with new accounts plus every tag for which a discovered-source cache currently exists. Any tag the LLM invents outside that union is discarded server-side before persistence, and an article that ends up with zero valid tags is dropped.
5. Intra-chunk duplicates collapse via the `dedup_groups` hints: the earliest-published source becomes the primary article and the others are recorded as alternative sources.
6. A chunk failure marks only that chunk's portion of the run as failed; other chunks in the same tick still persist their articles.
7. Every article returned by the LLM echoes its input candidate's index; the consumer aligns output back to the input by that echoed value, dropping any article whose index is missing, invalid, or does not match an input candidate so a summary can never be stapled to the wrong canonical URL.
8. Before a summary is persisted, the consumer verifies the LLM-generated title shares at least one substantive non-stopword token with the source candidate's headline; summaries with zero topical overlap are dropped so a mis-wired LLM response can never appear as a real article.

**Constraints:** CON-LLM-001, CON-SEC-003
**Priority:** P0
**Dependencies:** REQ-PIPE-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-PIPE-003: Canonical-URL + LLM-cluster dedupe with first-source-wins

**Intent:** The same story published by five outlets appears as one primary card with four alternative-source links rather than five duplicate cards.

**Applies To:** System

**Acceptance Criteria:**
1. URLs are canonicalised by stripping `utm_*` and `fbclid` tracking parameters, trimming trailing slashes, and removing default ports before any comparison.
2. Clusters are merged per the LLM's `dedup_groups` hints, not only by canonical-URL equality.
3. Within a cluster the earliest-published source becomes the primary article; the remaining members are persisted as alternative sources for that article.
4. A canonical URL already present in the article pool is skipped on subsequent ticks — re-ingestion never produces a duplicate primary card.
5. A single-source article (no cluster members) is persisted with zero alternative-source rows.

**Constraints:** CON-SEC-002
**Priority:** P0
**Dependencies:** REQ-PIPE-001
**Verification:** Automated test
**Status:** Implemented

---

### REQ-PIPE-004: Curated source registry with ≥50 feeds spanning the 20 system tags

**Intent:** The product covers the full breadth of cloud, AI, security, DevOps, languages, databases, and observability topics without relying on any single aggregator.

**Applies To:** System

**Acceptance Criteria:**
1. The registry contains at least 50 entries, each declaring a slug, human-readable name, feed URL, feed kind, and at least one tag.
2. Every one of the 20 system tags is covered by at least one source.
3. Every source declares at least one tag drawn from the system tag list.
4. Every feed URL uses HTTPS.
5. A live-fetch validator can be run on demand to detect dead feeds so operators can swap them out before they pollute the pool.

**Constraints:** CON-SEC-002
**Priority:** P0
**Dependencies:** None
**Verification:** Automated test
**Status:** Implemented

---

### REQ-PIPE-005: Seven-day retention with starred-exempt cleanup

**Intent:** The global pool stays small and fast by dropping stories older than a week, but articles any user has starred are preserved indefinitely.

**Applies To:** System

**Acceptance Criteria:**
1. A daily cron fires at 03:00 UTC and deletes articles whose published-at timestamp is older than 7 days, when no user has starred the article.
2. An article starred by any user is preserved regardless of age.
3. Deletion cascades remove the article's alternative sources, tag rows, and read-tracking rows so no orphans remain.
4. The cleanup run is independent of the global scrape run and never blocks ingestion.

**Constraints:** CON-DATA-001
**Priority:** P1
**Dependencies:** REQ-PIPE-001, REQ-STAR-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-PIPE-006: scrape_runs aggregation surfaces stats, history, and in-flight progress

**Intent:** The per-tick token, cost, article, and dedupe counters feed the user-facing stats widget and history page without having to re-derive totals from article rows, and surface live progress while a run is in flight so users who trigger or wait on a scrape know the system is working.

**Applies To:** System

**Acceptance Criteria:**
1. Each run records its start time, finish time, articles ingested, articles deduplicated, input and output token counts, estimated cost in USD, model identifier, chunk count, and final status.
2. The stats widget reads global token and cost totals as sums over the scrape-run aggregation.
3. The history page reads its per-day aggregates and per-tick expansions from the same aggregation, not from article rows.
4. Status transitions running → ready on success, or running → failed when the run aborts.
5. A lightweight status endpoint reports whether a scrape is currently running; while running it returns the run identifier, start time, chunks completed, total chunks, and articles ingested so far. The reading surface uses this endpoint to replace its "Next update in Xm" countdown with an "Update in progress — X/Y chunks" indicator, and the settings surface shows the same progress alongside its manual-refresh control. Both indicators hide themselves automatically when the run finishes.

**Constraints:** CON-DATA-001
**Priority:** P1
**Dependencies:** REQ-PIPE-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-PIPE-007: Orphan-tag source cleanup

**Intent:** When the last user who selected a tag removes it (or deletes their account), the discovered-feed cache for that tag becomes orphan: no user sees its articles, but the scrape coordinator keeps fetching its feeds and the LLM keeps summarising them on every tick — wasted work and quiet article-pool bloat. The daily cleanup pass deletes those orphan caches so cost scales only with tags that at least one user still cares about.

**Applies To:** System

**Acceptance Criteria:**
1. The same daily cron that prunes old articles also enumerates the discovered-feed cache, identifies entries whose tag does not appear in any user's saved tag list, and deletes them.
2. Tags configured by at least one user are preserved regardless of how stale their feed list is — the self-healing eviction loop is the only path that mutates an actively-owned tag's cache.
3. The cleanup pass is idempotent: a second immediate run is a no-op because the first run already removed every orphan.
4. The pass logs the number of orphan caches deleted so operators can watch for unexpected churn (a sudden mass deletion would indicate a bad tag-list write rather than legitimate user de-selection).
5. A failure in the orphan sweep never blocks the article-retention sweep that runs in the same cron, and vice versa — the two halves succeed or fail independently.

**Constraints:** CON-DATA-001
**Priority:** P2
**Dependencies:** REQ-PIPE-005, REQ-DISC-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-PIPE-008: Cross-chunk semantic dedup pass

**Intent:** When the same news story arrives from two sources that landed in different chunks of the same scrape tick, the per-chunk dedup hint cannot collapse them — they were never in the same LLM context. A single post-merge LLM call over the surviving titles plus source names catches these cross-chunk pairs so the dashboard shows one card with two alternative sources rather than two near-identical cards.

**Applies To:** System

**Acceptance Criteria:**
1. After every chunk of a scrape tick finishes, exactly one finalize pass runs over the articles persisted under that scrape tick and emits one Workers AI call returning the same dedup-groups output contract used by the per-chunk pass. The pass is skipped when the tick produced one or fewer articles.
2. Within each returned group, the article with the earliest publication time survives as the winner; the others are merged into it, matching the first-source-wins rule from REQ-PIPE-003.
3. Merging a loser into a winner re-points all of the loser's child rows: alternative sources, tag list (tag union), and per-user state (stars and reads). User-facing state is preserved across the merge — the merge never makes a user lose a star or a read mark.
4. Articles become visible to users at the moment the chunk consumer that closed the run flipped status to ready; the finalize pass runs in a separate queue message and may briefly leave duplicates visible. The window is bounded by the finalize queue's processing latency.
5. The pass is idempotent: a finalize message redelivered by the queue converges to the same final article set without double-counting tokens or losing user state.
6. The pass caps its LLM input at the 250 most recent articles by ingestion time; ticks that produced more skip dedup on the tail. This ceiling is documented as a known limitation.
7. Token and cost counters from the finalize call fold into the scrape tick's totals via the same per-chunk stats helper; the deduped-article counter increments by the number of losers deleted.
8. A finalize that exhausts its queue retry budget logs a structured error and leaves the tick's articles in their un-merged state. The tick's status is not flipped from ready to failed — the articles are real and visible; only the cross-chunk merge is missing.

**Constraints:** CON-LLM-001
**Priority:** P1
**Dependencies:** REQ-PIPE-002, REQ-PIPE-003
**Verification:** Integration test
**Status:** Implemented

---

## Out of Scope

The following REQs described the previous per-user digest generation pipeline. They are superseded by REQ-PIPE-001..006 in the 2026-04-23 global-feed rework and are preserved here verbatim for decision history.

---

### REQ-GEN-001: Scheduled generation via cron dispatcher

Superseded by REQ-PIPE-* in the 2026-04-23 global-feed rework.

**Intent:** Each user's digest is generated at their chosen local time, reliably, even when 100 users all schedule the same HH:MM.

**Applies To:** User

**Acceptance Criteria:**
1. A Cron Trigger fires every 5 minutes at `HH:MM` where `MM % 5 == 0`.
2. For each distinct timezone present in the users table, the dispatcher computes the current local time and queries for users whose `digest_hour:digest_minute` falls in the half-open window `[floor(minute/5)*5, +5)` and whose `last_generated_local_date != today_local_date`.
3. Matched users are enqueued to `digest-jobs` with a message `{ trigger: 'scheduled', user_id, local_date }`; `sendBatch` is used for efficiency.
4. Cron does not generate inline; the scheduling pass returns in under 1 second regardless of user count.
5. The Queue consumer processes messages with Cloudflare Queues' default concurrency (10), giving natural backpressure under thundering-herd load.

**Constraints:** CON-PERF-001
**Priority:** P0
**Dependencies:** REQ-SET-003
**Verification:** Integration test
**Status:** Implemented

---

### REQ-GEN-002: Manual refresh with rate limiting

Superseded by REQ-PIPE-* in the 2026-04-23 global-feed rework.

**Intent:** Users can trigger a digest at any time. A short cooldown debounces accidental double-clicks and tap spam; a very high daily ceiling acts as a backstop against pathological loops. The scheduler — not this endpoint — is the real guardrail on generation volume.

**Applies To:** User

**Acceptance Criteria:**
1. `POST /api/digest/refresh` performs a single conditional `UPDATE users SET last_refresh_at, refresh_window_start, refresh_count_24h` with `RETURNING` to enforce both a short debounce cooldown and a high 24h ceiling in one statement.
2. Zero rows returned means rate-limited: the endpoint returns HTTP 429 with body `{ error, code: 'rate_limited', retry_after_seconds, reason: 'cooldown' | 'daily_cap' }`.
3. On success, a conditional `INSERT INTO digests` creates a row with `status='in_progress'` only if no other in-progress digest exists for this user and today's `local_date`; zero rows inserted returns HTTP 409 with code `already_in_progress`.
4. The endpoint enqueues `{ trigger: 'manual', user_id, local_date, digest_id }` to `digest-jobs` and returns HTTP 202 with `{ digest_id, status: 'in_progress' }`.

**Constraints:** CON-PERF-001
**Priority:** P0
**Dependencies:** REQ-GEN-001
**Verification:** Integration test
**Status:** Deprecated
**Replaced By:** REQ-PIPE-001
**Removed In:** 2026-04-23

---

### REQ-GEN-003: Source fan-out with caching

Superseded by REQ-PIPE-* in the 2026-04-23 global-feed rework.

**Intent:** Assemble a pool of candidate articles from every relevant source without paying for redundant fetches when many users share the same tag.

**Applies To:** User

**Acceptance Criteria:**
1. For each hashtag, the consumer fetches from generic sources (Hacker News Algolia, Google News RSS, Reddit — 30 items each) and every feed listed in `sources:{tag}` (20 items each).
2. Before each fetch, the consumer checks `headlines:{source_name}:{tag}` in KV; a cache hit skips the network call entirely.
3. Successful fetches populate the cache with a 10-minute TTL.
4. Fetches have a 5-second timeout, a 1 MB response-body cap, and a global concurrency cap of 10 across all hashtags and sources.
5. Per-source errors are logged but do not fail the digest; only all sources failing across all hashtags produces `status='failed'` with `error_code='all_sources_failed'`.

**Constraints:** CON-SEC-002
**Priority:** P0
**Dependencies:** REQ-GEN-001, REQ-DISC-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-GEN-004: URL canonicalization and dedupe

Superseded by REQ-PIPE-* in the 2026-04-23 global-feed rework.

**Intent:** Articles pointing at the same story from different sources are collapsed to one entry without ever fetching the article body.

**Applies To:** User

**Acceptance Criteria:**
1. URLs are upgraded to `https://` where the source returned `http://`.
2. Known tracking parameters (`utm_*`, `ref`, `ref_src`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `igshid`, `si`, `source`) are stripped.
3. Scheme and host are lowercased and any trailing `/` on the pathname is removed.
4. The canonical URL string is the dedupe key; articles sharing a canonical URL collapse to one entry.
5. No server-side redirect resolution is performed.

**Constraints:** CON-SEC-002
**Priority:** P0
**Dependencies:** REQ-GEN-003
**Verification:** Automated test
**Status:** Implemented

---

### REQ-GEN-005: Single-call LLM summarization

Superseded by REQ-PIPE-* in the 2026-04-23 global-feed rework.

**Intent:** One Workers AI call ranks candidate headlines and produces up to six summaries with a short one-liner and three paragraph-length detail sections each, keeping generation cheap and deterministic.

**Applies To:** User

**Acceptance Criteria:**
1. After canonicalization and dedupe, up to 100 candidate headlines are sent to Workers AI in a single call using the model stored on the digest row (snapshot of the user's selected model at digest creation time).
2. The prompt is loaded from a centralized prompts module; user-controlled content (hashtags, headlines) is fenced with triple backticks so the model treats it as data, not instructions.
3. Inference is low-temperature and constrained to strict JSON output (`response_format: { type: 'json_object' }`), with an output budget large enough for six articles whose three detail paragraphs run to ~200 words each without truncation.
4. The response is parsed as strict JSON. Both string payloads and already-parsed object payloads (returned by models that honour `response_format: json_object`) are accepted; on parse failure the digest is marked `status='failed'` with `error_code='llm_invalid_json'`.
5. The expected shape is `{ articles: [{ title, url, one_liner, details, tags }] }` with up to 6 articles, `one_liner` a single plaintext sentence targeting 150–200 characters, and `details` an array of exactly 3 plaintext paragraphs each targeting ~200 words (prose only, no bullet prefixes, no lists, no HTML, no Markdown). If fewer than 6 strong matches exist the model returns fewer; if none, an empty `articles: []` array is a valid response.
6. Each candidate headline sent to the model carries the authoritative list of user hashtags that matched it during fan-out, and the model is instructed to echo the relevant subset back as each returned article's `tags` field. The returned tags are validated server-side to be a subset of the user's current hashtag list; any hallucinated tag is discarded, and if the model omits the field the fan-out's own source-tag union is used as a fallback.
7. `title` is a punchy, glance-ready headline rewrite (roughly 45–80 characters, active voice, no clickbait) rather than a verbatim copy of the source feed's title, so the reading surface presents stories in a consistent editorial voice.

**Constraints:** CON-LLM-001, CON-SEC-003
**Priority:** P0
**Dependencies:** REQ-GEN-003
**Verification:** Integration test
**Status:** Implemented

---

### REQ-GEN-006: Atomic final write

Superseded by REQ-PIPE-* in the 2026-04-23 global-feed rework.

**Intent:** Either the full digest (articles + status + user dedupe key) commits, or none of it does — there is no partial observable state.

**Applies To:** User

**Acceptance Criteria:**
1. The final write is a single `db.batch([...])` call containing all article inserts, the digest status update, and the user's `last_generated_local_date` update.
2. The digest status update uses `WHERE id = ? AND status = 'in_progress'` so a row externally marked `failed` (e.g., by the stuck-sweeper) is never overwritten.
3. `last_generated_local_date` is updated for both scheduled and manual triggers — a manual refresh consumes today's slot so the scheduled run naturally skips.
4. Article plaintext (title, one_liner, each bullet in details) is sanitized by stripping HTML tags, stripping control characters, and collapsing whitespace before the insert.
5. Each article row persists its validated tag list alongside the article so the reading surface can filter by tag without consulting the digest generator. Rows written before tags were captured are treated as an empty list.

**Constraints:** CON-DATA-001, CON-SEC-003
**Priority:** P0
**Dependencies:** REQ-GEN-005
**Verification:** Integration test
**Status:** Deprecated
**Replaced By:** REQ-PIPE-002
**Removed In:** 2026-04-23

---

### REQ-GEN-007: Stuck-digest sweeper

Superseded by REQ-PIPE-* in the 2026-04-23 global-feed rework.

**Intent:** A crashed consumer does not leave a digest in `in_progress` forever, causing the client to poll indefinitely.

**Applies To:** User

**Acceptance Criteria:**
1. Every 5-minute cron invocation, before any scheduling work, runs `UPDATE digests SET status='failed', error_code='generation_stalled' WHERE status='in_progress' AND generated_at < (now - 600)`.
2. Affected users can click Refresh to retry immediately (subject to rate limits).
3. The sweeper runs unconditionally; any other cron work is skipped if the sweeper fails.

**Constraints:** None
**Priority:** P1
**Dependencies:** REQ-GEN-001
**Verification:** Integration test
**Status:** Deprecated
**Replaced By:** REQ-PIPE-001
**Removed In:** 2026-04-23

---

### REQ-GEN-008: Cost, time, and token transparency

Superseded by REQ-PIPE-* in the 2026-04-23 global-feed rework.

**Intent:** Every digest surfaces what it cost to produce, so users can see the value of the LLM call and choose cheaper models when appropriate.

**Applies To:** User

**Acceptance Criteria:**
1. The `digests` row stores `execution_ms`, `tokens_in`, `tokens_out`, and `estimated_cost_usd` computed at insert time from the model's per-million-token prices in `MODELS`.
2. The digest view footer shows "Generated {HH:MM TZ} · {s}s · {tokens} tokens · ~${cost} · {model_name}".
3. When Workers AI does not return token counts, the numeric fields display with a `~` prefix to indicate estimate.
4. The history view shows these same metrics per past digest.

**Constraints:** CON-LLM-001
**Priority:** P1
**Dependencies:** REQ-GEN-006
**Verification:** Integration test
**Status:** Deprecated
**Replaced By:** REQ-HIST-002
**Removed In:** 2026-04-23
