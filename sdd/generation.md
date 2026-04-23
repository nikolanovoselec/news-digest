# Digest Generation

A single `generateDigest` function called from two places: the cron dispatcher (scheduled) and the refresh API handler (manual). Cron enqueues to Cloudflare Queues; the consumer runs the pipeline in isolate-per-message so memory does not leak between concurrent digests. Rate limits are enforced via atomic conditional UPDATEs. Stuck digests are swept by the cron.

---

### REQ-GEN-001: Scheduled generation via cron dispatcher

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
**Status:** Implemented

---

### REQ-GEN-003: Source fan-out with caching

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
**Status:** Partial
**Notes:** AC 5 (per-article tag persistence) ships in `src/lib/generate.ts` + `migrations/0002_article_tags.sql` but no test asserts the final insert binds the validated tag list. AC 1-4 remain verified by existing pipeline and sanitize tests.

---

### REQ-GEN-007: Stuck-digest sweeper

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
**Status:** Implemented

---

### REQ-GEN-008: Cost, time, and token transparency

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
**Status:** Implemented
