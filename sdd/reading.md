# Reading Experience

The heart of the product. Overview grid of today's digest, detail view per article with three critical-point bullets and a prominent source link, live-generation state with skeleton loaders and 5-second polling, pending-today banner so users who arrive before their scheduled time know when the next digest is coming, and read-tracking on the article detail page.

---

### REQ-READ-001: Overview grid of today's digest

**Intent:** Today's digest is a scannable grid of article cards read from the shared article pool filtered by the user's active tags, with a lightweight header that shows when the pool was last refreshed and when the next refresh is due.

**Applies To:** User

**Acceptance Criteria:**
1. `/digest` reads articles from the global article pool filtered by the user's active tags; articles whose tag list does not intersect the user's tag list are excluded.
2. The top of the page shows "Last updated at HH:MM" with the most-recent scrape time, and a live "Next update in Xm" countdown (formatted "Xh Ym" when more than an hour remains, "Xm" otherwise) that counts down toward the next scheduled scrape tick and is visibly updated as time passes.
3. No manual Refresh button is rendered and no live-state skeleton cards are shown — the pool is always populated so the grid renders directly.
4. When the user has no tag filters selected, the grid shows every article whose tags intersect the user's full tag list; when one or more filter tags are selected, the grid narrows to articles matching those filters.
5. The grid shows the 29 articles with the most recent "last feed sighting" matching the user's active tags, ordered by last-feed-sighting descending with published-at as a tiebreaker. "Last feed sighting" wins over "published" so articles currently trending in any source feed bubble to the top of the dashboard on every scrape tick, and an older-pubDate article that was confirmed live in the feeds after a newer-pubDate one never overtakes it. Articles that have fallen out of every feed sink without a bump and eventually roll off the 29-card window.
6. The grid's final slot (slot 30) is a "see all of today's articles in Search & History" tile containing a centred list-style icon; activating it navigates the user to the Search & History page scoped to today's local date. Per-tag filtering that reaches beyond the newest-29 window lives on Search & History, not on the dashboard.

**Constraints:** CON-A11Y-001
**Priority:** P0
**Dependencies:** REQ-PIPE-001, REQ-SET-002
**Verification:** Integration test
**Status:** Implemented

---

### REQ-READ-002: Article detail view

**Intent:** Each article gets a focused detail page with the long-form summary and a prominent link to the original source; multi-source articles expose every known source behind the same affordance.

**Applies To:** User

**Acceptance Criteria:**
1. `/digest/:id/:slug` renders the article title, the detail paragraphs as long-form reading prose, a small-caps metadata line (source · publish date · estimated read time), and a prominent "Read at source" affordance. The first paragraph carries a drop-cap initial and the reading column is capped around 62 characters with hyphenation.
2. All text is rendered with `textContent` — no markdown parsing, no HTML sanitizer, no `innerHTML`.
3. The slug is derived from the title and enforced unique per article.
4. A back control returns the user to the page they navigated FROM (the dashboard, search results, starred page, history day view, etc.) when they arrived via in-app navigation; direct-link visitors land on `/digest`. The View Transitions shared-element morph plays in reverse when returning to a page that renders the same card.
5. When the article has at least one alternative source, activating "Read at source" opens a modal listing every known source (primary + alternatives) with each source's name and per-source timestamp; when the article has only one source, the affordance links directly to that source in a new tab with `rel="noopener noreferrer"`.
6. The modal closes on Escape and on backdrop click.

**Constraints:** CON-SEC-003, CON-A11Y-001
**Priority:** P0
**Dependencies:** REQ-READ-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-READ-003: Read tracking

**Intent:** The product can tell whether the user engaged with an article (not just clicked the source link) so the stats widget reflects real reading.

**Applies To:** User

**Acceptance Criteria:**
1. On first view of `/digest/:id/:slug`, the page loader runs `UPDATE articles SET read_at = :now WHERE id = :id AND digest_id IN (SELECT id FROM digests WHERE user_id = :session_user_id) AND read_at IS NULL` atomically.
2. The update is scoped by user through the subquery so a user cannot mark another user's articles as read.
3. Clicking the source link does not update `read_at`; only opening the detail view counts.
4. Re-visiting an already-read detail page is idempotent.

**Constraints:** CON-DATA-001
**Priority:** P1
**Dependencies:** REQ-READ-002
**Verification:** Integration test
**Status:** Implemented

---

### REQ-READ-004: Live generation state

Superseded by REQ-PIPE-001 in the 2026-04-23 global-feed rework. The per-user digest-in-progress state no longer exists on the dashboard: the shared article pool is always populated, so `/digest` renders real cards immediately (see REQ-READ-001 AC 3). Polling, skeleton cards, and the in-progress progress bar are removed.

**Intent:** During a ~60-second generation, users saw meaningful progress instead of a blank screen.

**Applies To:** User

**Acceptance Criteria:**
1. When the current digest was in progress, `/digest` showed an indeterminate progress bar at the top and 10 card skeletons matching the real card dimensions.
2. The skeleton shimmer was a linear-gradient sweep, disabled under reduced-motion preferences.
3. The client polled the digest-by-id endpoint every 5 seconds while generation was active; polling stopped immediately on a status change.
4. On completion, the real cards faded in with the staggered entrance from REQ-READ-001.
5. On failure, the failure page for the error code was rendered (see REQ-READ-006).

**Constraints:** CON-A11Y-001
**Priority:** P0
**Dependencies:** REQ-READ-001
**Verification:** Integration test
**Status:** Deprecated
**Replaced By:** REQ-PIPE-001
**Removed In:** 2026-04-23

---

### REQ-READ-005: Empty dashboard state

**Intent:** When the global pool contains no articles matching the user's tags, the dashboard communicates that clearly and nudges the user toward broadening their interests.

**Applies To:** User

**Acceptance Criteria:**
1. When the filtered article grid is empty, `/digest` shows exactly the copy "No news for you today, try adding additional tags." and no other body content.
2. The empty state does not include a link or redirect to the settings page.
3. The countdown header continues to render above the empty-state copy so users still see when the pool will next refresh.

**Constraints:** None
**Priority:** P1
**Dependencies:** REQ-READ-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-READ-006: Empty, error, and offline pages

**Intent:** Every failure mode has a calm, informative page rather than a broken or blank screen.

**Applies To:** User

**Acceptance Criteria:**
1. When the LLM returns fewer than 3 articles, the page shows "No stories today — try broader hashtags" with a link to `/settings`.
2. When the digest has `status='failed'`, the page shows "We couldn't build your digest" with a Try-again control and a Go-to-settings link; the raw `error_code` appears in a muted monospace footer, never prose from the error.
3. The Try-again control submits the refresh request in place and updates an inline status region next to the button — "Retrying…" while the request is in flight, a rate-limit reason with countdown when the refresh is rejected, and a network-error message on transport failure. The user stays on the failure page throughout; navigation to the live digest only happens once a new generation is actually accepted.
4. When `navigator.onLine` is false, a top-of-page banner reads "You're offline — showing the last digest you viewed"; the Refresh button is disabled with a tooltip.
5. 404 and 500 responses have dedicated pages with a calm headline and at least one clear action.

**Constraints:** CON-SEC-001
**Priority:** P1
**Dependencies:** REQ-READ-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-READ-007: Tag railing reorder animation

**Intent:** When the user taps a chip in the shared tag railing on the dashboard or Search & History, the chip animates into the leftmost slot and the chips that previously sat between it and the front cascade right to fill the slot it left. The visual confirms what the user just did, no chip ever vanishes mid-motion, and the railing as a whole never resets to an arbitrary scroll position.

**Applies To:** User

**Acceptance Criteria:**
1. Tapping a chip plays an immediate scale-bounce pop on that chip so the user has unmistakable visual confirmation of the input before any other motion begins.
2. After the pop, the railing holds for roughly one second with the tapped chip visually elevated above its neighbours, so the user's eye lands on the chip about to move before the cascade starts.
3. The tapped chip then slides leftward to the start of the railing along a smooth path long enough to be tracked by eye; chips that previously sat to its left in the new order slide rightward to fill the slot it vacated, all on the same duration so the motion reads as one continuous cascade.
4. No chip is hidden, removed, or repainted mid-flight — every chip remains visible and identifiable throughout the pop, hold, and cascade.
5. While the pop, hold, or cascade is in flight, additional taps on any chip are ignored until the motion settles, so a rapid double-tap never desynchronises the data order from the visual order.
6. On a viewport that scrolls the railing horizontally, the railing follows the moving chip until the chip docks at the railing's leftmost visible edge — and only when the chip was outside the visible area to begin with. A chip that was already on-screen when tapped does not trigger any auto-scroll.
7. On a viewport that wraps the railing into multiple rows, the railing does not scroll at all; the user sees the entire cascade play out across whatever rows the chips occupy.
8. When the runtime does not support the animation primitives, the reorder still happens (the tapped chip ends up at slot 0 and the data order is correct) — only the pop, hold, and cascade motion are skipped.

**Constraints:** CON-SEC-001
**Priority:** P2
**Dependencies:** REQ-READ-001, REQ-HIST-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-STAR-001: Star and unstar articles

**Intent:** Users can mark articles worth keeping by starring them from the dashboard grid or the article detail page, and remove the star with the same affordance.

**Applies To:** User

**Acceptance Criteria:**
1. Every card in the dashboard grid and the article detail page shows a star toggle; activating it stars the article when unstarred and unstars it when starred.
2. Starring POSTs to the article-star endpoint; unstarring DELETEs the same endpoint; both flip the icon optimistically on click before the server response returns.
3. Star state is user-scoped — starring an article in one account never reveals the star in any other account's view.
4. State-changing star requests are protected by the Origin check from REQ-AUTH-003; unauthenticated requests receive HTTP 401.
5. A successful star/unstar response confirms the new state and the UI reconciles with the server value if the optimistic flip disagreed.

**Constraints:** CON-SEC-001, CON-DATA-001
**Priority:** P1
**Dependencies:** REQ-AUTH-002, REQ-AUTH-003
**Verification:** Integration test
**Status:** Implemented

---

### REQ-STAR-002: Starred articles page

**Intent:** A dedicated page lists the articles the user has starred so they can return to items of lasting interest without digging through history.

**Applies To:** User

**Acceptance Criteria:**
1. `/starred` renders the same card grid as `/digest` but shows only articles the user has starred.
2. Articles are ordered by the time they were starred, most recent first.
3. When the user has starred no articles, the page shows exactly the copy "No starred articles yet." with no countdown header.
4. The countdown header from `/digest` does not appear on `/starred`.

**Constraints:** CON-A11Y-001
**Priority:** P1
**Dependencies:** REQ-STAR-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-STAR-003: Starred entry in the user menu

**Intent:** The user menu exposes a first-class entry point to the starred-articles page so users can find their saved items quickly.

**Applies To:** User

**Acceptance Criteria:**
1. The avatar user menu includes an entry labelled "Starred" linking to the starred-articles page.
2. The entry shows a star-outline glyph aligned to the right side of the row.
3. The entry is placed between the existing History and Settings entries in the menu order.

**Constraints:** CON-A11Y-001
**Priority:** P2
**Dependencies:** REQ-STAR-002
**Verification:** Integration test
**Status:** Implemented
