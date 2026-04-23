# History & Stats

Past digests paginated on `/history`, 30 per page. A four-tile stats widget on `/settings` shows digests generated, articles read / total, tokens consumed, and cost to date — pulled from D1 with user-scoped SQL (IDOR-safe by construction through JOINs).

---

### REQ-HIST-001: Day-grouped article history

**Intent:** Users can browse how the global pool has grown over time, grouped by day of publication, expand any day to see the articles it produced, and search across the full pool when they remember a keyword instead of a date.

**Applies To:** User

**Acceptance Criteria:**
1. `/history` renders a day-grouped list of days on which articles were published, newest day first.
2. Each day row shows the date (user-local), the story count for that day, the aggregated cost for that day, and the aggregated token count for that day.
3. Clicking a day row expands inline to reveal the articles published that day; clicking again collapses the row. No per-scrape-run breakdown is shown — the summary row already carries cumulative tokens and cost for the day.
4. Typing 3 or more characters into the search input hides the day-grouped list and renders matching articles in a flat dashboard-style grid above it; clearing back below 3 characters restores the day-grouped view instantly and preserves scroll position.
5. Per-day aggregates are read from the scrape-run aggregation rather than re-derived from article rows.

**Constraints:** CON-DATA-001
**Priority:** P1
**Dependencies:** REQ-PIPE-006
**Verification:** Integration test
**Status:** Implemented

---

### REQ-HIST-002: User stats widget

**Intent:** Users see at-a-glance metrics of how much the global pipeline has cost overall and how much of the pool they have personally engaged with.

**Applies To:** User

**Acceptance Criteria:**
1. `/settings` displays a compact widget with four tiles: Digests generated, Articles read / total, Tokens consumed, Cost to date.
2. Tokens-consumed and Cost-to-date tiles read from the scrape-run aggregation, reflecting the global pipeline's totals rather than any per-user generation cost.
3. Articles-total counts the articles in the pool whose tags intersect the session user's tag list; Articles-read counts the article-read rows owned by the session user.
4. "Articles read / total" shows both numbers as `{read} of {total}`.
5. Cost is displayed in USD with 2-4 significant figures, e.g., `$0.14` or `$2.37`.
6. The widget refreshes on every page load; no cache layer is involved.

**Constraints:** CON-DATA-001
**Priority:** P2
**Dependencies:** REQ-HIST-001, REQ-READ-003, REQ-PIPE-006
**Verification:** Integration test
**Status:** Implemented
