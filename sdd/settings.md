# Onboarding & Settings

A single `/settings` route handles both first-run onboarding and steady-state configuration. Covers hashtag curation, schedule (HH:MM + IANA timezone), model selection, email notification toggle, and the middleware gate that keeps un-configured users on the settings page.

---

### REQ-SET-001: Unified first-run and edit flow

**Intent:** A new user configures their first digest in one place without a multi-step wizard, and the same form handles every subsequent edit.

**Applies To:** User

**Acceptance Criteria:**
1. Users landing without `hashtags_json` or `digest_hour` set are redirected to `/settings?first_run=1`.
2. First-run mode shows a "Welcome" hero and the primary button reads "Generate my first digest".
3. Edit mode (after configuration is complete) shows the same form with the primary button reading "Save" and additional controls for logout, account deletion, and the install-app prompt.
4. Successful first-run save triggers the digest pipeline out-of-band and redirects the user to `/digest` with the live generation state visible.

**Constraints:** None
**Priority:** P0
**Dependencies:** REQ-AUTH-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-SET-002: Hashtag curation

**Intent:** Users choose the interests that drive every subsequent source fetch and LLM ranking decision.

**Applies To:** User

**Acceptance Criteria:**
1. The settings form shows 20 pre-defined hashtag chips covering common tech topics, each toggleable on/off with clear visual state.
2. A custom text input accepts user-entered hashtags; on submit they are lowercased and stripped of leading `#`.
3. Each hashtag must be 2–32 characters long and contain only characters in `[a-z0-9-]`; other characters are stripped server-side before storage.
4. At least one hashtag is required to save; a maximum of 20 total hashtags is enforced server-side.
5. Duplicate hashtags are collapsed before storage.

**Constraints:** None
**Priority:** P0
**Dependencies:** REQ-SET-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-SET-003: Scheduled digest time with timezone

**Intent:** Users pick the exact local time their daily digest is generated, so the email arrives at a predictable moment in their day.

**Applies To:** User

**Acceptance Criteria:**
1. The form includes a native `<input type="time">` time picker that captures an hour and minute.
2. The browser-detected IANA timezone is displayed next to the time with a link to override via a dropdown of common zones.
3. Initial timezone is populated from `Intl.DateTimeFormat().resolvedOptions().timeZone` on first load and saved to the user row.
4. The saved time is interpreted in the user's stored timezone; DST transitions are handled correctly using `Intl.DateTimeFormat`.
5. Changing the scheduled time never creates a duplicate digest for a day that has already generated.

**Constraints:** None
**Priority:** P0
**Dependencies:** REQ-SET-002
**Verification:** Integration test
**Status:** Implemented

---

### REQ-SET-004: Model selection

**Intent:** Users pick the Workers AI model that writes their summaries, trading cost against quality visibly.

**Applies To:** User

**Acceptance Criteria:**
1. The model dropdown lists entries from a hardcoded `MODELS` list, grouped under "Featured" and "Budget" section headers.
2. Each option shows a short description and an estimated per-digest cost computed from the model's per-million-token prices.
3. The default selection is the `DEFAULT_MODEL_ID` constant.
4. On save, the server rejects any `model_id` not present in `MODELS` with HTTP 400 and error code `invalid_model_id`.
5. The model dropdown lives inside an "Advanced" collapsible section, collapsed by default.

**Constraints:** CON-LLM-001
**Priority:** P1
**Dependencies:** REQ-SET-003
**Verification:** Integration test
**Status:** Implemented

---

### REQ-SET-005: Email notification preference

**Intent:** Users can receive a "your digest is ready" email on scheduled runs, or opt out without losing in-app digests.

**Applies To:** User

**Acceptance Criteria:**
1. The settings form includes a single toggle labeled "Email me when my daily digest is ready", defaulting to on for new accounts.
2. Toggle state persists to the `users.email_enabled` column.
3. When the toggle is off, scheduled digests still generate and appear in the app; no email is sent for that user.
4. Manual refresh never sends email, regardless of toggle state.

**Constraints:** None
**Priority:** P1
**Dependencies:** REQ-SET-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-SET-006: Settings-incomplete gate

**Intent:** Users who have not yet completed minimum configuration cannot navigate to the reading surface, preventing empty-state confusion.

**Applies To:** User

**Acceptance Criteria:**
1. Any authenticated request to a path other than `/settings`, `/api/auth/*`, or `/api/settings` with `hashtags_json IS NULL` or `digest_hour IS NULL` is redirected to `/settings?first_run=1`.
2. Once both columns are non-null, visiting `/settings?first_run=1` redirects to `/settings` (edit mode).
3. The gate keys on "settings incomplete", not on whether the first digest has generated; a user whose first digest fails is not trapped.

**Constraints:** None
**Priority:** P0
**Dependencies:** REQ-SET-001, REQ-AUTH-002
**Verification:** Integration test
**Status:** Implemented

---

### REQ-SET-007: Timezone change detection

**Intent:** When a user's browser timezone changes from the stored value (e.g., they traveled), they're offered a one-click update without forcing a re-login.

**Applies To:** User

**Acceptance Criteria:**
1. On every authenticated page load, the browser's current timezone is compared to the stored `users.tz`.
2. If different, a non-blocking banner offers "Detected {new_tz} — update your setting?" with an accept/dismiss control.
3. Accepting persists the new timezone to the user row; dismissing hides the banner for 24 hours.

**Constraints:** None
**Priority:** P2
**Dependencies:** REQ-SET-003
**Verification:** Integration test
**Status:** Implemented
