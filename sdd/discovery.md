# Source Discovery

Per-tag feed discovery is LLM-assisted and SSRF-filtered. Settings save queues new tags; the 5-minute cron processes up to 3 pending tags per invocation and caches validated feeds globally (shared across all users who selected that tag). Feeds repair themselves: a URL that fails continuously across a configurable streak is evicted from the tag's cache, and when a tag's cache empties the tag is automatically re-queued for a fresh discovery pass.

---

### REQ-DISC-001: LLM-assisted per-tag feed discovery

**Intent:** When a user adds a hashtag, the system finds working feeds for that tag without requiring a hand-curated catalog — first-party sources when they exist, and a documented third-party aggregator fallback when they don't, so that consumer/brand tags (where no official feed is available) still produce at least one source.

**Applies To:** User

**Acceptance Criteria:**
1. On settings save, any submitted tag without a `sources:{tag}` KV entry triggers an `INSERT OR IGNORE` into the `pending_discoveries` D1 table keyed by `(user_id, tag)`.
2. The 5-minute cron picks up to 3 distinct tags from `pending_discoveries` per invocation, ordered by the earliest `added_at` for each tag.
3. For each tag, a Workers AI call asks for up to 5 RSS, Atom, or JSON feed URLs. The prompt prefers first-party blogs, release notes, and changelogs where they exist, and names a Google News query-RSS fallback that the model must include for tags without a first-party feed so a consumer/brand tag never returns zero sources. The model is instructed to omit a suggestion only when neither a first-party feed nor the fallback applies.
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
**Status:** Deprecated
**Removed In:** 2026-04-24

---

### REQ-DISC-003: Self-healing feed health tracking

**Intent:** Broken feeds repair themselves without manual intervention. A feed that stops returning valid responses is tolerated through short outages but is eventually replaced by a fresh discovery pass, so users see new sources for a tag whose original feeds have gone dark rather than a permanently empty section.

**Applies To:** User

**Acceptance Criteria:**
1. Every per-feed fetch in the global scrape pipeline records its outcome against a per-URL health counter. A successful fetch — any HTTP 200 response with a parseable feed body, even if the feed lists zero items — resets the counter. A failed fetch (network error, non-2xx status, body cap exceeded, unparseable content) increments it. The counter is stored in a shared cache with a seven-day expiry so stale entries never accumulate.
2. When the counter for a URL reaches thirty consecutive failed fetches, the URL is evicted from the tag's feed list on the next scrape tick. Thirty aligns with the six-times-daily scrape cadence: a feed must fail continuously for roughly five days before it is removed, absorbing day-long outages without thrashing.
3. When eviction empties a tag's feed list, the tag is automatically enqueued for a fresh discovery pass so the next discovery cron repopulates it with new sources. The re-queue path is identical whether the tag was seeded by the default list on sign-up or added by a user — the system treats both as "a tag whose feeds need replacement".
4. Hard-coded curated feeds (the operator-maintained global registry) participate in the same counter so operators see failing URLs in logs, but they are never mutated at runtime — their replacement is a code change, not a runtime eviction.

**Constraints:** None
**Priority:** P2
**Dependencies:** REQ-DISC-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-DISC-004: Manual re-discover

**Intent:** An operator can force a fresh discovery attempt for a stubborn tag whose feeds the LLM failed to find, without needing to go through a tag delete + re-add.

**Applies To:** Admin

**Acceptance Criteria:**
1. The settings page renders a single "Discover missing sources" button whenever at least one of the user's tags is "stuck" — defined as: not covered by any curated source AND either has no successful discovery cache yet, has an unparseable cache entry, or has an explicitly-empty cached feed list. Tags covered by a curated source are never flagged as stuck (curated feeds always deliver). Transient cache-read errors fall back to "not stuck" so a flaky read does not light up every tag at once. The Stuck tags section is absent entirely when no tag is stuck.
2. The re-discover endpoint(s) validate that every tag they are asked to re-queue is in the authenticated user's saved tag list; any unknown tag is refused. This prevents anyone with a session from triggering arbitrary LLM calls for strings they do not control.
3. A valid re-discover request clears each affected tag's cached feeds and per-tag discovery-failure counter, then enqueues a fresh discovery pass for each so the next discovery cron repopulates them.
4. Two transports are supported: a single-tag JSON API for scripted callers (returns an API-shaped response) and a bulk-by-default native HTML form submission from the settings page (returns the operator to the settings page with a visible confirmation noting how many tags were re-queued).
5. The routes are additionally gated by Cloudflare Access at the zone level so only the admin account can reach them in production; other authenticated users never see a reachable endpoint even if the settings button were to be forged into their page.

**Constraints:** None
**Priority:** P2
**Dependencies:** REQ-DISC-001, REQ-DISC-003
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
