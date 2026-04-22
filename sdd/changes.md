# Spec Changes

Semantic changes to the specification. Git history captures diffs; this file captures intent.

Each entry is dated, ≤2 sentences, user-facing only. No commit SHAs. No "verification pass" entries. No spec cleanup or format fixes (those live in git history).

## 2026-04-22

- REQ-DES-002 (light and dark mode) now requires the server to render the chosen theme on every request so the first byte already carries the correct theme, removing the visible theme flash that appeared on slow connections and preserved-element view transitions.
- REQ-DES-001 (Swiss-minimal visual language) adds a viewport-fill guarantee: short pages fill the mobile viewport and the content surface stays clear of the bottom navigation and device safe-area insets, so the chrome color never dominates the screen.
- REQ-SET-006 (settings-incomplete gate) now requires the global navigation to hide gated destinations during first-run so the user sees only the Settings entry until onboarding is complete.
- REQ-AUTH-003 (CSRF defense) narrows scope to endpoints that act on an authenticated session, and explicitly exempts OAuth flow entry points whose only effect is setting a short-lived state cookie and redirecting to the identity provider. No observable change for signed-in users; clarifies the existing behavior after the login endpoint gained a POST path.
- Feature-complete milestone: 28 requirements across onboarding, source discovery, digest generation, reading, email, and history moved from Planned to Implemented with passing test coverage; source-discovery progress banner (REQ-DISC-002) and feed-health tracking (REQ-DISC-003) land as Partial pending dedicated end-to-end tests.
- Phase 2 (authentication) and Track B (design system, PWA install, observability) shipped: 11 requirements moved from Planned to Implemented with passing test coverage. REQ-PWA-003 (mobile-first safe-area layout) is Partial — code ships but lacks automated tests.
- Initial product specification bootstrapped from `requirements.md` via `/sdd init` with `enforce_tdd: true`. Scope: 10 domains covering authentication, onboarding, source discovery, digest generation, reading, email, history, design system, PWA, and observability.
