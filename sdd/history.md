# History & Stats

Past digests paginated on `/history`, 30 per page. A four-tile stats widget on `/settings` shows digests generated, articles read / total, tokens consumed, and cost to date — pulled from D1 with user-scoped SQL (IDOR-safe by construction through JOINs).

---

### REQ-HIST-001: Paginated past digests

**Intent:** Users can browse prior digests, not just today's, and catch up on days they missed.

**Applies To:** User

**Acceptance Criteria:**
1. `/history` fetches from `GET /api/history?offset=0`; each page returns up to 30 digests, newest first.
2. Each row shows date (user-local), status, article count, execution time, tokens consumed, estimated cost, and model name.
3. A "Load more" button fetches the next 30 via `offset` pagination; the list appends with a staggered fade-in.
4. Rows are clickable and open the corresponding digest's `/digest/:id` view.
5. The SQL is `SELECT d.*, (SELECT COUNT(*) FROM articles WHERE digest_id = d.id) AS article_count FROM digests d WHERE d.user_id = :session_user_id ORDER BY generated_at DESC LIMIT 30 OFFSET :offset` — the `user_id` filter is mandatory.

**Constraints:** CON-DATA-001
**Priority:** P1
**Dependencies:** REQ-GEN-006
**Verification:** Integration test
**Status:** Implemented

---

### REQ-HIST-002: User stats widget

**Intent:** Users see at-a-glance metrics of how much the product has cost them and how much they actually engaged with.

**Applies To:** User

**Acceptance Criteria:**
1. `/settings` displays a compact widget with four tiles: Digests generated, Articles read / total, Tokens consumed, Cost to date.
2. Each tile value is the result of a single SQL query scoped to the session user; article queries JOIN through digests and filter by `d.user_id = :session_user_id` so a user cannot see another user's data.
3. "Articles read / total" shows both numbers as `{read} of {total}`.
4. Cost is displayed in USD with 2-4 significant figures, e.g., `$0.14` or `$2.37`.
5. The widget refreshes on every page load; no cache layer is involved.

**Constraints:** CON-DATA-001
**Priority:** P2
**Dependencies:** REQ-HIST-001, REQ-READ-003
**Verification:** Integration test
**Status:** Implemented
