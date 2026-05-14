# Source Discovery

Per-tag feed discovery is LLM-assisted and SSRF-filtered. Settings save queues new tags; the 5-minute cron processes up to 3 pending tags per invocation and caches validated feeds globally (shared across all users who selected that tag). Feeds repair themselves: a URL that fails continuously across a configurable streak is evicted from the tag's cache, and when a tag's cache empties the tag is automatically re-queued for a fresh discovery pass.

---

### REQ-DISC-001: Per-tag feed discovery queueing and pickup

**Intent:** When a user adds a hashtag, the system enqueues the tag for feed discovery without polluting the queue with tags that already have working sources, and the discovery cron drains the queue at a bounded rate that lets new accounts see their first discovered feeds quickly.

**Applies To:** User

**Acceptance Criteria:**
1. On settings save, a submitted tag without a `sources:{tag}` KV entry and not covered by the curated source registry triggers an `INSERT OR IGNORE` into the `pending_discoveries` D1 table keyed by `(user_id, tag)`.
2. A submitted tag covered by the curated source registry short-circuits discovery at settings-save time so the registry's guaranteed feed is used directly and a namespace-collision match against an unrelated company's name in an aggregator query is never cached for it.
3. The 5-minute discovery cron defensively short-circuits curated-source tags when draining pending rows, so admin-path inserts and rows enqueued before a tag was added to the curated registry are skipped instead of running the LLM path against them.
4. The discovery cron picks at most 3 distinct tags from `pending_discoveries` per invocation so a backlog drains across multiple ticks instead of spiking LLM cost in one minute.
5. Within a cron pick, tags enqueued by a brand-new user's first settings save are processed before the steady-state queue so a new account sees discovered feeds on the next cron tick rather than waiting behind older pending tags from other users.
6. Among tags at the same priority level, the earliest `added_at` wins so the order in which a single user's tags drain is deterministic and oldest-first.

**Constraints:** [CON-LLM-001](constraints.md#con-llm-001-centralized-deterministic-prompts)

**Priority:** P0

**Dependencies:** [REQ-SET-002](settings.md#req-set-002-hashtag-curation-strip-ux)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-DISC-007: Per-tag feed discovery execution and persistence

**Intent:** For a pending tag the cron picks up, the LLM-discovery path produces working feed URLs without polluting the cache with unreachable or non-feed content, and the row's lifecycle in `pending_discoveries` is closed whether discovery succeeded or not so the queue does not leak rows.

**Applies To:** User

**Acceptance Criteria:**
1. For each picked tag without a curated source, a Workers AI call asks for up to 5 RSS, Atom, or JSON feed URLs.
2. The discovery prompt prefers first-party blogs, release notes, and changelogs where they exist, and instructs the model to omit a suggestion when no first-party feed and no aggregator fallback applies, so the model never invents URLs to fill the response.
3. The discovery prompt names a Google News query-RSS fallback that the model must include for tags without a first-party feed, so a consumer or brand tag never returns zero sources.
4. Each suggested URL is validated end-to-end before persistence: HTTPS scheme, SSRF filter (no private ranges, loopback, link-local, Cloudflare internal), HTTP 200, content-type matches the declared kind, parseable body, and at least one item with a title and URL. A URL failing any check is dropped from the result.
5. Valid feeds are persisted to `sources:{tag}` as `{ feeds: [{ name, url, kind }], discovered_at }` with no TTL so the global cache is shared across every user who selected that tag.
6. Rows for the picked tag are deleted from `pending_discoveries` regardless of discovery success, so a tag that yielded zero valid feeds does not stay enqueued and re-run the same prompt every 5 minutes.

**Constraints:** [CON-SEC-002](constraints.md#con-sec-002-outbound-article-body-fetches-flow-through-the-ssrf-guarded-helper), [CON-LLM-001](constraints.md#con-llm-001-centralized-deterministic-prompts)

**Priority:** P0

**Dependencies:** [REQ-DISC-001](#req-disc-001-per-tag-feed-discovery-queueing-and-pickup)

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

**Dependencies:** [REQ-DISC-001](#req-disc-001-per-tag-feed-discovery-queueing-and-pickup)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-DISC-003: Self-healing feed health tracking

**Intent:** Broken feeds repair themselves without manual intervention. A feed that stops returning valid responses is tolerated through short outages but is eventually replaced by a fresh discovery pass, so users see new sources for a tag whose original feeds have gone dark rather than a permanently empty section.

**Applies To:** User

**Acceptance Criteria:**
1. Every per-feed fetch in the global scrape pipeline records its outcome against a per-URL health counter.
2. A successful fetch (any HTTP 200 response with a parseable feed body, even if the feed lists zero items) resets the counter for that URL.
3. A failed fetch (network error, non-2xx status, body cap exceeded, unparseable content) increments the counter.
4. The counter is stored in a shared cache with a seven-day expiry so stale entries never accumulate.
5. When the counter for a URL reaches thirty consecutive failed fetches, the URL is evicted from the tag's feed list on the next scrape tick — thirty aligns with the six-times-daily scrape cadence so a feed must fail continuously for roughly five days before removal, absorbing day-long outages without thrashing.
6. When eviction empties a tag's feed list, the tag is automatically enqueued for a fresh discovery pass so the next discovery cron repopulates it with new sources; the re-queue path is identical whether the tag was seeded by the default list on sign-up or added by a user.
7. Hard-coded curated feeds (the operator-maintained global registry) participate in the same counter so operators see failing URLs in logs, but they are never mutated at runtime — their replacement is a code change, not a runtime eviction.

**Constraints:** None

**Priority:** P2

**Dependencies:** [REQ-DISC-001](#req-disc-001-per-tag-feed-discovery-queueing-and-pickup)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-DISC-004: Manual re-discover UI surface

**Intent:** The settings page surfaces a "Discover missing sources" button when at least one of the user's tags has no working feed sources, so the operator can force a fresh discovery attempt without going through a tag delete + re-add. The UI hides itself when no tag is stuck.

**Applies To:** Admin

**Acceptance Criteria:**
1. The settings page renders a single "Discover missing sources" button whenever at least one of the user's tags is "stuck" — defined as: not covered by any curated source AND either has no successful discovery cache yet, has an unparseable cache entry, or has an explicitly-empty cached feed list.
2. Tags covered by a curated source are never flagged as stuck, so curated-feed tags never appear in the Stuck list.
3. Transient cache-read errors fall back to "not stuck" so a flaky read does not light up every tag at once.
4. The Stuck tags section is absent entirely from the page when no tag is stuck.

**Constraints:** None

**Priority:** P2

**Dependencies:** [REQ-DISC-001](#req-disc-001-per-tag-feed-discovery-queueing-and-pickup), [REQ-DISC-003](#req-disc-003-self-healing-feed-health-tracking), [REQ-DISC-008](#req-disc-008-manual-re-discover-endpoint-contract)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-DISC-008: Manual re-discover endpoint contract

**Intent:** The server-side contract for the manual re-discover operation validates ownership, clears cached state, enqueues fresh discovery, supports both scripted and native-form transports, and gates the routes behind Cloudflare Access.

**Applies To:** Admin

**Acceptance Criteria:**
1. The re-discover endpoint(s) validate that every tag they are asked to re-queue is in the authenticated user's saved tag list; any unknown tag is refused, preventing anyone with a session from triggering arbitrary LLM calls for strings they do not control.
2. A valid re-discover request clears each affected tag's cached feeds and per-tag discovery-failure counter, then enqueues a fresh discovery pass for each so the next discovery cron repopulates them.
3. Two transports are supported: a single-tag JSON API for scripted callers (returns an API-shaped response) and a bulk-by-default native HTML form submission from the settings page.
4. The bulk endpoint accepts both POST (the form submission) and GET (the request shape Cloudflare Access uses when it bounces a click through SSO and lands the operator back at the original URL).
5. After a POST form submission, the browser lands on the settings page with a confirmation banner naming how many tags were re-queued.
6. After the SSO-bounced GET, the browser also lands on the settings page with the same confirmation banner, never on a raw 404.
7. The routes are additionally gated by Cloudflare Access at the zone level so only the admin account can reach them in production; other authenticated users never see a reachable endpoint even if the settings button were to be forged into their page.

**Constraints:** None

**Priority:** P2

**Dependencies:** [REQ-DISC-001](#req-disc-001-per-tag-feed-discovery-queueing-and-pickup), [REQ-DISC-003](#req-disc-003-self-healing-feed-health-tracking), [REQ-DISC-004](#req-disc-004-manual-re-discover-ui-surface)

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

**Constraints:** [CON-SEC-002](constraints.md#con-sec-002-outbound-article-body-fetches-flow-through-the-ssrf-guarded-helper), [CON-LLM-001](constraints.md#con-llm-001-centralized-deterministic-prompts)

**Priority:** P0

**Dependencies:** [REQ-DISC-001](#req-disc-001-per-tag-feed-discovery-queueing-and-pickup)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-DISC-006: Stuck-tag retention

**Intent:** A tag that consistently produces no working sources is dropped from the user's interests automatically so the settings page never grows a permanent list of dead tags the user has to clean up by hand.

**Applies To:** User

**Acceptance Criteria:**
1. The settings page lists the actual hashtag names that currently have no working feeds (not just a count), so the user can see at a glance which tags are stuck.
2. A tag whose discovered-source cache has remained in the empty state for more than 7 days is removed from every user's interests automatically by the daily retention pass. Its discovered-source cache and per-tag failure counter are cleared in the same pass.
3. Removal does not block other passes: a transient failure of the prune step still lets article retention and orphan-tag cleanup complete.
4. The 7-day window resets the moment discovery succeeds: a tag whose feeds come back online before the cutoff stays in the user's interests with no further action.

**Constraints:** None

**Priority:** P2

**Dependencies:** [REQ-DISC-001](#req-disc-001-per-tag-feed-discovery-queueing-and-pickup), [REQ-DISC-003](#req-disc-003-self-healing-feed-health-tracking), [REQ-DISC-004](#req-disc-004-manual-re-discover-ui-surface)

**Verification:** Automated test

**Status:** Implemented
