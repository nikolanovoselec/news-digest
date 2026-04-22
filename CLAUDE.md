# news-digest — agent behavior

## Autonomous build loop

After Plan Mode approval, execute the full plan without pausing between phases. Do not ask "should I continue?" between REQs or phases. The approved plan lives at `~/.claude/plans/piped-wishing-kahan.md`.

## TDD workflow

- Every REQ implementation: `tdd-guide` writes the failing test first, then minimal implementation, then commit.
- Test names reference REQ IDs: `test('REQ-AUTH-003: rejects state-changing requests without matching Origin', ...)`.
- Source files implementing observable behavior include `// Implements REQ-X-NNN` comments so `spec-reviewer` can detect code without tests.

## Commits

- One REQ per commit where feasible; batch only when REQs share a file.
- Subject format: `feat(domain): REQ-X-NNN short description` for feature commits; `fix`, `chore`, `docs`, `test` prefixes as appropriate.
- No AI attribution lines; no emoji.

## Every push

1. Spawn a background Bash CI poll loop (per `~/.claude/rules/ci-monitoring.md`): polls every 15s until all runs complete.
2. Do not poll in foreground. You will be notified when the loop exits.
3. On `ALL GREEN`: continue to next phase.
4. On `COMPLETED WITH FAILURES`: read `gh run view <id> --log-failed`, fix, re-push, restart the monitor. Up to 3 fix attempts per distinct failure before escalating to the user.

## No local builds

Per `~/.claude/rules/no-local-builds.md`: never run `npm install`, `npm test`, `npm run build`, `npx tsc`, `npx vitest`, `oxlint`, `knip` locally. The container has 1 vCPU. CI is the only build/test surface.

## Completion

Done when:
- All 40 REQs in `sdd/` are `Status: Implemented`
- Most recent CI run on `main` is green
- Worker is deployed to Cloudflare and landing page returns 200

## Escalation

Come back to the user only for:
- Missing GitHub repo Secret that blocks progress
- Genuinely ambiguous REQ acceptance criteria
- Repeated CI failure after 3 fix attempts on the same root cause
- `security-reviewer` CRITICAL finding that needs a product decision

## SDD discipline

- `sdd/` is the source of truth for requirements. Code changes that introduce new observable behavior require a spec edit (via `/sdd edit`) before implementation.
- `requirements.md` is historical — do not edit.
- `documentation/` describes implementation; `doc-updater` agent maintains it post-push.
- Mode: `unleashed` in `sdd/config.yml` — `spec-reviewer` auto-fixes everything on the current branch (no PR).
