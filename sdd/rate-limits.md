# Rate Limits

Application-layer rate-limit policy that applies across the auth surface, authenticated mutations, polling endpoints, and admin side-effecting endpoints. Feature REQs in other domains reference this policy rather than restating its rules.

Mechanism detail (per-bucket sizes, refresh-middleware/explicit-endpoint shared bucket, fail-mode asymmetry) lives in [`documentation/security.md`](../documentation/security.md#rate-limiting-req-auth-001-ac-9).

---

### REQ-RATE-001: Application-layer rate limits on the auth and mutation surface

**Intent:** Authentication, mutation, and admin endpoints are bounded so a brute-force attacker, a compromised admin session, or a runaway client cannot drive unbounded traffic at the application. This is a cross-cutting policy and is referenced by feature REQs that need a rate-limit guarantee, rather than each feature restating the rules.

**Applies To:** User

**Acceptance Criteria:**

1. Every authentication route, every authenticated mutation route, every authenticated endpoint that legitimate clients poll on a sub-minute cadence, and every admin side-effecting endpoint is rate-limited. An exhausted limit returns `HTTP 429` with a `Retry-After` header.
2. Buckets are keyed by IP for unauthenticated paths, by user id for authenticated mutations, and by operator id for admin side-effecting endpoints, so a successfully-authenticated admin session is still bounded.
3. Sign-in and OAuth callback rules fail open on a backing-store outage so a transient outage cannot lock users out. Refresh-token rules fail closed so a stolen refresh cookie cannot exploit the outage.
4. A rate-limited admin force-refresh or pipeline-run click surfaces the throttled state to the operator's settings surface with a retry-after value rather than silently dropping the action.

**Notes:** Per-bucket sizes, the refresh middleware/explicit-endpoint shared bucket, and the fail-open/fail-closed asymmetry are documented in [`documentation/security.md`](../documentation/security.md#rate-limiting-req-auth-001-ac-9).

**Constraints:** CON-AUTH-001, CON-SEC-001
**Priority:** P0
**Dependencies:** REQ-AUTH-001
**Verification:** Automated test
**Status:** Partial

---
