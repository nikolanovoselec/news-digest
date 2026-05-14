# Onboarding & Settings

A single `/settings` route handles both first-run onboarding and steady-state configuration. Covers hashtag curation, schedule (HH:MM + IANA timezone), model selection, email notification toggle, and the middleware gate that keeps un-configured users on the settings page.

---

### REQ-SET-001: Unified first-run and edit flow

**Intent:** A new user configures their first digest in one place without a multi-step wizard, and the same form handles every subsequent edit. The save endpoint's transport contract and native-form UX live in [REQ-SET-009](#req-set-009-save-endpoint-transports-and-native-form-ux).

**Applies To:** User

**Acceptance Criteria:**
1. Users landing without `hashtags_json` or `digest_hour` set are redirected to `/settings?first_run=1`.
2. First-run mode shows a "Welcome" hero and the primary button reads "Generate my first digest".
3. Edit mode (after configuration is complete) shows the same form with the primary button reading "Save" and additional controls for logout, account deletion, and the install-app prompt.
4. A successful first-run save redirects the user to `/digest`, where the shared article pool is already populated so real cards render immediately.
5. The first-run save also kicks the global scrape pipeline as a best-effort nudge so any tags newly added during onboarding can begin discovery on the next cron tick.

**Constraints:** None

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider), [REQ-SET-009](#req-set-009-save-endpoint-transports-and-native-form-ux)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-SET-009: Save endpoint transports and native-form UX

**Intent:** The settings save endpoint persists configuration whether the in-page JavaScript handler is bound or not, and the native-form path always returns the user to the settings page with a readable outcome inline rather than a raw JSON body or a stuck stale URL.

**Applies To:** User

**Acceptance Criteria:**
1. The save endpoint accepts both a JSON API request (used when the in-page submit handler is bound) and a native HTML form submission, so clicking the primary button always persists regardless of whether client-side JavaScript has initialised.
2. Both transports apply identical server-side validation and the same `Origin` check from [REQ-AUTH-003](authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints).
3. On the native-form path, the response is always a redirect back to the settings page on both success and failure, so the user never sees a raw JSON error body.
4. After the redirect, a successful save surfaces a confirmation inline next to the Save button; a validation or server error surfaces an inline message naming what went wrong.
5. Query parameters carrying the outcome are stripped from the URL after display so a refresh does not re-show stale text.
6. Unauthenticated native-form POSTs redirect to the site root rather than persisting state or showing an error message.

**Constraints:** None

**Priority:** P0

**Dependencies:** [REQ-SET-001](#req-set-001-unified-first-run-and-edit-flow), [REQ-AUTH-003](authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-SET-002: Hashtag curation strip UX

**Intent:** Users curate their interest tags directly on the reading surface using a hashtag strip that supports add, toggle, remove, and live article filtering, rather than juggling a separate settings form.

**Applies To:** User

**Acceptance Criteria:**
1. A hashtag strip renders at the top of the reading surface and is the sole place where users add, remove, or view their tags; the settings form contains no hashtag controls.
2. Each tag in the strip starts in an unselected state and toggles to a selected state when clicked; any number of tags may be selected simultaneously.
3. In the selected state, the tag visually inverts to indicate selection and expands to reveal a red remove affordance attached to its right edge.
4. Clicking the body of a selected tag returns it to the unselected state.
5. Clicking the red remove affordance deletes that tag from the user's selection.
6. An add affordance at the end of the strip expands inline into a single text input; submitting the input appends a new tag to the selection.
7. While one or more tags are selected, the reading surface filters its visible articles to those whose stored tag list intersects the selection. When every article is filtered out, the reading surface shows a short message naming the selected tags and inviting the user to deselect.

**Constraints:** None

**Priority:** P0

**Dependencies:** [REQ-SET-001](#req-set-001-unified-first-run-and-edit-flow), [REQ-SET-008](#req-set-008-hashtag-persistence-validation-and-defaults)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-SET-008: Hashtag persistence, validation, and defaults

**Intent:** Tag changes persist immediately, hashtag values follow a normalised format, the list is bounded by an enforced cap, and new accounts start with a curated seed so the first digest is meaningful before the user has touched the strip.

**Applies To:** User

**Acceptance Criteria:**
1. Every add or remove persists immediately via the dedicated tags write endpoint with no form submit required; the user's tag list updates visibly on success. Toggling selection never writes to the server; it only affects the client-side filter state.
2. Each hashtag must be 2 to 32 characters long, is normalised to lowercase with any leading `#` stripped, and may contain only characters in `[a-z0-9-]`; other characters are stripped server-side before storage.
3. At least one hashtag is required for a digest to generate, a maximum of 25 total hashtags is enforced server-side, and duplicates are collapsed before storage. The cap sits 4 slots above the 21-tag default seed so a new account can immediately add custom interests without having to delete a default first.
4. Brand-new accounts are seeded with a curated default hashtag list so the first digest has meaningful input before the user touches the strip.
5. The settings page exposes two paired actions side-by-side: "Restore initial tags" replaces the current list with the full default seed; "Delete all tags" clears the user's tag list entirely so they can build a completely custom set without removing default chips one-by-one.
6. Each paired action is only visible when it would do something useful: Restore appears when at least one default is missing from the user's list, Delete appears whenever the user has at least one tag, so an empty list hides Delete and a list identical to the initials hides Restore.

**Constraints:** None

**Priority:** P0

**Dependencies:** [REQ-SET-001](#req-set-001-unified-first-run-and-edit-flow)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-SET-003: Scheduled digest time with timezone

**Intent:** Users pick the exact local time their daily digest is generated, so the email arrives at a predictable moment in their day.

**Applies To:** User

**Acceptance Criteria:**
1. The digest time is captured via two dropdowns whose label format matches the user's preferred clock convention as reported by the browser: 12-hour AM/PM labels for 12-hour locales (en-US, en-CA, en-AU), 24-hour labels (00 to 23) for 24-hour locales (en-GB, hr-HR, ja-JP), auto-detected at render time without country-by-country hardcoding.
2. Selectable digest-time values follow a 5-minute step (00:00, 00:05, ..., 23:55) so the picker matches the dispatcher's 5-minute cron tick.
3. The browser-detected IANA timezone is displayed next to the time and auto-syncs to the server whenever it differs from the stored value; there is no manual timezone picker in the UI.
4. Initial timezone is populated from the browser's resolved IANA zone on first load, saved to the user row, and re-synced on every subsequent visit if it changes (e.g., travel).
5. The saved time is interpreted in the user's stored timezone; DST transitions are handled correctly using `Intl.DateTimeFormat`.
6. Changing the scheduled time never creates a duplicate digest for a day that has already generated.

**Constraints:** None

**Priority:** P0

**Dependencies:** [REQ-SET-002](#req-set-002-hashtag-curation-strip-ux)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-SET-004: Model selection

**Intent:** Users pick the Workers AI model that writes their summaries, trading cost against quality visibly.

**Applies To:** User

**Acceptance Criteria:**
1. The model dropdown lists the same model options that other config surfaces accept, grouped under "Featured" and "Budget" section headers.
2. Each option shows a short description and an estimated per-digest cost computed from the model's per-million-token prices.
3. The dropdown pre-selects the system default model.
4. On save, the server rejects any model identifier not in the accepted list with HTTP 400 and error code `invalid_model_id`.
5. The model dropdown lives inside an "Advanced" collapsible section, collapsed by default.

**Constraints:** [CON-LLM-001](constraints.md#con-llm-001-centralized-deterministic-prompts)

**Priority:** P1

**Dependencies:** [REQ-SET-003](#req-set-003-scheduled-digest-time-with-timezone)

**Verification:** Integration test

**Status:** Partial

**Notes:** The model-selection UI is hidden from the settings form, but the settings API still accepts and persists a `model_id` field. True removal requires retiring `model_id` from the persistence contract first.

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

**Dependencies:** [REQ-SET-001](#req-set-001-unified-first-run-and-edit-flow)

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
5. The discovery-progress endpoint that the settings page polls while pending discoveries drain is rate-limited per authenticated user, sized to leave a few-seconds polling cadence untouched while bounding pathological client loops, per REQ-AUTH-001 AC 9a. An exhausted limit returns HTTP 429 with `Retry-After`; the settings page surfaces the polling pause without blocking the rest of the form.

**Constraints:** None

**Priority:** P0

**Dependencies:** [REQ-SET-001](#req-set-001-unified-first-run-and-edit-flow), [REQ-AUTH-002](authentication.md#req-auth-002-access-token-refresh-token-instant-revocation)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-SET-007: Timezone change detection

**Intent:** When a user's browser timezone differs from the stored value (e.g., they traveled, or they signed up on a device whose timezone was never set), the server-stored timezone is corrected automatically so downstream behaviour (scheduled-email dispatch, today-local date deep-links) always matches the user's real location. The manual override picker lives in [REQ-SET-010](#req-set-010-manual-timezone-picker).

**Applies To:** User

**Acceptance Criteria:**
1. On every authenticated page load *for users whose stored timezone is still the seeded default*, the browser's resolved IANA timezone is compared to the stored timezone value for the session user.
2. When the two differ, the browser silently posts the new timezone to the timezone-update endpoint and the server persists it; no confirmation banner or dialog is shown.
3. The correction runs on every route (not just the settings page), so users who sign up and go straight to the reading surface never miss the update.
4. A failed correction request is non-fatal: the page continues to render and the next page load retries.
5. Once the stored timezone is anything other than the seeded default — set either by an earlier silent correction or by the manual settings picker — the silent path stops touching it, so a user's deliberate choice is never overwritten by a privacy-masked or stale browser timezone on the next page load.
6. The timezone-update endpoint is rate-limited per authenticated user per [REQ-AUTH-001](authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9a; an exhausted limit returns HTTP 429 with `Retry-After` and is non-fatal per AC 4 above.

**Constraints:** None

**Priority:** P2

**Dependencies:** [REQ-SET-003](#req-set-003-scheduled-digest-time-with-timezone), [REQ-SET-010](#req-set-010-manual-timezone-picker)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-SET-010: Manual timezone picker

**Intent:** Even when the silent auto-sync ([REQ-SET-007](#req-set-007-timezone-change-detection)) has been disabled by a prior explicit choice or has failed, the user can pick any valid IANA timezone from the settings page directly.

**Applies To:** User

**Acceptance Criteria:**
1. The settings page exposes a manual timezone picker that lets the user select any valid IANA zone explicitly.
2. The picker is pre-populated with the browser-detected zone, or with the stored zone when the browser's value is unavailable, so the most likely correct value is one click away even when the silent auto-sync has failed.
3. Saving the form persists the picked zone via the same timezone-update endpoint used by the silent auto-sync path.

**Constraints:** None

**Priority:** P2

**Dependencies:** [REQ-SET-007](#req-set-007-timezone-change-detection)

**Verification:** Integration test

**Status:** Implemented
