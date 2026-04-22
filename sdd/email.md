# Email Notifications

Resend-backed notification sent after every successful scheduled digest (not manual refreshes). Best-effort delivery — a Resend outage never fails a digest that completed successfully. Users can opt out via the `email_enabled` toggle in settings.

---

### REQ-MAIL-001: Digest-ready email

**Intent:** Users who have opted in receive a simple, aesthetically consistent email when their daily digest is ready, inviting them back to the app.

**Applies To:** User

**Acceptance Criteria:**
1. Immediately after the digest consumer commits `status='ready'` with `trigger='scheduled'`, and only if `users.email_enabled = 1`, a POST is made to Resend to send the email.
2. The subject line reads "Your news digest is ready · {N} stories" where N is the article count.
3. The HTML body follows the Swiss-minimal template: a small uppercase "News Digest" label, a large "Your daily digest is ready" headline, a one-line summary of story count and top-3 hashtags, a single primary CTA button to the digest, and a muted footer with execution time, token count, estimated cost, and a link to /settings.
4. A plaintext fallback body is included for clients that do not render HTML.
5. Manual refreshes never trigger an email regardless of the toggle.

**Constraints:** None
**Priority:** P1
**Dependencies:** REQ-GEN-006, REQ-SET-005
**Verification:** Integration test
**Status:** Implemented

---

### REQ-MAIL-002: Non-blocking email failure

**Intent:** A Resend outage, misconfiguration, or bounce never blocks or fails a digest that otherwise completed successfully.

**Applies To:** User

**Acceptance Criteria:**
1. The Resend POST uses a 5-second timeout.
2. Any non-2xx response, network failure, or timeout is logged as `{ level: 'error', event: 'email.send.failed', user_id, digest_id, status }`; no exception bubbles up.
3. The `digests` row remains `status='ready'` regardless of email outcome.
4. The in-app digest is fully viewable independent of email delivery.

**Constraints:** None
**Priority:** P1
**Dependencies:** REQ-MAIL-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-MAIL-003: Sender domain verification

**Intent:** Emails arrive in the inbox, not the spam folder.

**Applies To:** User

**Acceptance Criteria:**
1. The `RESEND_FROM` env var contains a sender email whose domain has SPF, DKIM, and DMARC records configured and verified in the Resend dashboard.
2. Until a domain is verified, the system can run but the operator is aware email reliability will be low (Resend falls back to its default sandbox sender, flagged as "from sandbox" by many providers).
3. Deployment documentation walks operators through the domain verification steps.

**Constraints:** None
**Priority:** P2
**Dependencies:** REQ-MAIL-001
**Verification:** Manual check
**Status:** Planned
