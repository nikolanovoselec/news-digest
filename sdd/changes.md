# Spec Changes

Semantic changes to the specification. Git history captures diffs; this file captures intent.

Each entry is dated, ≤2 sentences, user-facing only. No commit SHAs. No "verification pass" entries. No spec cleanup or format fixes (those live in git history).

Entries from 2026-04-22 through 2026-04-26 (the global-feed rework window) are archived in [`changes-archive-2026-04.md`](changes-archive-2026-04.md).

## 2026-05-06

- REQ-READ-001 AC 7 added: dashboard cards now show a `+N` suffix on the source label when the same story has been reported by multiple publishers, so readers can see at a glance that an article was syndicated. The same treatment applies to cards on Search & History and the starred-articles surface.
- REQ-PIPE-002 AC 1 + AC 5 rewritten and REQ-PIPE-003 AC 2 sharpened: same-story collapse now runs only in the cross-chunk finalize pass (REQ-PIPE-008), not at the chunk level. Per-chunk LLM calls are pure summarisation - every input candidate gets its own entry - so a thin-snippet day no longer risks the chunk model under-reporting clusters that the finalize pass cannot see.
- REQ-PIPE-002 AC 3 recalibrated: chunk summary contract drops from 150-200 words / 3-5 sentences per paragraph to 100-150 words / 2-4 sentences per paragraph, matching the tighter source-grounding rules in the chunk prompt that prefer short summaries over invented filler. The 80-word server-side backstop is unchanged - articles below that threshold are still rejected as truncated stubs.

## 2026-05-05

- REQ-AUTH-001 AC 8 rewritten: Cloudflare Access is now an opt-in additive perimeter rather than a mandatory layer. Deployments without an Access audience tag configured gate `/api/admin/*` on signed-in session + `ADMIN_EMAIL` match alone; deployments that bind Access MUST set the audience tag for the perimeter to be enforced server-side AND MUST also bind Access to the auto-assigned `*.workers.dev` URL or disable that subdomain (AD30) - without either, the perimeter is forgeable from anywhere on the public internet.
- REQ-PIPE-002 AC 3 recalibrated: the chunk consumer's word-count backstop drops from 120 to 80 words. The 120-word floor (added 2026-05-03) cut off ~80% of the model's natural output distribution and dropped daily ingestion from ~100 to ~25 articles; the prompt's contract remains 150-200 words but the server-side floor now only catches genuinely truncated stubs rather than the model's lower-end natural range.
- REQ-PIPE-001 AC extended: the coordinator now synthesises a per-tag Google News query-RSS source for every tag in the union of (default hashtags ∪ curated tags ∪ discovered KV tags) that does NOT already have a bespoke `google-news-*` curated entry. Wide GN fan-out is safe because `prefer-direct-source` already drops a Google News headline whose title overlaps a direct publisher copy in the same tick — so every tag now has a long-tail backstop without polluting the dedup pool.
- REQ-PIPE-001 source-name labelling sharpened: when an RSS item carries a per-item `<source>` element (Google News always emits one identifying the underlying publisher), the headline's `source_name` uses the publisher name (e.g. "Help Net Security") instead of the feed-level adapter name ("Google News: mcp"). Two GN-derived alt-sources for the same article no longer collide on the same generic label in the read-at-source picker.
- REQ-AUTH-005 AC 3 corrected: account deletion clears both session cookies (access and refresh), matching the logout contract in REQ-AUTH-002 AC 3 — previously the AC named only "the session cookie" in the singular, which understated the actual cookie-clear behavior.
- REQ-PIPE-001 AC8 reworded: "coordinator fetches the article body" changed to "pipeline fetches the article body" — the chunk consumer, not the coordinator, performs the body-fetch step; the AC now names the actor correctly without changing the observable contract.
- REQ-OPS-003 AC1 reworded: the CSP requirement now uses user-observable language ("restricts script execution to same-origin, blocks inline event handlers") with the literal directive value moved to documentation/security.md.
- REQ-DES-001 AC1 and REQ-DES-003 AC1 reworded: implementation details (exact font-stack strings, pixel sizes, cubic-bezier value) moved to documentation/architecture.md design-system section; the ACs now describe the observable outcome (5 type sizes, single easing curve, system fonts only).

## 2026-05-04

- REQ-STAR-001 AC 1 broadened and AC 6 added: the spec now names every card surface that exposes a star toggle (dashboard, article detail, starred page, history day-expansions and search results) and requires each card to render its initial starred / unstarred state on first paint, so an article starred elsewhere shows up filled on `/history` without needing a hard refresh.
- REQ-OPS-006 added: a parallel integration deployment target lets risky changes (Astro major bumps, schema migrations, CSP tightening, animation rewrites) be smoke-tested on the live Cloudflare edge before reaching production. Integration runs the same code on isolated Cloudflare resources (D1, KV, queues all suffixed `-integration`), is triggered manually only (Actions → Deploy Integration → Run workflow), always pulls develop's HEAD, and has cron triggers disabled so the operator drives the scrape pipeline via force-refresh. Forks set their own integration hostname under Settings → Environments → integration → Variables → APP_URL.
- REQ-SET-004 corrected to Partial: the model-selection UI is hidden, but the settings API still validates and persists `model_id`. Full retirement awaits removing the field from the API and migrations.
- REQ-OPS-007 added: public sitemap surfaced at `/sitemap.xml` for search-engine discovery, with authenticated routes deliberately excluded. The endpoint shipped earlier; this REQ captures the contract.

## 2026-05-03

- REQ-PIPE-002 AC 2 + AC 3 sharpened: the chunk consumer now enforces the malformed-output thresholds server-side rather than trusting the LLM-side prompt alone. Articles whose details body is under 120 words, or whose title falls outside a 5–500 character sanity range, are dropped before persistence — so a model that ignores the prompt's word-count or headline-length instructions can no longer ship truncated bodies or single-character labels as real articles.

- REQ-OPS-003 AC 1, AC 5 added/tightened: the security policy now narrows allowed image origins to `'self'`, `data:`, and the two Gravatar avatar hosts (rather than blanket `https:`), drops the unused `https://github.com` form-action allowance, and adds an explicit `X-Frame-Options: DENY` as defense-in-depth alongside `frame-ancestors 'none'`. Embedded `<img>` tags pointing at arbitrary HTTPS origins (and embedding the site in any frame) are now refused by compliant browsers.

- REQ-PIPE-008 idempotency observability sharpened: a finalize message that arrives after the run already recorded its dedup outcome short-circuits before the LLM call (saving the Workers AI spend that previous redeliveries paid). When the atomic gate UPDATE loses a genuine race, the structured log now reads `finalize_redelivery_skipped` instead of `finalize_ready` with `cost_recorded: false`, so operators no longer misread the per-attempt counters as merges that just happened.

- REQ-PIPE-001 AC 4 reversed and REQ-READ-001 AC 5 + glossary "Last feed sighting" entry rewritten: the dashboard now orders by **first ingestion** instead of last feed sighting, and a re-discovered URL appends the new source to the article's source list without re-stamping the ingestion timestamp. Older stories that keep being re-broadcast by feeds no longer displace genuinely fresher arrivals on the dashboard, and the multi-source picker reflects every outlet that ever sighted the story.

- REQ-PIPE-008 AC 1 + AC 7 sharpened: the cross-chunk dedup model now receives each candidate's full summary body (not just title + source name) so it can identify same-story pairs by actual content; source name was dropped as a signal because two outlets covering the same event were occasionally blocked from clustering by name mismatch. The finalize call's token + cost are now folded into the per-tick stats on the first successful LLM response regardless of whether the model returned any merges, so a "no duplicates found" result is no longer hidden from the daily tally — paying for a finalize call that confirms zero merges is still a real cost.

- REQ-DISC-001 AC 1 + AC 3 narrowed: tags already covered by the curated source registry skip the LLM-discovery path entirely, so a brand or consumer tag whose name collides with another company's namespace (e.g., the `graymatter` tag pulling in Graymatter Robotics articles via the mandatory Google News fallback) no longer pollutes the per-tag source cache. Existing curated tags continue to work via the registry; discovery still runs for any tag not in the registry.

## 2026-04-29

- REQ-OPS-003 AC 1 corrected (production hotfix): the page styles directive on the security policy now permits inline styles again, since Astro emits component-scoped styles inline at runtime; the script policy stays strict.

- REQ-OPS-004 AC 6 added: structured-data blocks in the page head are now serialised through a defensive helper that escapes every HTML state-transition byte, defeating any `</script>` or comment-state escape if a future refactor interpolates a user-controlled value into the graph.

- REQ-AUTH-001 AC 9a broadened: rate-limit coverage now extends beyond auth and mutation endpoints to any authenticated endpoint that legitimate clients poll sub-minute, sized so normal usage is untouched while pathological loops are bounded.

- REQ-SET-006 AC 5 and REQ-SET-007 AC 7 added: the per-user rate limits introduced by the broader REQ-AUTH-001 AC 9a are now documented in the domains where the affected endpoints (discovery-progress polling, timezone update) are user-facing.

- REQ-AUTH-001 AC 8a extended: the admin gate now logs a structured operational warning when a Cloudflare-Access-shaped header is presented but the audience tag is unset, surfacing the misconfiguration on the operator's tail without otherwise changing how the request is gated.

- Per-digest retrieval endpoint retired alongside REQ-READ-004's earlier deprecation: stale clients still polling the per-id digest path now receive HTTP 410 Gone, matching the sibling refresh-endpoint tombstone.

## 2026-04-28

- REQ-PWA-003 AC 4 hardened: the brand wordmark's tap target now stretches across the entire left half of the header instead of hugging the icon-and-text content, so first-tap reliability on mobile improves dramatically without changing the visible layout.

- REQ-PWA-001 AC 6 reverted (rolled back the same day it landed): the in-app brand-canvas splash overlay was unreliable across hard navigations, so the system splash that Android renders from the manifest is the only splash now and disappears on first paint.

- REQ-PWA-001 AC 1 refined and REQ-DES-002 AC 6 extended: the installable PWA's splash screen and document body now both stay locked to the dark theme by default, so dark-mode readers (the common case at reading hours) never see a white flash on cold launch or during in-app navigation.

- REQ-DES-002 AC 6 added and REQ-DES-003 AC 6 added: the mobile system status bar now follows the app's selected theme rather than the device's OS theme, repainted instantly on toggle and preserved across page navigations; the site header chrome also stays visually solid through every route transition.

- REQ-PWA-003 AC 4 extended: clicking the brand wordmark while already on the digest now scrolls the page to the top instead of triggering a self-navigation, so the wordmark doubles as a "back to top" affordance once the user has scrolled into the list.

- REQ-PWA-003 AC 4 refined: the brand-as-back-to-top behaviour now only fires on the unfiltered `/digest` URL — clicking the brand on a filtered view falls through to natural navigation so the filter clears, and modifier-clicks (Cmd/Ctrl/Shift/Alt) and non-primary mouse buttons are no longer intercepted so "open in new tab" continues to work.

- REQ-MAIL-001 AC 11 reversed: the daily digest email now skips the send entirely on local days where the recipient has zero unread articles, instead of sending a bare notification with no headlines. An empty email is noise — silence is the better signal.

- REQ-AUTH-008 AC 1 rewritten: refresh tokens are no longer logged out when the browser auto-updates its User-Agent string — fingerprint mismatches on the normal refresh path are now logged for review instead of force-revoking, while the 30-second concurrent-rotation grace branch still treats a fingerprint drift as theft. The per-user refresh rate limit also rose from 10/min to 30/min so multi-tab users stop hitting silent 401s when their access JWT expires.

- REQ-PIPE-003 AC 6 added: when the same story appears via a direct publisher link and an aggregator-wrapper link whose canonicalised URL differs (e.g., Google News), the wrapper copy is dropped and its tag-of-discovery state is merged onto the surviving direct article — closing the bug where one trending story showed up four times on `/digest`.

- Default hashtag seed grows from 20 to 21 entries with the addition of `graymatter`, and the curated source registry gains a graymatter.ch RSS feed so the new tag has at least one verified source from day one. The 25-tag user cap is unchanged so a new account now has 4 slots of custom-tag headroom instead of 5.

- REQ-SET-003 AC 1 refined: the digest schedule picker now displays 12-hour AM/PM labels for users on 12-hour locales (en-US and similar) and 24-hour labels for 24-hour locales (en-GB, hr-HR, and similar), auto-detected from the browser without any country-by-country hardcoding.

## 2026-04-27

- REQ-MAIL-002 AC 3 refined: a missing or unrecognised stored timezone on one user row no longer aborts the whole 5-minute dispatch tick — that bucket is skipped with a structured warn log and sibling buckets continue.

- REQ-READ-002 AC 4 refined: the back control now also returns the user to the originating page when they arrived via a same-app client-side navigation (not just a hard page load), and the reverse card-morph plays even when the originating card sits below the fold of the source page (e.g. inside an expanded day on `/history`).

- REQ-READ-002 AC 1 refined: the article-detail metadata line's third slot is the article's ingestion time (when the story landed in our pool) rather than an estimated read-time pill, rendered as wall-clock hour:minute only in the user's timezone since the publish date already sits beside it.

- REQ-AUTH-001 AC 9 refined: the rate-limit fail-mode is now per-rule — sign-in and OAuth-callback rules continue to fail open so a backing-store outage cannot lock legitimate users out, while the refresh-token rule fails closed so a stolen refresh cookie cannot use a backing-store outage to bypass the limit. The inline middleware refresh path also shares the same refresh-rate-limit bucket as the explicit endpoint, closing the pivot from authenticated GET routes.

- REQ-AUTH-008 AC 4 refined and REQ-AUTH-002 AC 5 added: refresh-token reuse detection now applies a 30-second grace window so two parallel refreshes from the same client (multi-tab wake) no longer get mistaken for a stolen-token replay and lock the user out, while a true replay outside that window still triggers full session revocation across every device. A separate explicit-refresh endpoint is documented for clients that need a guaranteed fresh access JWT before a state-changing request.

- REQ-AUTH-002 rewritten and new REQ-AUTH-008 added: sign-in now uses an access + refresh token model — a 5-minute access cookie plus a 30-day refresh cookie, rotated on every refresh and bound to the signing-in device's User-Agent + country fingerprint. Closing the tab and coming back a month later no longer logs the user out, and a stolen-then-rotated refresh token is detected as theft.

- REQ-PIPE-005 retention window and REQ-HIST-001 history window both extended from 7 to 14 days, and a new REQ-HIST-001 AC makes the relationship explicit so the two windows are kept in lockstep — the dashboard, /history page, and tag-railing counts now show twice the lookback before retention sweeps unstarred articles.

- REQ-PIPE-006 AC 7 added: the per-tick token, cost, articles-ingested, and articles-deduplicated counters now advance exactly once per chunk regardless of how many times the queue redelivers that chunk's message, so a flaky tick can no longer inflate the stats widget or history page with retry traffic.

- REQ-PIPE-006 AC 4 tightened: once a run leaves running its status is terminal, so the dashboard no longer flips a finished run back to failed when a chunk's last retry exhausts after the run already reached ready, and a delayed success path can't flip a failed run back to ready either.

- REQ-PIPE-008 AC 9 refined: a second transient outage of the run-state store landing inside the same closing handoff (i.e. the lock-clearing rollback itself failing) now records a structured operator-visible log entry naming the stranded lock and the original send error, and the original send error is the one surfaced to the queue retry path so the underlying cause is not masked.

- REQ-PIPE-006 AC 6 added and REQ-PIPE-008 AC 9 added: the history page's per-tick duration no longer drifts forward when the queue redelivers the closing message of a scrape, and a transient queue hiccup at the moment a tick closes can no longer strand the run without its cross-chunk dedup pass.

- REQ-AUTH-002 AC 4 silent-refresh threshold updated from "less than 15 minutes" to "less than 5 minutes", and now extends across plain page navigation, not just XHR API calls — so users actively reading the dashboard no longer hard-expire after 60 minutes mid-session.

- REQ-OPS-005 added covering the operator force-refresh endpoint that was previously undocumented in the spec — operators can manually trigger a scrape tick from `/settings`, the request reuses any in-flight run started in the last two minutes to absorb double-clicks, and the response is content-negotiated.

- REQ-AUTH-001 hardens admin endpoints: `/api/admin/*` now requires Cloudflare Access *and* a valid Worker session *and* an `ADMIN_EMAIL` match, instead of trusting Access alone. Per-route application-layer rate limiting is also added on `/api/auth/*` so a misconfigured WAF rule cannot be abused for abuse-of-OAuth flows.

- REQ-AUTH-007 added (and REQ-AUTH-001 AC 7 removed): signing in via two providers with the same verified email now lands in one account, not two. Existing duplicate-email pairs are merged in a single one-time pass so the daily digest goes out once instead of twice.

- REQ-DISC-006 added: stuck tags (no working feeds for more than 7 days) now drop out of the user's interests automatically on the daily retention pass, and the settings page lists the actual stuck tag names instead of just a count so users can see which tags need attention.

- REQ-DISC-004 AC 4 updated: the bulk "Discover missing sources" endpoint now accepts both POST (settings form submit) and GET (the request shape Cloudflare Access uses after bouncing the click through SSO), so users with Access configured no longer land on a 404 after the post-auth callback.

- REQ-MAIL-001 ACs reworked: source-name labels next to email headlines are gone (Outlook auto-linkified tokens like `cs.AI` into fake links), so the headline is now the only clickable element per row. The signature switches to a webapp-matching footer "Built with Codeflare © 2026 Gray Matter GmbH" with both names linked, and the From header now displays "News Digest <noreply@graymatter.ch>" so inbox lists show the brand instead of the bare email.
