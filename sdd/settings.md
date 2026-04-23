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

**Intent:** Users choose the interests that drive every subsequent source fetch and LLM ranking decision, editing them inline wherever they read their digest rather than in a separate settings form.

**Applies To:** User

**Acceptance Criteria:**
1. A hashtag strip renders at the top of the reading surface and is the sole place where users add, remove, or view their tags; the settings form no longer contains any hashtag controls.
2. Each tag in the strip starts in an unselected state and can be toggled into a selected state by clicking it. In the selected state the tag inverts its colour scheme (the opposite of the current theme, matching the primary-button contrast) and expands to reveal a red remove affordance attached to the right edge of the chip. Clicking the body of a selected tag returns it to the unselected state; clicking the red affordance deletes that tag from the user's selection. Any number of tags may be selected simultaneously.
3. An add affordance at the end of the strip expands inline into a single text input; submitting the input appends a new tag to the selection.
4. Every add or remove persists immediately via the dedicated tags write endpoint with no form submit required; the user's tag list updates visibly on success. Toggling selection never writes to the server — it only affects the client-side filter state.
5. Each hashtag must be 2–32 characters long, is normalised to lowercase with any leading `#` stripped, and may contain only characters in `[a-z0-9-]`; other characters are stripped server-side before storage.
6. At least one hashtag is required for a digest to generate, a maximum of 20 total hashtags is enforced server-side, and duplicates are collapsed before storage.
7. While one or more tags are selected, the reading surface filters its visible articles to those whose stored tag list intersects the selection. When every article is filtered out, the reading surface shows a short message naming the selected tags and inviting the user to deselect.
8. Brand-new accounts are seeded with a curated default hashtag list so the first digest has meaningful input before the user touches the strip. The settings page exposes a "Restore initial tags" action that replaces the current list with the same default seed, letting the user reset to a known good starting point at any time.

**Constraints:** None
**Priority:** P0
**Dependencies:** REQ-SET-001
**Verification:** Integration test
**Status:** Partial
**Notes:** AC 2 (toggle + inverted chip + red × affordance), AC 4 (client-only selection state, no server write on toggle), AC 7 (filter + empty-state message), and AC 8 (default-hashtag seed + restore action) ship in code but have no automated test. AC 1, 3, 5, and 6 remain verified by `tests/settings/api.test.ts`.

---

### REQ-SET-003: Scheduled digest time with timezone

**Intent:** Users pick the exact local time their daily digest is generated, so the email arrives at a predictable moment in their day.

**Applies To:** User

**Acceptance Criteria:**
1. The form includes a native `<input type="time">` time picker that captures an hour and minute.
2. The browser-detected IANA timezone is displayed next to the time and auto-syncs to the server whenever it differs from the stored value; there is no manual timezone picker in the UI.
3. Initial timezone is populated from the browser's resolved IANA zone on first load, saved to the user row, and re-synced on every subsequent visit if it changes (e.g., travel).
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

**Intent:** Users who have not yet chosen a scheduled digest time cannot navigate to the reading surface, preventing empty-state confusion. Hashtags are NOT part of the gate because they are edited on the reading surface itself — a user with no tags yet still reaches the digest page and is prompted there to add their first one.

**Applies To:** User

**Acceptance Criteria:**
1. Any authenticated request to a path other than the settings page and the authentication/settings APIs, made by a user whose scheduled-digest time is not yet set, is redirected to the first-run settings view.
2. Once the scheduled-digest time is set, visiting the first-run settings view redirects to the steady-state settings view.
3. The gate keys only on "scheduled time not yet set" — having no hashtags selected does NOT trip the gate, and a user whose first digest fails is not trapped.
4. While the gate is active, the global navigation hides entries that lead to gated routes so the user sees only the Settings destination and cannot tap into a dead-end redirect.

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
