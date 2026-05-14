# Pending Work

In-flight tasks and known gaps. This is NOT the spec — requirements live in `sdd/`.

---

## Partial REQs with deferred scope

### REQ-SET-008 AC 4 — `POST /api/tags/restore` server behaviour
Button + native form POST covered by `tests/settings/tag-curation.test.ts`.
The server endpoint itself (writes `DEFAULT_HASHTAGS`, 303-redirects
to `/digest`) has only manual verification. Add a unit test alongside
`tests/settings/api.test.ts`.

### Test-name migration after auth domain split
Tests currently cite `REQ-AUTH-001 AC 8 / 9 / 10` for behavior now
owned by REQ-AUTH-006 (Admin gating), REQ-AUTH-010 (Dev-bypass guard),
and REQ-RATE-001 (rate-limit policy). Rename the relevant
`describe`/`it` blocks so spec-reviewer's literal-match coverage rule
attributes the tests to the new REQ IDs.

## Operational TODOs

### 12 curated source URLs currently 4xx
Found by `scripts/validate-curated-sources.mjs` on 2026-04-23. The
coordinator swallows failures so these are non-blocking, but each is
~10 candidates of lost breadth per hour. Swap URLs or drop them:

- netlify-blog, perplexity-blog (403), mistral-news,
  modelcontextprotocol, zscaler-blog, datadog-blog, illumio-blog,
  honeycomb-blog, turso-blog, anthropic-engineering, anthropic-news
- azure-updates returns an unexpected body prefix (probably a JSON
  login redirect)

### Hardcoded sitemap origin in robots.txt / llms.txt
`Sitemap: https://news.graymatter.ch/sitemap.xml` is baked in as a
string; fork deployments serve the production URL from their own
origin. robots.txt requires absolute URLs per RFC; a deploy-time
template substitution is the cleanest fix.
