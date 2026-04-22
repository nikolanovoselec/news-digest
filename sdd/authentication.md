# Authentication

GitHub OAuth as the only sign-in method. Stateless HMAC-SHA256 JWT sessions with revocation. CSRF defense via Origin check. Platform-level rate limiting on auth endpoints. Account deletion with cascade.

---

### REQ-AUTH-001: Sign in with GitHub

**Intent:** Users authenticate with their existing GitHub account so there is no password, no email verification flow, and no local credential store to secure.

**Applies To:** User

**Acceptance Criteria:**
1. The landing page shows a single "Sign in with GitHub" button when the user is not authenticated.
2. The button redirects to `github.com/login/oauth/authorize` with `scope=user:email` and a cryptographically random `state` cookie for CSRF defense.
3. GitHub returns the user to the app's OAuth callback; successful consent creates or looks up the user by GitHub numeric id.
4. If the GitHub account has no primary+verified email, sign-in fails with error code `no_verified_email` and the user is redirected to the landing page with a clear message.

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
2. `DELETE /api/auth/account` deletes the `users` row; foreign-key cascade removes every related `digests`, `articles`, and `pending_discoveries` row.
3. The session cookie is cleared and the user is redirected to the landing page with a one-time confirmation banner.
4. KV entries keyed by the user's id (if any) are deleted in the same handler.

**Constraints:** CON-AUTH-001
**Priority:** P1
**Dependencies:** REQ-AUTH-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-AUTH-006: Authentication endpoint rate limiting

**Intent:** Prevent abuse of the OAuth login and callback endpoints from a single source IP without adding application-layer counters.

**Applies To:** User

**Acceptance Criteria:**
1. `/api/auth/github/login` accepts no more than 10 requests per minute per source IP.
2. `/api/auth/github/callback` accepts no more than 10 requests per minute per source IP.
3. Rate limits are enforced by a Cloudflare WAF rule, not by application code.
4. Rejected requests receive an HTTP 429 response.

**Constraints:** CON-SEC-001
**Priority:** P1
**Dependencies:** REQ-AUTH-001
**Verification:** Manual check
**Status:** Planned
