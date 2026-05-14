# Observability

**Audience:** Developers, Operators

Operational reference for the structured log events emitted to Cloudflare Logs, the rate-limit counter behaviour visible through those events, and the design rationale behind security-adjacent log signals that look like enforcement but are not.

Every log line in this Worker is `JSON.stringify`'d and emitted via `console.log`, so Cloudflare Logs parses each line as a structured record. There is no separate logging library and no in-Worker buffering: one event, one stdout line.

## Contents

- [Event envelope](#event-envelope)
- [Event enum](#event-enum)
- [Error detail field](#error-detail-field)
- [Rate-limiter atomicity and the WAF backstop](#rate-limiter-atomicity-and-the-waf-backstop)
- [Refresh rate-limit fail-mode fields](#refresh-rate-limit-fail-mode-fields)
- [Why fingerprint drift is logged but not enforced](#why-fingerprint-drift-is-logged-but-not-enforced)
- [Related Documentation](#related-documentation)

---

## Event envelope

Every event carries:

| Field | Type | Description |
|---|---|---|
| `ts` | number | Unix milliseconds (`Date.now()`) |
| `level` | string (`"info"` \| `"warn"` \| `"error"`) | Severity |
| `event` | string (closed enum) | Event name; see [Event enum](#event-enum) |

Source: `src/lib/log.ts` defines the `LogEvent` union; the `log()` helper writes a single line per call.

**Implements:** [REQ-OPS-001](../sdd/observability.md#req-ops-001-structured-json-logging)

---

## Event enum

Each event has fixed semantics and may carry additional event-specific fields; consult `src/lib/log.ts` for the exact per-event shape.

| Event | When emitted |
|---|---|
| `auth.login` | Successful OAuth callback - user created or re-authenticated |
| `auth.callback.failed` | OAuth callback failed (token exchange, user fetch, or DB) |
| `auth.callback.invalid_state` | CSRF state mismatch in the OAuth callback (returns 403) |
| `auth.logout` | Session version bumped; cookies cleared; active refresh row revoked |
| `auth.logout.refresh_revoke_failed` | D1 revoke call in logout threw; session_version still bumped |
| `auth.logout.sv_bump_failed` | D1 session_version increment in logout threw |
| `auth.account.delete` | User row deleted from D1 |
| `auth.account.delete.failed` | D1 delete threw, or KV cleanup threw |
| `auth.set_tz.failed` | D1 update in `POST /api/auth/set-tz` threw |
| `digest.generation` | Digest generation completed (success or failure) |
| `source.fetch.failed` | An individual source could not be fetched during fan-out |
| `refresh.rejected` | Manual refresh rejected (rate-limited or already in progress) |
| `auth.refresh.rotated` | Refresh-token row rotated (middleware or explicit endpoint) |
| `auth.refresh.rotate_failed` | D1 batch in `rotateRefreshToken` threw |
| `auth.refresh.expired` | Refresh cookie presented but the row is past its 30-day TTL |
| `auth.refresh.fingerprint_drift` | UA or country changed; logged but not enforced (see [below](#why-fingerprint-drift-is-logged-but-not-enforced)) |
| `auth.refresh.grace_fingerprint_mismatch` | Fingerprint mismatch inside 30s grace; treated as theft |
| `auth.refresh.concurrent_collision` | Revoked cookie inside grace window; served fresh JWT off surviving row |
| `auth.refresh.concurrent_lost_race` | Same as above; no surviving row found; treated as reuse |
| `auth.refresh.reuse_detected` | Revoked cookie outside grace window; all refresh rows revoked, session_version bumped |
| `auth.refresh.purge_completed` | Daily purge of expired/old-revoked refresh-token rows completed |
| `auth.refresh.purge_failed` | Daily purge threw |
| `email.send.failed` | Resend API call failed |
| `email.dispatch.degraded` | Per-user D1 data-fetch failed; user treated as having zero headlines |
| `email.dispatch.skipped_empty` | Zero unread headlines for the local day; send skipped |
| `email.dispatch.skipped_invalid_tz` | User row has empty or unrecognised IANA timezone |
| `discovery.completed` | Per-tag LLM discovery run finished |
| `discovery.queued` | New per-tag discovery job inserted into `pending_discoveries` |
| `settings.update.failed` | D1 update in `PUT /api/settings` threw |
| `auth.refresh.rate_limited` | Refresh rate-limit bucket hit; request rejected with 429 |
| `rate.limit.kv_error` | KV read/write in the rate-limit helper threw |
| `article.star.failed` | D1 insert or delete in `POST/DELETE /api/articles/:id/star` threw |

---

## Error detail field

Error-level records carry raw exception messages in a `detail` field. The `detail` value is never persisted to D1 and is never returned to clients - it exists for log-side post-mortem and is the only place the unredacted exception text lives.

**Implements:** [REQ-OPS-002](../sdd/observability.md#req-ops-002-sanitized-error-surfaces)

---

## Rate-limiter atomicity and the WAF backstop

The KV-backed rate limiter in `src/lib/rate-limit.ts` does a non-atomic `get`-then-`put`. Concurrent requests racing in the same window can each read the same counter value `N`, decide `N < limit`, and each write `N+1`, allowing up to `concurrency × limit` through during the propagation window. Cloudflare KV is eventually consistent; the propagation window for a `put` is documented as up to 60 seconds globally.

For fail-open routes (every limiter rule except `AUTH_REFRESH_IP` and `AUTH_REFRESH_USER`) the non-atomicity is acceptable - the limiter is defence-in-depth, not the contract. The contract is that ordinary clients see the documented limit; an attacker stretching the propagation window does not change the security shape.

For the two fail-closed rules (`AUTH_REFRESH_IP`, `AUTH_REFRESH_USER`) protecting refresh-token spray attacks, the in-Worker limiter is still defence-in-depth, not the primary gate. The primary gate for production deployments is Cloudflare zone-level Rate Limiting (WAF), which is atomic. Without WAF in front of `/api/auth/refresh`, a coordinated burst above approximately `2 × limit` can succeed during the propagation window. This is tracked as CF-034 and is the reason fail-closed alone is insufficient for refresh-token spray.

**Implements:** [REQ-AUTH-001 AC 9](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider)

---

## Refresh rate-limit fail-mode fields

Refresh-token rate-limit events (`auth.refresh.rate_limited`, `rate.limit.kv_error`) carry three extra fields beyond the envelope:

| Field | Values | Meaning |
|---|---|---|
| `bucket` | `"ip"` | Pre-validation `auth_refresh_ip` rule (60 / 60s per IP) |
| `bucket` | `"user"` | Post-validation `auth_refresh_user` rule (30 / 60s per user) |
| `decision` | `"fail_open"` | KV outage on a route configured fail-open (every non-refresh route) |
| `decision` | `"fail_closed"` | KV outage on a refresh-token route (request rejected) |
| `kv_op` | `"get"` | Error on the counter-read path |
| `kv_op` | `"put"` | Error on the counter-write path |

These fields exist so a single grep against the `event` value tells the operator which rule fired (per-IP vs per-user) and whether the failure mode degraded the gate.

---

## Why fingerprint drift is logged but not enforced

A refresh-token row stores the user-agent and country at issuance. On every refresh the present UA and country are compared against the stored values, and `auth.refresh.fingerprint_drift` is emitted when either differs. **The drift does not block the refresh.**

The reasoning is steady-state operational: UA strings change on every browser auto-update, and country attribution flips whenever a user moves between Wi-Fi and a mobile network. Hard-gating refresh on either would lock users out routinely. Published guidance (RFC 9700 §4.13, OWASP Session Management Cheat Sheet, Auth0 and Okta refresh-token rotation docs) is consistent: log drift for anomaly detection and downstream correlation, do not enforce it on the steady-state path. The enforcement signal is reuse-detection - a revoked-then-replayed cookie - not fingerprint drift.

The asymmetric exception is the 30-second concurrent-rotation grace window: a fingerprint mismatch inside the grace window IS treated as theft and emits `auth.refresh.grace_fingerprint_mismatch`. That asymmetry is intentional: a concurrent-rotation collision should come from the same client (same UA, same country) within seconds. A grace-window collision from a different fingerprint is the textbook stolen-cookie pattern.

**Implements:** [REQ-AUTH-011](../sdd/authentication.md#req-auth-011-refresh-token-reuse-detection-and-device-fingerprint-policy)

---

## Related Documentation

- [`architecture.md`](architecture.md) - Component map showing where `log()` is called
- [`security.md`](security.md) - Rate-limit threat model and admin auth gate; fingerprint reuse-detection threat
- [`api-reference.md`](api-reference.md) - HTTP endpoint surface; which events fire on which routes
- [`api-reference-admin.md`](api-reference-admin.md) - Admin endpoints; admin-gate failure events
- [`../sdd/observability.md`](../sdd/observability.md) - REQ-OPS-001, REQ-OPS-002 acceptance criteria
