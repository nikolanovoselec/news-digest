# Authentication

Federated sign-in via GitHub or Google — no passwords, no email verification flow, no local credential store. Each provider is independently configurable so a deployment can enable either or both; at least one must be configured for the app to function. Sessions are split into a 5-minute HMAC-SHA256 access JWT and a 30-day device-bound refresh token (rotated on every refresh, reuse-detected) so closing the tab for weeks does not log the user out. CSRF defense via Origin check. Account deletion with cascade.

---

### REQ-AUTH-001: Sign in with a federated identity provider

**Intent:** Users authenticate with an existing identity at one of the supported providers (GitHub, Google) so there is no password, no email verification flow, and no local credential store to secure. Each provider can be enabled or disabled per-deployment so a fork can ship with only the providers it has configured. Brand-new accounts are seeded with a curated default hashtag list so the first digest has meaningful input before the user touches the tag strip.

**Applies To:** User

**Acceptance Criteria:**
1. The landing page shows one button per provider that the deployment has configured — labelled "Sign in with GitHub", "Sign in with Google" — listed in alphabetical order. Providers without configured credentials are omitted entirely (no greyed-out buttons). When no provider is configured the page surfaces a clear "Sign-in is not configured for this deployment" message instead of dead buttons.
2. Each button starts a standard OAuth 2.0 / OIDC authorization-code flow with a cryptographically random `state` cookie for CSRF defense. The chosen provider is preserved across the round-trip (in the state cookie or path) so the callback can complete the right exchange.
3. The callback exchanges the authorization code for an identity assertion and extracts a stable provider-specific user identifier plus a verified email address. Successful consent creates or looks up a user keyed by `<provider>:<provider-user-id>` (with backward-compatibility — the GitHub provider keeps its existing bare-numeric user-id format so legacy accounts are unchanged).
4. If the chosen provider returns no verified email or otherwise refuses to release one, sign-in fails with error code `no_verified_email` and the user is redirected to the landing page with a clear message naming the affected provider.
5. New-account creation seeds the user's hashtag list with the 21-entry system default covering the project owner's actual reading topics across cloud platforms, AI/LLM, security, identity, and infrastructure. Every default tag is guaranteed to have at least one curated source so the first digest has meaningful input before the user touches the strip.
6. New accounts are also seeded with a default scheduled-digest time of 08:00, a default UTC timezone that the reading surface overwrites with the browser's actual IANA zone on first load, and the email-notification preference enabled. As a result, successful sign-in for a brand-new account lands the user directly on the reading surface with real articles visible — there is no forced onboarding detour through the settings form.
7. Cross-provider sign-in by the same verified email lands in a single account per REQ-AUTH-007 (was previously per-provider isolation).
8. Operator endpoints under `/api/admin/*` enforce three independent layers before any side effect:
   a. The request carries a valid Cloudflare Access assertion (and, when an Access audience tag is configured, validates against it). When the audience tag is NOT configured but a Cloudflare-Access-shaped header is presented, the request is still evaluated against the remaining layers AND a structured operational warning is logged so the operator can detect the unbound-perimeter misconfiguration via tail/Logpush.
   b. The requester holds a live Worker session cookie.
   c. The session user is the configured operator (email match, case-insensitive).
   A request that fails any layer is rejected at the first failing layer with no observable side effect on the application.
9. Application-layer rate limits protect authentication and mutation endpoints:
   a. Every `/api/auth/*` route, every authenticated mutation route, and every authenticated endpoint that legitimate clients poll on a sub-minute cadence is rate-limited.
   b. Unauthenticated paths key the limit by IP; authenticated mutation paths key it by user id.
   c. An exhausted limit returns HTTP 429 with a `Retry-After` header.
   d. Sign-in and OAuth-callback rules fail open on a backing-store outage so a transient outage cannot lock users out of sign-in.
   e. Refresh-token rules fail closed on a backing-store outage so a stolen refresh cookie cannot benefit from the outage to bypass the limit.
   f. The refresh-rate-limit bucket gates both the explicit refresh endpoint and the inline middleware refresh path so an attacker cannot pivot to authenticated GET routes to bypass it.

**Constraints:** CON-AUTH-001
**Priority:** P0
**Dependencies:** None
**Verification:** Integration test
**Status:** Implemented

---

### REQ-AUTH-002: Access token + refresh token, instant revocation

**Intent:** Keep users signed in for an extended period — at least 30 days of inactivity — without requiring them to re-authenticate, while allowing instant invalidation of every outstanding session on logout or account deletion. Sessions feel like every consumer-grade webapp: closing the tab and coming back next month does not log the user out.

**Applies To:** User

**Acceptance Criteria:**
1. Two cookies make up an authenticated session: a short-lived **access cookie** (HMAC-SHA256 JWT, 5-minute TTL, `__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`) and a long-lived **refresh cookie** (opaque random 32-byte value, 30-day TTL, same cookie attributes). Both are issued at OAuth completion.
2. Every authenticated request first verifies the access JWT, including its `session_version` claim against the current row's `session_version`. Mismatched or expired access JWTs are rejected even if still cryptographically valid; the request then falls through to the refresh-token flow.
3. Logout increments the user's `session_version` (immediately invalidating every access JWT previously issued to that user) and revokes the active refresh-token row (immediately invalidating the long-lived cookie). Both cookies are cleared on the response.
4. When the access JWT is missing or expired but the refresh cookie is valid, middleware mints a new access JWT and rotates the refresh-token row inline on the same request. Both API routes and Astro page routes attach the re-issued cookies so plain navigation extends the session, not just XHR API calls. The user never sees a login prompt as a result of access-token expiry alone.
5. An explicit refresh endpoint is provided for the case where a long-running tab needs a fresh access JWT before issuing a state-changing request that middleware cannot safely auto-refresh on the same call. The endpoint always force-rotates the refresh-token row when invoked with a valid refresh cookie — calling it does not depend on whether the access JWT is still live, and it returns a new access JWT plus rotated refresh cookie regardless of remaining lifetime. On a successful concurrent-rotation collision (the same client's parallel call won the race), the endpoint returns a fresh access JWT without re-rotating, per the grace-window tolerance in REQ-AUTH-008 AC 4. On any failure path, both the access and refresh cookies are cleared on the response so a half-cleared session cannot persist.

**Constraints:** CON-AUTH-001, CON-SEC-001
**Priority:** P0
**Dependencies:** REQ-AUTH-001, REQ-AUTH-008
**Verification:** Automated test
**Status:** Implemented

---

### REQ-AUTH-003: CSRF defense for state-changing endpoints

**Intent:** Prevent cross-site requests from triggering actions on behalf of authenticated users, without relying on XSS-bypassable double-submit token schemes.

**Applies To:** User

**Acceptance Criteria:**
1. Every `POST`, `PUT`, `PATCH`, and `DELETE` endpoint that acts on an authenticated session rejects requests whose `Origin` header is missing or does not equal the app's canonical origin.
2. Rejection returns HTTP 403 with JSON body `{ error, code: "forbidden_origin" }`.
3. GET endpoints are not subject to this check (the session cookie's `SameSite=Lax` handles cross-origin GETs).
4. OAuth flow entry points that only initiate a redirect to the identity provider and do not mutate authenticated state are exempt from the Origin check. The only effect of such an endpoint is setting a short-lived opaque state cookie and returning a 303 redirect; any actual authentication requires the user to consent at the identity provider. Login-CSRF is mitigated by the identity provider's own consent screen.

**Constraints:** CON-SEC-001
**Priority:** P0
**Dependencies:** REQ-AUTH-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-AUTH-004: OAuth error surfacing

**Intent:** Common OAuth failures from any configured provider lead to clear user-visible messages without leaking internal details to the browser.

**Applies To:** User

**Acceptance Criteria:**
1. `access_denied` from the identity provider returns the user to the landing page with `?error=access_denied` and a human-readable message.
2. Missing or unverified email from the identity provider returns `?error=no_verified_email` with instructions to add a verified primary email at the provider and retry.
3. CSRF state mismatch returns HTTP 403 with `?error=invalid_state`.
4. Any other provider error returns `?error=oauth_error`; full detail is logged server-side but never surfaced to the browser.

**Constraints:** CON-SEC-001
**Priority:** P0
**Dependencies:** REQ-AUTH-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-AUTH-005: Account deletion

**Intent:** Users can permanently delete their account and all associated data in one step.

**Applies To:** User

**Acceptance Criteria:**
1. `/settings` has a "Delete account" control with a confirmation dialog requiring the user to type an explicit confirmation string.
2. Submitting the confirmed deletion deletes the user and every row owned by the user (stars, read-tracking, pending discoveries) via foreign-key cascade. The shared article pool is unaffected — articles are global, not per-user. The account-deletion endpoint accepts both a JSON API path (used by scripted clients and smoke tests) and a native HTML form submission (used by the settings page) so deletion succeeds on every browser the app supports, including mobile in-app webviews that do not reliably dispatch fetch-based `DELETE` requests.
3. The session cookie is cleared and the user is redirected to the landing page with a one-time confirmation banner.
4. KV entries keyed by the user's id (if any) are deleted in the same handler.

**Constraints:** CON-AUTH-001
**Priority:** P1
**Dependencies:** REQ-AUTH-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-AUTH-007: Cross-provider account dedup

**Intent:** A person who signs in via two providers with the same verified email lands in one account, not two — the daily digest goes out once and starred articles, read marks, and interests are shared across both sign-in paths.

**Applies To:** User

**Acceptance Criteria:**
1. The first time a user signs in via any provider, a new account is created and the (provider, provider identifier) pair is recorded so subsequent sign-ins via the same provider land in the same account.
2. When a sign-in arrives via a provider not yet linked to any account but with a verified email that matches an existing account, the new (provider, identifier) pair is linked to that existing account instead of creating a duplicate row. The user signs in to the same account regardless of which provider they pick.
3. The daily digest is sent once per real person — duplicate-email accounts that pre-date this requirement are merged in a single one-time pass; their stars, read marks, and pending discoveries re-point to the surviving account so no user-visible state is lost.
4. Removing one sign-in path (revoking access at the OAuth provider) does not delete the account or other linked sign-in paths — the account remains reachable via the other provider.

**Constraints:** CON-AUTH-001
**Priority:** P1
**Dependencies:** REQ-AUTH-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-AUTH-008: Refresh-token rotation, device binding, reuse detection

**Intent:** The 30-day refresh cookie is a high-value secret — anyone holding it can mint access tokens for the user. Bind it to the device that signed in, rotate it on every refresh so a stolen value is single-use, and detect reuse so a stolen-then-rotated token surfaces as theft rather than continuing to work alongside the legitimate session.

**Applies To:** User

**Acceptance Criteria:**
1. **Device fingerprint capture and policy:**
   a. Every refresh-token row records a User-Agent + country fingerprint at issuance as forensic metadata.
   b. On the steady-state refresh path, a different fingerprint is logged but does not block the refresh — single-use rotation (AC 2), reuse detection (AC 4), and the 30-day absolute expiry are the binding mechanisms that protect the session.
   c. On the 30-second concurrent-rotation grace branch (AC 4) the fingerprint check IS enforced: a mismatch inside the grace window is treated as theft and triggers a full session revoke.
2. Every successful refresh **rotates** the refresh-token row: the existing row is marked revoked with the current timestamp, a new row is inserted with `parent_id` linking back to the old row, and a new opaque cookie value is issued. The old cookie value is single-use — presenting it a second time is treated as reuse per AC 4. The persisted row is identified by an internal random row identifier that is independent of the cookie secret, so a leaked database dump cannot be replayed against the live system.
3. Logout revokes only the active refresh-token row, not every refresh-token row for the user. Logging out on one device does not sign the user out of other devices they are intentionally still using.
4. **Reuse detection with concurrent-rotation tolerance** — if a refresh cookie whose row already has `revoked_at` set is presented, the system applies a short grace window (30 seconds from revocation) before deciding the request is theft. Within the grace window, the presentation is treated as a benign concurrent-rotation collision (two parallel requests from the same client both raced to refresh, the loser is replaying the cookie that was rotated under it); a fresh access JWT is served off the surviving rotated row without rotating again, and the client's stale cookie is good for the rest of the window. Outside the grace window, the system cannot distinguish "rightful owner replaying an old cookie" from "attacker using a stolen-then-rotated cookie" and treats it as theft: every refresh-token row for the affected user is revoked AND `users.session_version` is incremented (which kills every in-flight access JWT), forcing the user through OAuth on every device.
5. Expired and old-revoked refresh-token rows are pruned by the daily retention sweep. Revoked rows are kept for at least 7 days after revocation so the reuse-detection branch above can see the `revoked_at` timestamp before the row is deleted.

**Constraints:** CON-AUTH-001, CON-SEC-001
**Priority:** P0
**Dependencies:** REQ-AUTH-002
**Verification:** Automated test
**Status:** Implemented
