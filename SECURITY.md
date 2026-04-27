# Security Policy

## Supported Versions

Only the deployed `main` branch is supported. The repo's `develop`
branch is the staging line for the next deploy and may carry unfixed
issues. There are no semver releases — production is whatever
`main` currently points to.

## Reporting a Vulnerability

If you find something that looks security-relevant — a way to read
another user's data, bypass auth, escape rate limits, or have the LLM
backend produce output that didn't come from one of the user's
sources — please **do not** open a public GitHub issue.

Instead, email the owner directly via
[GitHub's private vulnerability reporting](https://github.com/nikolanovoselec/ai-news-digest/security/advisories/new).
That keeps the issue confidential while we investigate. A first
response should land within a few days; for anything user-data-related
the fix is treated as P0 and shipped as soon as a deploy can be cut.

If the GitHub form is not available, the project owner's contact is
listed on [graymatter.ch](https://graymatter.ch).

## What's in scope

- Authentication and session cookies
  ([REQ-AUTH-001](sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider),
  [REQ-AUTH-002](sdd/authentication.md#req-auth-002-access-token--refresh-token-instant-revocation),
  [REQ-AUTH-007](sdd/authentication.md#req-auth-007-cross-provider-account-dedup))
- Origin / CSRF defense on state-changing endpoints
  ([REQ-AUTH-003](sdd/authentication.md#req-auth-003-csrf-defense-for-state-changing-endpoints))
- Admin endpoints (Cloudflare Access + session + ADMIN_EMAIL match,
  [REQ-AUTH-001 AC 8](sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider))
- Rate-limit bypass paths
  ([REQ-AUTH-001 AC 9](sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider))
- LLM prompt injection that produces fabricated source attributions
  ([REQ-PIPE-002](sdd/generation.md#req-pipe-002-chunked-llm-processing-with-json-output-contract))
- Anything that bypasses the per-user data scope

## What's out of scope

- Reports based purely on automated scanner output (Scorecard, npm
  audit) without a concrete exploit. The `documentation/decisions/`
  ADRs and `sdd/.review-needed.md` track the project's stance on those.
- DoS via legitimate traffic shapes. Cloudflare's edge handles those.
- Third-party scanners flagging "GitHub-owned action not pinned by
  hash" — see ADR / scorecard policy in repo for rationale.
- Issues that require an authenticated session AND a separate
  privilege escalation we already document as the operator's
  responsibility (e.g. an attacker with the operator's GitHub creds).
