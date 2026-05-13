# History & Stats

Past digests paginated on `/history`, 30 per page. A four-tile stats widget on `/settings` shows digests generated, articles read / total, tokens consumed, and cost to date — pulled from D1 with user-scoped SQL (IDOR-safe by construction through JOINs).

---

### REQ-HIST-001: Day-grouped article history

**Intent:** Users can browse how the global pool has grown over time, grouped by day of publication, and expand any day to see the articles it produced. The day-grouped view is the default landing surface on `/history` and matches the article retention window so users never see empty rows beyond what's still in the pool.

**Applies To:** User

**Acceptance Criteria:**
1. `/history` renders a day-grouped list of days on which articles were published, newest day first.
2. Each day row shows the date (user-local), the story count for that day, the aggregated cost for that day, and the aggregated token count for that day.
3. Clicking a day row expands inline to reveal the articles published that day; clicking again collapses the row. No per-scrape-run breakdown is shown; the summary row already carries cumulative tokens and cost for the day.
4. Per-day aggregates are read from the scrape-run aggregation rather than re-derived from article rows.
5. The history window matches the article retention window (REQ-PIPE-005), both are 14 days. Extending one without the other would either show empty rows beyond the retention boundary or hide ingested data still in the pool.

**Constraints:** [CON-DATA-001](constraints.md#con-data-001-strong-consistency-in-d1-edge-cache-in-kv)

**Priority:** P1

**Dependencies:** [REQ-PIPE-006](generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-HIST-003: Search, tag filter, and deep-link on /history

**Intent:** Users who remember a keyword or a tag rather than a date can search and filter the 14-day pool from `/history`, with the active query and tag selections reflected in the URL so navigating from an opened article and back restores the exact filtered view.

**Applies To:** User

**Acceptance Criteria:**
1. Typing 3 or more characters into the search input hides the day-grouped list and renders matching articles in a flat dashboard-style grid above it; clearing back below 3 characters restores the day-grouped view instantly and preserves scroll position. The active query is reflected in the URL as a `q` parameter so opening an article from search and returning via the browser back button restores the exact result set.
2. A tag railing sits between the search input and the day list, mirroring the dashboard's visual component: each chip shows the tag's count across the 14-day window, supports add-tag and remove-tag affordances that persist to the user's hashtag list, and pre-selects chips listed in the URL `tags` parameter.
3. Selecting a tag hides the day-grouped list and renders matching articles in the same flat grid the search uses.
4. Search and tag selections combine with AND logic (both must match), and both states are reflected in the URL so the browser back button from an opened article restores the exact filtered view.
5. `/history` accepts a deep-link query parameter specifying a single local calendar date; when present and the date matches one of the available days, the page renders only that day's row pre-expanded (the search input and other day rows are suppressed) and shows a "Back to all days" control that returns the user to the full 14-day list without the query parameter. An unknown or malformed date parameter is ignored and the full list is shown.

**Constraints:** [CON-DATA-001](constraints.md#con-data-001-strong-consistency-in-d1-edge-cache-in-kv)

**Priority:** P1

**Dependencies:** [REQ-HIST-001](#req-hist-001-day-grouped-article-history)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-HIST-002: User stats widget

**Intent:** Users see at-a-glance metrics of how much the global pipeline has cost overall and how much of the pool they have personally engaged with.

**Applies To:** User

**Acceptance Criteria:**
1. `/settings` displays a compact widget with four tiles: Digests generated, Articles read / total, Tokens consumed, Cost to date.
2. Tokens-consumed and Cost-to-date tiles read from the scrape-run aggregation, reflecting the global pipeline's totals rather than any per-user generation cost.
3. Articles-total counts the articles in the pool whose tags intersect the session user's currently-active tag list. Articles-read counts the user's reads scoped to that same active-tag pool, so the ratio always describes "of the articles you can see right now, how many have you read" — reads on articles whose only tag the user has since deselected drop out of both numerator and denominator.
4. "Articles read / total" shows both numbers as `{read} of {total}`.
5. Cost is displayed in USD with 2-4 significant figures, e.g., `$0.14` or `$2.37`.
6. The widget refreshes on every page load; no cache layer is involved.

**Constraints:** [CON-DATA-001](constraints.md#con-data-001-strong-consistency-in-d1-edge-cache-in-kv)

**Priority:** P2

**Dependencies:** [REQ-HIST-001](#req-hist-001-day-grouped-article-history), [REQ-READ-003](reading.md#req-read-003-read-tracking), [REQ-PIPE-006](generation.md#req-pipe-006-scrape_runs-aggregation-surfaces-stats-history-and-in-flight-progress)

**Verification:** Integration test

**Status:** Implemented
