# Reading Experience

The heart of the product. Overview grid of today's digest, detail view per article with three critical-point bullets and a prominent source link, live-generation state with skeleton loaders and 5-second polling, pending-today banner so users who arrive before their scheduled time know when the next digest is coming, and read-tracking on the article detail page.

---

### REQ-READ-001: Overview grid of today's digest

**Intent:** Today's digest is a scannable grid of article cards, each with enough information to decide whether to click through.

**Applies To:** User

**Acceptance Criteria:**
1. `/digest` renders a responsive card grid: 1 column on mobile (<640px), 2 on tablet (≥768px), 3 on desktop (≥1024px).
2. Each card shows the article title, the 120-character one-liner summary, and the source name as a subtle badge.
3. Cards enter with a staggered fade-in (40ms per card, capped at 10 cards) when `prefers-reduced-motion` is `no-preference`; under `reduce` the entrance is instant.
4. A "Refresh now" button is visible; during generation it morphs into an indeterminate progress bar.
5. The digest footer shows execution time, token count, estimated cost, and model name.
6. Each card shows a hashtag-glyph affordance to the left of the title. Activating the affordance opens a non-interactive popover anchored to the card listing the user hashtags this article is tagged with; the popover dismisses itself automatically after 5 seconds, or immediately when the affordance is activated a second time.
7. The tag strip (REQ-SET-002) doubles as a filter: while any tag is selected, the grid shows only cards whose stored tag list intersects the selection. With no selection every card is visible; with a selection that matches no card, a brief "no stories match" message replaces the grid and invites the user to deselect.

**Constraints:** CON-A11Y-001
**Priority:** P0
**Dependencies:** REQ-GEN-006, REQ-SET-002
**Verification:** Integration test
**Status:** Partial
**Notes:** AC 6 (per-card # popover with 5 s auto-dismiss) and AC 7 (tag-strip filter + "no stories match" empty state) ship in code but have no automated test. AC 1-5 remain verified by `tests/reading/digest-page.test.ts`.

---

### REQ-READ-002: Article detail view

**Intent:** Each article gets a focused detail page with the long-form summary and a prominent link to the original source.

**Applies To:** User

**Acceptance Criteria:**
1. `/digest/:id/:slug` renders the article title, the three `details` bullets as an unordered list, and a prominent "Read at source" link to `source_url` (opens in a new tab with `rel="noopener noreferrer"`).
2. All text is rendered with `textContent` — no markdown parsing, no HTML sanitizer, no `innerHTML`.
3. The slug is derived from the title and enforced unique per digest.
4. A back control returns to `/digest` using the View Transitions shared-element morph for the card→detail transition, and reverses it on back.

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

**Intent:** During a ~60-second generation, users see meaningful progress instead of a blank screen, but the implementation stays as simple as possible.

**Applies To:** User

**Acceptance Criteria:**
1. When the current digest has `status='in_progress'`, `/digest` shows an indeterminate progress bar at the top and 10 card skeletons matching the real card dimensions (no layout shift when real cards arrive).
2. The skeleton shimmer is a 1.4-second linear-gradient sweep, disabled under `prefers-reduced-motion: reduce`.
3. The client polls `GET /api/digest/:id` every 5 seconds while status is `in_progress`; polling stops immediately on a status change.
4. On `status='ready'`, the real cards fade in with the staggered entrance from REQ-READ-001.
5. On `status='failed'`, the failure page for the error code is rendered (see REQ-READ-006).

**Constraints:** CON-A11Y-001
**Priority:** P0
**Dependencies:** REQ-READ-001, REQ-GEN-005
**Verification:** Integration test
**Status:** Implemented

---

### REQ-READ-005: Pending-today banner

**Intent:** Users who open the app before today's scheduled time see exactly when the next digest is coming, rather than confusingly seeing yesterday's content.

**Applies To:** User

**Acceptance Criteria:**
1. `GET /api/digest/today` returns `{ digest, live, next_scheduled_at }` where `digest` is the most recent digest row for this user.
2. If `digest.local_date` is not today, `/digest` shows a subtle banner "Next digest scheduled at {HH:MM} — in {Xh Ym}. Or refresh now."
3. The banner's countdown updates live, using the user's stored timezone.
4. If the user has never generated a digest, the banner reads "Your first digest is scheduled for {HH:MM}."

**Constraints:** None
**Priority:** P1
**Dependencies:** REQ-SET-003, REQ-GEN-006
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
5. 404 and 500 responses have dedicated pages with a calm headline and two clear actions.

**Constraints:** CON-SEC-001
**Priority:** P1
**Dependencies:** REQ-READ-001
**Verification:** Integration test
**Status:** Implemented
