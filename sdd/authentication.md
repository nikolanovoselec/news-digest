# Authentication

Federated sign-in via GitHub or Google. No passwords, no email-verification flow, no local credential store. Sessions split into a short-lived access cookie and a long-lived rotated refresh cookie so closing the tab for weeks does not log the user out. CSRF defense via Origin check. Account deletion with cascade.

Mechanism detail (cookie attributes, rate-limit matrix, admin layered defense, JWKS verification, dev-bypass gating) lives in [`documentation/security.md`](../documentation/security.md). Cross-cutting rate-limit policy that the auth surface inherits lives in [`sdd/rate-limits.md`](rate-limits.md).

---

### REQ-AUTH-001: Sign in with a federated identity provider

**Intent:** Users authenticate with an existing identity at a supported provider (GitHub, Google) so the deployment never holds a password. Each provider is independently enable-able so a fork can ship with only what it has configured. A new account is usable immediately, with seeded interests and defaults so the first digest has meaningful input.

**Applies To:** User

**Acceptance Criteria:**

1. The landing page shows one button per configured provider, labelled "Sign in with {provider}", in alphabetical order. Unconfigured providers are omitted entirely. When zero providers are configured, the page shows a clear "Sign-in is not configured for this deployment" message instead of dead buttons.
2. Each button starts a standard OAuth 2.0 / OIDC authorization-code flow with cryptographic CSRF state defense. The chosen provider is preserved across the round-trip so the callback completes the correct exchange.
3. The callback exchanges the authorization code for a verified identity and creates or looks up a user keyed by provider plus provider-user-id. The GitHub provider preserves its legacy bare-numeric key format so existing accounts are unchanged.
4. If the provider returns no verified email, sign-in fails with error code `no_verified_email` and the user is redirected to the landing page with a clear message naming the affected provider.
5. A brand-new account is seeded with a curated default hashtag list (covering cloud platforms, AI/LLM, security, identity, and infrastructure) where every default tag has at least one curated source, so the first digest has meaningful input before the user touches the strip.
6. A brand-new account is also seeded with a default scheduled-digest time of 08:00, a default UTC timezone (overwritten by the browser's IANA zone on first load), and email-notification enabled. Successful first sign-in lands the user directly on the reading surface with real articles visible — no forced onboarding detour.

**Constraints:** [CON-AUTH-001](constraints.md#con-auth-001-custom-federated-oauthoidc-hmac-sha256-jwt)

**Priority:** P0

**Dependencies:** None

**Verification:** Integration test

**Status:** Implemented

---

### REQ-AUTH-002: Access token + refresh token, instant revocation

**Intent:** Users stay signed in for at least 30 days of inactivity without re-authenticating, while logout or account deletion invalidates every outstanding session instantly. Sessions feel like every consumer-grade webapp — closing the tab and coming back next month does not log the user out.

**Applies To:** User

**Acceptance Criteria:**

1. An authenticated session is carried by two cookies issued at OAuth completion: a short-lived access cookie unreadable by page JavaScript, and a long-lived refresh cookie with the same protection.
2. Every authenticated request first verifies the access cookie against a per-user session-version stamp. Mismatched or expired access cookies fall through to the refresh-token flow.
3. Logout immediately invalidates every access cookie previously issued to the user and revokes the active refresh-token row. Both cookies are cleared on the response.
4. When the access cookie is missing or expired but the refresh cookie is valid, middleware mints a new access cookie and rotates the refresh-token row inline on the same request. Both API routes and page navigations attach the re-issued cookies, so plain navigation extends the session — the user never sees a login prompt from access-token expiry alone.
5. An explicit refresh endpoint force-rotates the refresh-token row regardless of remaining access-cookie lifetime, tolerates a concurrent-rotation race per [REQ-AUTH-008](#req-auth-008-refresh-token-rotation-device-binding-reuse-detection), and clears both cookies on any failure path so a half-cleared session cannot persist.

**Notes:** Cookie attribute set (`__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`) and the signing algorithm are documented in [`documentation/security.md`](../documentation/security.md#auth-cookie-policy-req-auth-002--req-auth-008).

**Constraints:** [CON-AUTH-001](constraints.md#con-auth-001-custom-federated-oauthoidc-hmac-sha256-jwt), [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-sign-in-with-a-federated-identity-provider), [REQ-AUTH-008](#req-auth-008-refresh-token-rotation-device-binding-reuse-detection)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AUTH-003: CSRF defense for state-changing endpoints

**Intent:** Prevent cross-site requests from triggering actions on behalf of authenticated users, without relying on XSS-bypassable double-submit token schemes.

**Applies To:** User

**Acceptance Criteria:**

1. Every state-changing endpoint (`POST`, `PUT`, `PATCH`, `DELETE`) that acts on an authenticated session rejects requests whose `Origin` header is missing or does not match the app's canonical origin. Rejection returns `HTTP 403` with error code `forbidden_origin`.
2. Non-admin `GET` endpoints are exempt from the Origin check because the browser will not attach the session cookie to a cross-site GET. Admin `GET` endpoints narrow this exemption per [REQ-AUTH-006](#req-auth-006-admin-surface-gating). Cookie attribute mechanism that delivers this guarantee is documented in [`documentation/security.md`](../documentation/security.md#auth-cookie-policy-req-auth-002-req-auth-008).
3. OAuth-flow entry points that only initiate a redirect to the identity provider are exempt — their only effect is setting a short-lived state cookie and redirecting, and actual authentication requires consent at the provider.

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-sign-in-with-a-federated-identity-provider)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-AUTH-004: OAuth error surfacing

**Intent:** Common OAuth failures from any configured provider produce clear user-visible messages without leaking internal details to the browser.

**Applies To:** User

**Acceptance Criteria:**

1. `access_denied` from the provider returns the user to the landing page with `?error=access_denied` and a human-readable message.
2. Missing or unverified email returns `?error=no_verified_email` with instructions to add a verified primary email at the provider and retry.
3. CSRF state mismatch returns `HTTP 403` with `?error=invalid_state`.
4. Any other provider error returns `?error=oauth_error`; full detail is logged server-side but never surfaced to the browser.

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-sign-in-with-a-federated-identity-provider)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-AUTH-005: Account deletion

**Intent:** Users can permanently delete their account and all associated data in one step.

**Applies To:** User

**Acceptance Criteria:**

1. The settings surface offers a "Delete account" control with a confirmation dialog that requires the user to type an explicit confirmation string.
2. Confirmed deletion removes the user and every row owned by the user (stars, read-tracking, pending discoveries) via foreign-key cascade. The shared article pool is unaffected.
3. The deletion endpoint accepts both a JSON API path (used by scripted clients) and a native HTML form submission (used by the settings page), so deletion succeeds even on mobile in-app webviews that do not reliably dispatch fetch-based `DELETE`.
4. Both session cookies are cleared and the user is redirected to the landing page with a one-time confirmation banner.
5. Any KV entries keyed by the user's id are deleted in the same handler.

**Constraints:** [CON-AUTH-001](constraints.md#con-auth-001-custom-federated-oauthoidc-hmac-sha256-jwt)

**Priority:** P1

**Dependencies:** [REQ-AUTH-001](#req-auth-001-sign-in-with-a-federated-identity-provider)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-AUTH-006: Admin surface gating

**Intent:** Operator endpoints under `/api/admin/*` are reachable only by the configured operator, even when an attacker controls a same-browser context with a live non-operator session, and the most destructive mode is reachable only via an explicit operator action.

**Applies To:** Admin

**Acceptance Criteria:**

1. A request to any admin endpoint with no live session, or with a session belonging to a non-operator user, is rejected before any side effect. Deployments configured with an external perimeter layer additionally require that perimeter's assertion before the application gate runs.
2. The destructive pipeline mode that wipes and re-embeds the entire corpus is reachable only via an explicit `POST`. The same parameter via `GET` is rejected, so cross-origin GET vectors (image tags, bookmarks, link previews) can never trigger a corpus-wide re-embed. Idempotent modes remain reachable via either method.
3. Admin `GET` endpoints reject requests originating from a cross-site context while continuing to accept top-level navigation (operator bookmarks, post-SSO callback redirects). This closes the residual same-browser-CSRF gap that [REQ-AUTH-003](#req-auth-003-csrf-defense-for-state-changing-endpoints) AC 2's blanket GET exemption leaves open for idempotent admin actions.

**Notes:** Layered-defense mechanism is documented in [`documentation/security.md`](../documentation/security.md#admin-gate-and-jwt-exp-validation-req-auth-001-ac-8-ac-8a--ad44).

**Constraints:** [CON-AUTH-001](constraints.md#con-auth-001-custom-federated-oauthoidc-hmac-sha256-jwt), [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-sign-in-with-a-federated-identity-provider), [REQ-AUTH-003](#req-auth-003-csrf-defense-for-state-changing-endpoints)

**Verification:** Integration test

**Status:** Partial

---

### REQ-AUTH-007: Cross-provider account dedup

**Intent:** A person who signs in via two providers with the same verified email lands in one account, not two — the daily digest goes out once and starred articles, read marks, and interests are shared across both sign-in paths.

**Applies To:** User

**Acceptance Criteria:**

1. The first sign-in via any provider creates an account and records the (provider, provider-id) pair so subsequent sign-ins via the same provider land in the same account.
2. A sign-in via a provider not yet linked to any account, but with a verified email matching an existing account, links the new (provider, provider-id) pair to that account instead of creating a duplicate row.
3. The daily digest is sent once per real person. Duplicate-email accounts that pre-date this requirement are merged in a one-time pass; their stars, read marks, and pending discoveries re-point to the surviving account so no user-visible state is lost.
4. Removing one sign-in path at the OAuth provider does not delete the account or other linked sign-in paths — the account remains reachable via the other provider.

**Constraints:** [CON-AUTH-001](constraints.md#con-auth-001-custom-federated-oauthoidc-hmac-sha256-jwt)

**Priority:** P1

**Dependencies:** [REQ-AUTH-001](#req-auth-001-sign-in-with-a-federated-identity-provider)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-AUTH-008: Refresh-token rotation, device binding, reuse detection

**Intent:** The long-lived refresh cookie is a high-value secret — anyone holding it can mint access tokens for the user. Rotate it on every refresh so a stolen value is single-use, detect reuse so a stolen-then-rotated token surfaces as theft rather than continuing to work alongside the legitimate session, and tolerate concurrent-rotation races so legitimate parallel clients are not falsely flagged.

**Applies To:** User

**Acceptance Criteria:**

1. Every successful refresh rotates the refresh-token row: the existing row is revoked, a new row is issued, and the old cookie value is single-use. The persisted row identifier is independent of the cookie secret, so a leaked database dump cannot be replayed against the live system.
2. Logout revokes only the active refresh-token row, not every row for the user. Logging out on one device does not sign the user out of other devices.
3. Presenting an already-revoked refresh cookie within a brief concurrent-rotation grace window is treated as a benign race: a fresh access token is served off the surviving rotated row without rotating again, and the client's stale cookie remains valid for the rest of the window.
4. Presenting an already-revoked refresh cookie outside the grace window is treated as theft: every refresh-token row for the user is revoked and the per-user session-version is incremented, forcing the user through OAuth on every device.
5. Each refresh-token row records the User-Agent and country at issuance as forensic metadata. The steady-state refresh path logs but does not block on a fingerprint change. A fingerprint mismatch within the grace window IS enforced, because the only legitimate cause of a grace-window replay is the same client racing itself.
6. Expired and old-revoked rows are pruned by the daily retention sweep, with a retention floor long enough for the reuse-detection branch to still see `revoked_at` on a stolen-then-rotated cookie.

**Notes:** Grace-window length, retention floor, and the parent-link pointer are documented in [`documentation/security.md`](../documentation/security.md#auth-cookie-policy-req-auth-002--req-auth-008).

**Constraints:** [CON-AUTH-001](constraints.md#con-auth-001-custom-federated-oauthoidc-hmac-sha256-jwt), [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P0

**Dependencies:** [REQ-AUTH-002](#req-auth-002-access-token-refresh-token-instant-revocation)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AUTH-010: Dev-bypass production guard

**Intent:** The test-only authentication path used by integration deployments is unreachable from production, even if a dev-bypass secret is accidentally promoted via a shared config, a typo, or environment-variable inheritance.

**Applies To:** Operator

**Acceptance Criteria:**

1. Every route under `/api/dev/*` returns `404` on any deployment identified as production, regardless of token or session state. The check fail-closes: a missing or unrecognised production flag is treated as production, so an unset variable cannot accidentally enable the surface.

**Notes:** `IS_PRODUCTION` semantics and the integration runbook are documented in [`documentation/security.md`](../documentation/security.md#dev-bypass-prod-guard-req-auth-001-ac-10) and [`documentation/deployment.md`](../documentation/deployment.md).

**Constraints:** [CON-SEC-001](constraints.md#con-sec-001-strict-content-security-policy)

**Priority:** P0

**Dependencies:** [REQ-AUTH-001](#req-auth-001-sign-in-with-a-federated-identity-provider)

**Verification:** Integration test

**Status:** Partial
