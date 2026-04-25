# Authentication

Federated sign-in via GitHub or Google — no passwords, no email verification flow, no local credential store. Each provider is independently configurable so a deployment can enable either or both; at least one must be configured for the app to function. Stateless HMAC-SHA256 JWT sessions with revocation. CSRF defense via Origin check. Platform-level rate limiting on auth endpoints. Account deletion with cascade.

---

### REQ-AUTH-001: Sign in with a federated identity provider

**Intent:** Users authenticate with an existing identity at one of the supported providers (GitHub, Google) so there is no password, no email verification flow, and no local credential store to secure. Each provider can be enabled or disabled per-deployment so a fork can ship with only the providers it has configured. Brand-new accounts are seeded with a curated default hashtag list so the first digest has meaningful input before the user touches the tag strip.

**Applies To:** User

**Acceptance Criteria:**
1. The landing page shows one button per provider that the deployment has configured — labelled "Sign in with GitHub", "Sign in with Google" — listed in alphabetical order. Providers without configured credentials are omitted entirely (no greyed-out buttons). When no provider is configured the page surfaces a clear "Sign-in is not configured for this deployment" message instead of dead buttons.
2. Each button starts a standard OAuth 2.0 / OIDC authorization-code flow with a cryptographically random `state` cookie for CSRF defense. The chosen provider is preserved across the round-trip (in the state cookie or path) so the callback can complete the right exchange.
3. The callback exchanges the authorization code for an identity assertion and extracts a stable provider-specific user identifier plus a verified email address. Successful consent creates or looks up a user keyed by `<provider>:<provider-user-id>` (with backward-compatibility — the GitHub provider keeps its existing bare-numeric user-id format so legacy accounts are unchanged).
4. If the chosen provider returns no verified email or otherwise refuses to release one, sign-in fails with error code `no_verified_email` and the user is redirected to the landing page with a clear message naming the affected provider.
5. New-account creation seeds the user's hashtag list with the 20-entry system default: cloudflare, ai, mcp, agenticai, genai, aws, cloud, serverless, workers, azure, zero-trust, microsegmentation, kubernetes, terraform, devsecops, observability, rust, python, postgres, threat-intel.
6. New accounts are also seeded with a default scheduled-digest time of 08:00, a default UTC timezone that the reading surface overwrites with the browser's actual IANA zone on first load, and the email-notification preference enabled. As a result, successful sign-in for a brand-new account lands the user directly on the reading surface with real articles visible — there is no forced onboarding detour through the settings form.
7. Each provider's account is independent — signing in with Google after a previous GitHub sign-in creates a fresh account rather than merging by email. This is a deliberate trade-off: it eliminates the cross-provider email-conflict ambiguity at the cost of forcing users to remember which provider they used.

**Constraints:** CON-AUTH-001
**Priority:** P0
**Dependencies:** None
**Verification:** Integration test
**Status:** Implemented

---

### REQ-AUTH-002: Session cookie and instant revocation

**Intent:** Keep users signed in between visits without requiring them to re-authenticate, while allowing instant invalidation of every outstanding session on logout or account deletion.

**Applies To:** User

**Acceptance Criteria:**
1. The session is a stateless HMAC-SHA256 JWT stored in an `__Host-` prefixed cookie with `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and a 1-hour TTL.
2. The JWT includes a `session_version` claim that matches the user's current `session_version` integer; mismatched JWTs are rejected even if still cryptographically valid.
3. Logout increments the user's `session_version`, immediately invalidating every JWT previously issued to that user.
4. A response middleware auto-refreshes the JWT on any request where less than 15 minutes remain on the current token.

**Constraints:** CON-AUTH-001, CON-SEC-001
**Priority:** P0
**Dependencies:** REQ-AUTH-001
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

**Intent:** Common OAuth failures lead to clear user-visible messages without leaking internal details to the browser.

**Applies To:** User

**Acceptance Criteria:**
1. `access_denied` from GitHub returns the user to the landing page with `?error=access_denied` and a human-readable message.
2. Missing primary+verified email returns `?error=no_verified_email` with instructions to add one in GitHub and retry.
3. CSRF state mismatch returns HTTP 403 with `?error=invalid_state`.
4. Any other GitHub error returns `?error=oauth_error`; full detail is logged server-side but never surfaced to the browser.

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
2. Submitting the confirmed deletion deletes the user and every row owned by the user (digests, articles, stars, read-tracking, pending discoveries) via foreign-key cascade. The account-deletion endpoint accepts both a JSON API path (used by scripted clients and smoke tests) and a native HTML form submission (used by the settings page) so deletion succeeds on every browser the app supports, including mobile in-app webviews that do not reliably dispatch fetch-based `DELETE` requests.
3. The session cookie is cleared and the user is redirected to the landing page with a one-time confirmation banner.
4. KV entries keyed by the user's id (if any) are deleted in the same handler.

**Constraints:** CON-AUTH-001
**Priority:** P1
**Dependencies:** REQ-AUTH-001
**Verification:** Integration test
**Status:** Implemented
