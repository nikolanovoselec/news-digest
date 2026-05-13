# Reading Experience

The heart of the product. Overview grid of the freshest articles read from the shared pool filtered by the user's active tags, detail view per article with long-form reading prose and a prominent source link, the shared tag railing with reorder cascade, the dedicated starred-articles surface, calm error/empty/offline pages, and read-tracking on the article detail page.

---

### REQ-READ-001: Overview grid of today's digest

**Intent:** Today's digest is a scannable grid of article cards read from the shared article pool filtered by the user's active tags, with a lightweight header that shows when the pool was last refreshed and when the next refresh is due.

**Applies To:** User

**Acceptance Criteria:**
1. `/digest` reads articles from the global article pool filtered by the user's active tags; articles whose tag list does not intersect the user's tag list are excluded.
2. The top of the page shows "Last updated at HH:MM" with the most-recent scrape time, and a live "Next update in Xm" countdown (formatted "Xh Ym" when more than an hour remains, "Xm" otherwise) that counts down toward the next scheduled scrape tick and is visibly updated as time passes. When a scrape run is currently in flight at first paint, the countdown is replaced by an "Update in progress…" indicator until the run completes, so the operator and any reader who lands on the dashboard mid-run sees the live state immediately rather than a misleading countdown to the next tick.
3. No manual Refresh button is rendered and no live-state skeleton cards are shown — the pool is always populated so the grid renders directly.
4. When the user has no tag filters selected, the grid shows every article whose tags intersect the user's full tag list; when one or more filter tags are selected, the grid narrows to articles matching those filters.
5. The grid shows the 29 articles with the most recent first ingestion matching the user's active tags, ordered by first-ingestion descending with published-at as a tiebreaker. "First ingestion" is the timestamp at which a story first entered the pool — re-discoveries on later ticks append the new source to the article's source list but never re-stamp the ingestion time. The dashboard order therefore reflects when each story was new to the pool, not how recently any feed re-emitted it; older stories that keep being re-broadcast by feeds do not displace genuinely fresher arrivals. Articles roll off the 29-card window as newer arrivals push them out.
6. The grid's final slot (slot 30) is a "see all of today's articles in Search & History" tile containing a centred list-style icon; activating it navigates the user to the Search & History page scoped to today's local date. Per-tag filtering that reaches beyond the newest-29 window lives on Search & History, not on the dashboard.
7. When the same story has been reported by more than one source, the source label at the bottom of the card shows the primary publisher name with a `+N` suffix (e.g. `MASHABLE +1`, `TECHCRUNCH +3`) where N is the count of additional sources beyond the primary; single-source articles show the publisher name with no suffix. The same `+N` treatment applies to cards rendered on Search & History and the starred-articles surface so attribution reads identically across all card grids.

**Constraints:** [CON-A11Y-001](constraints.md#con-a11y-001-accessibility-minimum)

**Priority:** P0

**Dependencies:** [REQ-PIPE-001](generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-SET-002](settings.md#req-set-002-hashtag-curation-strip-ux)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-READ-002: Article detail view rendering

**Intent:** Each article gets a focused detail page that renders the long-form summary, a small-caps metadata line in the user's local time, and a prominent link to the original source. The page is laid out as long-form reading prose with a drop-cap first paragraph, a hyphenated 62-character column, and every text node rendered via `textContent` so untrusted LLM output cannot execute or inject markup.

**Applies To:** User

**Acceptance Criteria:**
1. `/digest/:id/:slug` renders the article title, the detail paragraphs as long-form reading prose, a small-caps metadata line (source · publish date · ingestion time), and a prominent "Read at source" affordance.
2. The ingestion time in the metadata line is wall-clock only (hour:minute, no date) rendered in the user's IANA timezone, with the publish date right beside it in the same line so a duplicate ingestion date would read as redundant noise.
3. The first paragraph carries a drop-cap initial and the reading column is capped around 62 characters with hyphenation.
4. All text is rendered with `textContent` — no markdown parsing, no HTML sanitizer, no `innerHTML`.
5. The slug is derived from the title and enforced unique per article.

**Constraints:** [CON-SEC-003](constraints.md#con-sec-003-plaintext-only-llm-output), [CON-A11Y-001](constraints.md#con-a11y-001-accessibility-minimum)

**Priority:** P0

**Dependencies:** [REQ-READ-001](#req-read-001-overview-grid-of-todays-digest)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-READ-009: Article detail return navigation and source affordance

**Intent:** From the article detail view, the user can return to the page they came from (with the shared-element morph playing in reverse), and the "Read at source" affordance either links directly to a single source or opens a modal listing every known source for multi-source articles. Direct-link visitors land on `/digest` when there is no prior in-app page to return to.

**Applies To:** User

**Acceptance Criteria:**
1. A back control returns the user to the page they navigated FROM (the dashboard, search results, starred page, history day view, etc.) when they arrived via in-app navigation, whether the origin page was loaded as a fresh document or reached as a same-app client-side navigation; direct-link visitors (no prior in-app page in this tab's session) land on `/digest`.
2. The View Transitions shared-element morph plays in reverse when returning to a page that renders the same card, including when that card sits below the fold of the origin page (e.g. a card inside an expanded day deep in `/history`). The source page's scroll position is restored before the morph snapshot is captured so the reverse morph lands on the originating card rather than silently degrading to a root cross-fade.
3. When the article has at least one alternative source, activating "Read at source" opens a modal listing every known source (primary + alternatives) with each source's name and per-source timestamp.
4. When the article has only one source, "Read at source" links directly to that source in a new tab with `rel="noopener noreferrer"` rather than opening the modal.
5. The source-list modal closes on Escape and on backdrop click.

**Constraints:** [CON-A11Y-001](constraints.md#con-a11y-001-accessibility-minimum)

**Priority:** P0

**Dependencies:** [REQ-READ-002](#req-read-002-article-detail-view-rendering)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-READ-003: Read tracking

**Intent:** The product can tell whether the user engaged with an article (not just clicked the source link) so the stats widget reflects real reading.

**Applies To:** User

**Acceptance Criteria:**
1. On first view of an article's detail page, the page loader atomically records that this user has read this article. Articles are global and shared across users; the read mark is scoped per (user, article) pair, never per digest.
2. A user can only mark their own reads — one user's read activity never appears under another user's account, and one user cannot cause another user's article to be marked read.
3. Clicking the source link does not record a read; only opening the detail view counts.
4. Re-visiting an already-read detail page is idempotent — the original read timestamp is preserved and no duplicate read is recorded.

**Constraints:** [CON-DATA-001](constraints.md#con-data-001-strong-consistency-in-d1-edge-cache-in-kv)

**Priority:** P1

**Dependencies:** [REQ-READ-002](#req-read-002-article-detail-view)

**Verification:** Integration test

**Status:** Implemented

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

**Dependencies:** [REQ-READ-001](#req-read-001-overview-grid-of-todays-digest)

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

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P1

**Dependencies:** [REQ-READ-001](#req-read-001-overview-grid-of-todays-digest)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-READ-007: Tag railing reorder animation

**Intent:** When the user taps a chip in the shared tag railing on the dashboard or Search & History, the chip animates into its new sort position and the chips between its old and new positions cascade to fill the slot it left. The visual confirms what the user just did and no chip ever vanishes mid-motion.

**Applies To:** User

**Acceptance Criteria:**
1. Tapping a chip plays an immediate scale-bounce pop on that chip so the user has unmistakable visual confirmation of the input before any other motion begins.
2. After the pop, the railing holds for roughly one second with the tapped chip visually elevated above its neighbours, so the user's eye lands on the chip about to move before the cascade starts.
3. The tapped chip then slides along a smooth path to its new sort position. On SELECT the destination is the leftmost slot so active filters cluster at the front. On UN-SELECT the destination is the chip's natural sort position among non-selected chips (sorted by article count descending, then alphabetically), and the chip slides rightward back into the count hierarchy. The slide duration is shaped so the on-screen portion of the chip's journey takes roughly the same time whether the chip travels a short visible hop or a long mostly-off-screen one, giving far chips a comfortably trackable visible window instead of a blur. Chips between the old and new positions slide the opposite direction on a faster fixed-duration curve so the gap closes promptly even while the tapped chip's full journey is still in flight.
4. No chip is hidden, removed, or repainted mid-flight; every chip remains visible and identifiable throughout the pop, hold, and cascade.
5. While the pop, hold, or cascade is in flight, additional taps on any chip are ignored until the motion settles, so a rapid double-tap never desynchronises the data order from the visual order.
6. When the tapped chip is already at its destination slot (e.g., the leftmost chip is tapped to select), only the pop plays; there is no hold, no cascade, and no trailing motion. The railing settles immediately after the pop completes so the chip never appears to "pulse twice".

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P2

**Dependencies:** [REQ-READ-001](#req-read-001-overview-grid-of-todays-digest), [REQ-HIST-001](history.md#req-hist-001-day-grouped-article-history)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-READ-008: Tag railing scroll, wrap, and fallback

**Intent:** The tag railing's scroll position, multi-row wrap behaviour, and no-animation fallback keep the reorder coherent across viewports and runtimes, so taps never produce a disorienting scroll jump or leave the data and visual orders out of sync.

**Applies To:** User

**Acceptance Criteria:**
1. On a viewport that scrolls the railing horizontally, the railing's scroll position is preserved across the cascade and the tap never produces an auto-scroll. The tapped chip slides toward its destination and may exit off either edge of the visible area; the user navigates the railing manually to see chips that have moved off-screen.
2. After a SELECT cascade that lands at slot 0, the next time the user starts to scroll the surrounding page downward the railing smoothly scrolls back to its leftmost position so the just-selected chip is revealed at the start. This convenience scroll fires at most once per tap and is cancelled if the user manually swipes the railing during it.
3. Unselect cascades do not arm the convenience scroll, because the chip lands mid-railing rather than at slot 0.
4. On a viewport that wraps the railing into multiple rows, the railing does not scroll at all; the user sees the entire cascade play out across whatever rows the chips occupy.
5. When the runtime does not support the animation primitives, the reorder still happens (the tapped chip ends up at its correct sort position, slot 0 on select or natural sort position on unselect, and the data order is correct); only the pop, hold, and cascade motion are skipped.

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P2

**Dependencies:** [REQ-READ-007](#req-read-007-tag-railing-reorder-animation)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-STAR-001: Star and unstar articles

**Intent:** Users can mark articles worth keeping by starring them from the dashboard grid or the article detail page, and remove the star with the same affordance.

**Applies To:** User

**Acceptance Criteria:**
1. Every card that lists an article — the dashboard grid, the article detail page, the starred-articles page, and the day-expanded and search-result grids on `/history` — shows a star toggle; activating it stars the article when unstarred and unstars it when starred.
2. Starring POSTs to the article-star endpoint; unstarring DELETEs the same endpoint; both flip the icon optimistically on click before the server response returns.
3. Star state is user-scoped — starring an article in one account never reveals the star in any other account's view.
4. State-changing star requests are protected by the Origin check from REQ-AUTH-003; unauthenticated requests receive HTTP 401.
5. A successful star/unstar response confirms the new state and the UI reconciles with the server value if the optimistic flip disagreed.
6. On every page that lists articles, each card renders its initial starred / unstarred state on first paint — articles the user has already starred appear filled and `aria-pressed` from the server-rendered HTML, without needing a hard refresh after a toggle on another page.

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy), [CON-DATA-001](constraints.md#con-data-001-strong-consistency-in-d1-edge-cache-in-kv)

**Priority:** P1

**Dependencies:** [REQ-AUTH-002](authentication.md#req-auth-002-access-token-refresh-token-instant-revocation), [REQ-AUTH-003](authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

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

**Constraints:** [CON-A11Y-001](constraints.md#con-a11y-001-accessibility-minimum)

**Priority:** P1

**Dependencies:** [REQ-STAR-001](#req-star-001-star-and-unstar-articles)

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

**Constraints:** [CON-A11Y-001](constraints.md#con-a11y-001-accessibility-minimum)

**Priority:** P2

**Dependencies:** [REQ-STAR-002](#req-star-002-starred-articles-page)

**Verification:** Integration test

**Status:** Implemented
