# Source Discovery

Per-tag feed discovery is LLM-assisted and SSRF-filtered. Settings save queues new tags; the 5-minute cron processes up to 3 pending tags per invocation and caches validated feeds globally (shared across all users who selected that tag). Feeds evict themselves from the cache after repeated fetch failures.

---

### REQ-DISC-001: LLM-assisted per-tag feed discovery

**Intent:** When a user adds a hashtag, the system finds authoritative first-party feeds for that tag without requiring a hand-curated catalog.

**Applies To:** User

**Acceptance Criteria:**
1. On settings save, any submitted tag without a `sources:{tag}` KV entry triggers an `INSERT OR IGNORE` into the `pending_discoveries` D1 table keyed by `(user_id, tag)`.
2. The 5-minute cron picks up to 3 distinct tags from `pending_discoveries` per invocation, ordered by the earliest `added_at` for each tag.
3. For each tag, a Workers AI call asks for up to 5 authoritative RSS, Atom, or JSON feed URLs; the prompt explicitly instructs the model to return fewer URLs rather than guess.
4. Each suggested URL is validated: HTTPS-only, passes the SSRF filter (no private ranges, loopback, link-local, Cloudflare internal), HTTP 200, content-type matches the declared kind, parseable, and returns at least one item with a title and URL.
5. Valid feeds are persisted to `sources:{tag}` as `{ feeds: [{ name, url, kind }], discovered_at }` with no TTL; rows for this tag are deleted from `pending_discoveries` regardless of success.

**Constraints:** CON-SEC-002, CON-LLM-001
**Priority:** P0
**Dependencies:** REQ-SET-002
**Verification:** Integration test
**Status:** Implemented

---

### REQ-DISC-002: Discovery progress visibility

**Intent:** Users who just saved settings see that the system is working on their new tags and can expect fuller results on the next digest.

**Applies To:** User

**Acceptance Criteria:**
1. `GET /api/discovery/status` returns `{ pending: string[] }` scoped to the session user via `SELECT tag FROM pending_discoveries WHERE user_id = :session_user_id`.
2. `/digest` displays a subtle banner "Discovering sources for #{tag1}, #{tag2}… Your next digest will include them." while the returned list is non-empty.
3. The banner hides automatically when the returned list becomes empty (no manual refresh required on the user's side).

**Constraints:** None
**Priority:** P1
**Dependencies:** REQ-DISC-001
**Verification:** Integration test
**Status:** Partial
**Notes:** AC 1 (session-scoped discovery-status endpoint) has automated coverage. AC 2 and AC 3 (in-app banner on the reading surface) are deferred — tracked in pending.md.

---

### REQ-DISC-003: Feed health tracking and auto-eviction

**Intent:** Feeds that stop working are removed from the cache automatically, without manual intervention or a scheduled re-validation job.

**Applies To:** User

**Acceptance Criteria:**
1. During every digest generation, each feed fetch that fails (non-2xx, parse error, timeout) increments the `source_health:{url}` KV counter.
2. When a feed's consecutive failure count reaches 2, the feed is removed from its `sources:{tag}` KV entry.
3. If all feeds for a tag are evicted, the tag is re-queued in `pending_discoveries` so it can be rediscovered on the next cron.
4. A successful fetch resets the counter for that URL.
5. `source_health:{url}` entries expire after 7 days to prevent unbounded KV growth.

**Constraints:** None
**Priority:** P2
**Dependencies:** REQ-DISC-001
**Verification:** Integration test
**Status:** Partial
**Notes:** Discovery-time failure counting and tag re-queue on auto-eviction have automated coverage. Feed-level health tracking during the hourly coordinator run is deferred — tracked in pending.md.

---

### REQ-DISC-004: Manual re-discover

**Intent:** Users can force a fresh discovery attempt for a stubborn tag whose feeds the LLM failed to find.

**Applies To:** User

**Acceptance Criteria:**
1. `/settings` shows a "Re-discover" button next to any tag whose `sources:{tag}` value has an empty `feeds` array.
2. `POST /api/discovery/retry` with body `{ tag }` validates that the tag is in the user's `hashtags_json`; returns HTTP 400 with code `unknown_tag` otherwise.
3. The endpoint deletes the `sources:{tag}` and `discovery_failures:{tag}` KV entries and inserts a fresh `pending_discoveries` row for this `(user_id, tag)`.
4. The next 5-minute cron invocation picks it up.

**Constraints:** None
**Priority:** P2
**Dependencies:** REQ-DISC-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-DISC-005: Discovery prompt injection protection

**Intent:** Adversarial hashtag content cannot steer the LLM into producing malicious URLs or overriding discovery instructions.

**Applies To:** User

**Acceptance Criteria:**
1. The discovery prompt fences the user-supplied tag with triple backticks so the model treats it as data, not instructions.
2. The system prompt forbids guessing URLs and instructs the model to return fewer entries over unverified ones.
3. Every suggested URL passes SSRF validation (HTTPS-only, no private IPs) before any network call is made.
4. URL validation is applied independently of the LLM response — a malicious suggestion cannot bypass it.

**Constraints:** CON-SEC-002, CON-LLM-001
**Priority:** P0
**Dependencies:** REQ-DISC-001
**Verification:** Automated test
**Status:** Implemented
