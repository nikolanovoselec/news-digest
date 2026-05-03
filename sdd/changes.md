# Spec Changes

Semantic changes to the specification. Git history captures diffs; this file captures intent.

Each entry is dated, ≤2 sentences, user-facing only. No commit SHAs. No "verification pass" entries. No spec cleanup or format fixes (those live in git history).

## 2026-04-29

- REQ-OPS-003 AC 1 corrected (production hotfix): the Content-Security-Policy `style-src` directive now permits `'unsafe-inline'` again. The earlier same-day tightening to `style-src 'self'` broke every page in production because Astro emits component-scoped styles as inline `<style>` blocks at runtime; the strict policy blocked the landing page, digest grid, tag railing, and component animations from rendering. `script-src` remains strictly `'self'`.

- REQ-OPS-004 AC 6 added: structured-data (JSON-LD) blocks in the page head are now serialized through a defensive helper that escapes every `<`, `>`, and `&` byte to its `\uNNNN` JSON form, defeating every HTML state-transition vector that could escape the script block (`</script>`, `<!--`, `]]>`, `<script` re-entry). No user-visible change today — every JSON-LD value is still server-controlled; the defence is preventive insurance for a future refactor that interpolates a user-controlled value.

- REQ-AUTH-001 AC 9a broadened: rate-limit coverage now extends beyond auth and mutation endpoints to any authenticated endpoint that legitimate clients poll sub-minute. The settings-page timezone-update path and the discovery-progress polling path each carry per-user limits sized to leave normal usage untouched while bounding pathological loops.

- REQ-SET-006 AC 5 and REQ-SET-007 AC 7 added: the per-user rate limits introduced by the broader REQ-AUTH-001 AC 9a are now documented in the domains where the affected endpoints are user-facing, so the polling and timezone-update paths each name their own contract.

- REQ-AUTH-001 AC 8a extended: the admin gate now logs a structured operational warning when a Cloudflare-Access-shaped header is presented but the audience tag is unset, surfacing the unbound-perimeter misconfiguration on the operator's tail/Logpush stream without otherwise changing how the request is gated.

- Per-digest retrieval endpoint retired alongside REQ-READ-004's earlier deprecation: stale clients that still poll the per-id digest path now receive HTTP 410 Gone, matching the sibling refresh-endpoint tombstone. No user-visible change — the endpoint stopped being the source of truth on 2026-04-23 when the global-feed rework landed.

## 2026-04-28

- REQ-PWA-003 AC 4 hardened: the brand wordmark's tap target now stretches across the entire left half of the header instead of hugging the icon-and-text content, so first-tap reliability on mobile improves dramatically without changing the visible layout. Users who aimed roughly at the wordmark and missed it on narrow viewports — and so kept tapping with no feedback — now hit on the first try.

- REQ-PWA-001 AC 6 reverted (rolled back the same day it landed): the in-app brand-canvas splash overlay was meant to hold the cold-launch screen for ~2.4 s after Android Chrome's system splash hid, but the once-per-session gate was unreliable across hard navigations and the overlay re-appeared on every article-detail open. The system splash that Android renders from the manifest is the only splash now — it disappears on first paint, which is the documented OS behaviour and what users expect.

- REQ-PWA-001 AC 1 refined and REQ-DES-002 AC 6 extended: the installable PWA's splash screen and its document body now both stay locked to the dark theme by default — dark-mode readers (the common case at reading hours) never see a white flash on cold launch or during in-app navigation, while light-mode readers see a brief dark splash only at the moment the app is first launched from the home screen, after which their selected theme takes over for the rest of the session.

- REQ-DES-002 AC 6 added and REQ-DES-003 AC 6 added: the mobile system status bar now follows the app's selected theme rather than the device's OS theme — a user in dark mode on a light-mode phone sees a dark status bar above the dark UI, repainted instantly on toggle and preserved across page navigations. The site header chrome also stays visually solid through every route transition, fixing the "black bar bleed" where outgoing body content briefly showed through the header band on detail-back navigation.

- REQ-PWA-003 AC 4 extended: clicking the brand wordmark while already on the digest now scrolls the page to the top instead of triggering a self-navigation, so the wordmark doubles as a "back to top" affordance once the user has scrolled into the list.

- REQ-PWA-003 AC 4 refined: the brand-as-back-to-top behaviour now only fires on the unfiltered `/digest` URL — clicking the brand on a filtered view (any query string, e.g. `?tags=...`) falls through to natural navigation so the filter clears, preserving the long-standing "click the wordmark to reset" affordance. Modifier-clicks (Cmd/Ctrl/Shift/Alt) and non-primary mouse buttons are also no longer intercepted, so "open the digest in a new tab" continues to work as expected.

- REQ-MAIL-001 AC 11 reversed: the daily digest email now skips the send entirely on local days where the recipient has zero unread articles, instead of sending a bare "your digest is ready" notification with no headlines. An empty email is noise — silence is the better signal that filters are too narrow or there was no news worth waking the inbox for.

- REQ-AUTH-008 AC 1 rewritten: refresh tokens are no longer logged out when the browser auto-updates its User-Agent string — fingerprint mismatches on the normal refresh path are now logged for review instead of force-revoking the session, while the 30-second concurrent-rotation grace branch still treats a fingerprint drift as theft. The per-user refresh rate limit also rose from 10/min to 30/min so multi-tab users stop hitting silent 401s when their access JWT expires.

- REQ-PIPE-003 AC 6 added: when the same story appears via a direct publisher/community link and an aggregator-wrapper link (e.g., Google News) whose canonicalised URL differs, the wrapper copy is dropped and its tag-of-discovery state is merged onto the surviving direct article — closing the bug where one trending story showed up 4× on `/digest` because the canonical-URL pass treated the wrapper and the original as distinct.

- Default hashtag seed grows from 20 to 21 entries with the addition of `graymatter`, and the curated source registry gains a graymatter.ch RSS feed so the new tag has at least one verified source from day one. REQ-AUTH-001 AC 5, REQ-PIPE-004 (header + AC 2), and REQ-SET-002 AC 6/8 updated; the 25-tag user cap is unchanged so a new account now has 4 slots of custom-tag headroom instead of 5.

- REQ-SET-003 AC 1 refined: the digest schedule picker now displays 12-hour AM/PM labels for users on 12-hour locales (en-US and similar) and 24-hour labels for 24-hour locales (en-GB, hr-HR, and similar), auto-detected from the browser without any country-by-country hardcoding — previously a Europe/Zagreb user on an en-US Android device saw "08:00 AM" because the native browser time input fell back to the device locale.

## 2026-04-27

- REQ-MAIL-002 AC 3 refined: a missing or unrecognised stored timezone on one user row no longer aborts the whole 5-minute dispatch tick — that bucket is skipped with a structured warn log and sibling buckets continue, so a single corrupted legacy row can't silently halt the daily email for everyone else.

- REQ-READ-002 AC 4 refined: the back control now also returns the user to the originating page when they arrived via a same-app client-side navigation (not just a hard page load), and the reverse card-morph now plays even when the originating card sits below the fold of the source page (e.g. inside an expanded day on `/history`) — the prior implementation silently degraded to a root cross-fade in both cases, sending users to `/digest` or losing the morph animation entirely.

- REQ-READ-002 AC 1 refined: the article-detail metadata line's third slot is the article's ingestion time (when the story landed in our pool) rather than an estimated read-time pill, rendered as wall-clock hour:minute only in the user's IANA timezone — the publish date already sits beside it on the same line, so duplicating the ingestion date there read as noise.

- REQ-AUTH-001 AC 9 refined: the rate-limit fail-mode is now per-rule — sign-in and OAuth-callback rules continue to fail open so a backing-store outage cannot lock legitimate users out, while the refresh-token rule fails closed so a stolen refresh cookie cannot use a backing-store outage to bypass the limit. The inline middleware refresh path also shares the same refresh-rate-limit bucket as the explicit endpoint, closing the pivot from authenticated GET routes.

- REQ-AUTH-008 AC 4 refined and REQ-AUTH-002 AC 5 added: refresh-token reuse detection now applies a 30-second grace window so two parallel refreshes from the same client (a common pattern when several tabs wake up together) no longer get mistaken for a stolen-token replay and lock the user out, while a true replay outside that window still triggers full session revocation across every device. A separate explicit-refresh endpoint is documented for clients that need a guaranteed fresh access JWT before a state-changing request, with cookies cleared cleanly on every failure path so a half-cleared session cannot persist. REQ-AUTH-008 AC 2 also clarifies that the persisted row identifier is independent of the cookie secret, so a leaked database dump cannot be replayed against the live system.

- REQ-AUTH-002 rewritten and new REQ-AUTH-008 added: sign-in now uses an access + refresh token model — a 5-minute access cookie plus a 30-day refresh cookie, rotated on every refresh and bound to the signing-in device's User-Agent + country fingerprint. Closing the tab and coming back a month later no longer logs the user out, and a stolen-then-rotated refresh token is detected as theft and forces re-login across every device the user has open.

- REQ-PIPE-005 retention window and REQ-HIST-001 history window both extended from 7 to 14 days, and a new REQ-HIST-001 AC makes the relationship explicit so the two windows are kept in lockstep — the dashboard, /history page, and tag-railing counts now show twice the lookback before retention sweeps unstarred articles. Starred articles continue to survive indefinitely, unchanged.

- REQ-PIPE-006 AC 7 added: the per-tick token, cost, articles-ingested, and articles-deduplicated counters now advance exactly once per chunk regardless of how many times the queue redelivers that chunk's message, so a flaky tick can no longer inflate the stats widget or history page with retry traffic that was never real LLM work.

- REQ-PIPE-006 AC 4 tightened: once a run leaves running its status is terminal, so the dashboard no longer flips a finished run back to failed when a chunk's last retry exhausts after the run already reached ready, and a delayed success path can't flip a failed run back to ready either.

- REQ-PIPE-008 AC 9 refined: a second transient outage of the run-state store landing inside the same closing handoff (i.e. the lock-clearing rollback itself failing) now records a structured operator-visible log entry naming the stranded lock and the original send error, and the original send error is the one surfaced to the queue retry path so the underlying cause is not masked. The previous wording quietly assumed the rollback always succeeded.

- REQ-PIPE-006 AC 6 added and REQ-PIPE-008 AC 9 added: the history page's per-tick duration no longer drifts forward when the queue redelivers the closing message of a scrape, and a transient queue hiccup at the moment a tick closes can no longer strand the run without its cross-chunk dedup pass — the next redelivery picks up the handoff so the dedup eventually runs and the LLM is never billed twice for the same tick.

- REQ-AUTH-002 AC 4 silent-refresh threshold updated from "less than 15 minutes" to "less than 5 minutes", and now extends across plain page navigation, not just XHR API calls — so users actively reading the dashboard no longer hard-expire after 60 minutes mid-session.

- REQ-OPS-005 added covering the operator force-refresh endpoint that was previously undocumented in the spec — operators can manually trigger a scrape tick from `/settings`, the request reuses any in-flight run started in the last two minutes to absorb double-clicks, and the response is content-negotiated so browsers redirect to `/settings` while operator scripts get JSON.

- REQ-AUTH-001 hardens admin endpoints: `/api/admin/*` now requires Cloudflare Access *and* a valid Worker session *and* an `ADMIN_EMAIL` match, instead of trusting Access alone. Per-route application-layer rate limiting is also added on `/api/auth/*` so a misconfigured WAF rule cannot be abused for abuse-of-OAuth flows.

- REQ-AUTH-007 added (and REQ-AUTH-001 AC 7 removed): signing in via two providers with the same verified email now lands in one account, not two. Existing duplicate-email pairs (the production case where one user signed in via both GitHub and Google) are merged in a single one-time pass so the daily digest goes out once instead of twice.

- REQ-DISC-006 added: stuck tags (no working feeds for more than 7 days) now drop out of the user's interests automatically on the daily retention pass, and the settings page lists the actual stuck tag names instead of just a count so users can see at a glance which tags need attention.

- REQ-DISC-004 AC 4 updated: the bulk "Discover missing sources" endpoint now accepts both POST (settings form submit) and GET (the request shape Cloudflare Access uses after bouncing the click through SSO). Users with Access configured no longer land on a 404 after the post-auth callback — the same outcome banner the POST path produces shows up on /settings.

- REQ-MAIL-001 ACs reworked: source-name labels next to email headlines are gone (Outlook auto-linkified tokens like `cs.AI` into fake links), so the headline is now the only clickable element per row. The signature switches to a webapp-matching footer "Built with Codeflare © 2026 Gray Matter GmbH" with both names linked, and the From header now displays "News Digest <noreply@graymatter.ch>" so inbox lists show the brand instead of the bare email.

## 2026-04-26

- REQ-PWA-001 PWA install/splash artwork now uses the canonical MDI `newspaper` glyph — the same segmented top-edge icon the favicon and top-left in-app brand already use — so the home-screen icon and splash match the running app instead of showing the older filled `newspaper-variant` glyph. The Android home-screen and iOS splash title also shorten from "Digest" to "newsdigest" to mirror the in-app wordmark.

- REQ-READ-007 AC 9 added: tapping a chip already at its destination slot now plays the pop alone — the hold, cascade, and trailing lift are skipped — so the leftmost chip no longer appears to "pulse twice" when re-selected.

- REQ-OPS-004 default Open Graph image switched from SVG to a 1200×630 PNG so Facebook, iMessage, WhatsApp, LinkedIn, and Slack — which silently drop SVG og:images — now render the brand card alongside Twitter and Discord. The SVG remains the master artwork; the PNG is regenerated from it.

- REQ-PIPE-008 added: every scrape tick now runs one post-merge LLM call over the surviving article titles to collapse same-story pairs that slipped through intra-chunk dedup because they landed in different chunks (e.g., TechCrunch and The Verge covering the same announcement). Losers merge into the earliest-published winner — alternative sources, tags, stars, and read marks all re-point to the winner so user state survives the merge. Ticks producing more than 250 articles skip cross-chunk dedup on the tail (token budget cap, documented limitation).

- REQ-MAIL-001 redesigned from a bare static notification into a high-signal daily digest: the subject now carries the unread article count plus the top three tags, the body lists up to five unread headlines linking straight to article detail pages, and a "since midnight" tag tally summarises what arrived in the recipient's local day. The body also shows the current and next send times in the recipient's timezone, includes a "Manage notifications" footer link to settings, and turns the "Gray Matter" signature into a hyperlink to graymatter.ch; recipients with zero unread articles still receive the static-subject fallback so the once-per-day signal is unchanged.

## 2026-04-25

- Admin force-refresh GET now content-negotiates: browsers (and the Cloudflare Access post-auth callback that lands users back as a GET) are redirected to `/settings` with an outcome banner, while scripts that send `Accept: application/json` still receive the JSON status body. Operators no longer land on a raw JSON page after clicking Force refresh.

- REQ-SET-001 AC 5 reworded: the native-form save outcome (success "Saved" or named error) now surfaces inline next to the Save button instead of as a top-of-form banner, and the carrying query parameters are stripped after display so a refresh does not re-show stale text. The 303-redirect contract is unchanged.

- REQ-SET-001 AC 5 extended: native form-POST failures now redirect back to the settings page with an inline error banner naming what went wrong, instead of returning a raw JSON error body the browser would render as plain text on a blank page. Unauthenticated native POSTs redirect to the site root since the settings page would itself bounce them away.

- REQ-SET-001 AC 5 added: the settings save endpoint now accepts a native HTML form submission alongside the JSON API path, so clicking Save persists the user's settings even on browsers where the in-page submit handler has not finished binding (mobile in-app webviews, client-router swap races). Both paths share the same validation and the same Origin check from REQ-AUTH-003.

- REQ-SET-007 AC 6 generalised: new users are seeded with an empty timezone sentinel and the silent auto-correct fires only while that sentinel is in place — any non-empty stored zone (including a deliberate manual UTC pick) is now authoritative and never overwritten. The previous gate keyed on the literal value `UTC` would re-overwrite users who genuinely lived in UTC on every page load.

- REQ-READ-007 cascade easing finalised at `linear` (no more pending-UX-evaluation TODOs). The earlier per-chip ease-IN / ease-OUT logic and its commented-out fallback have been removed; uniform linear easing feels more consistent across chips travelling different distances.

- REQ-SET-007 settings save actually persists now: the form submit handler's selector for the model field only matched a `<select>`, but the field is rendered as a hidden `<input>` whenever the model picker is hidden (the shipped default). Every save POSTed an empty model id, the API rejected the request with `invalid_model_id` BEFORE reaching the timezone UPDATE, and the user record never changed — surfacing as "tz reset to UTC" because the stored UTC seed was never overwritten. Selector widened to match either element; saves now write tz, model, and email preferences as documented.

- REQ-SET-007 root cause finally fixed: `Intl.supportedValuesOf('timeZone')` returns canonical IANA zones only and does NOT include `'UTC'` (it's an alias for `Etc/UTC`, neither of which V8 lists). New users seeded with `tz='UTC'` rendered a settings dropdown where no `<option>` carried the `selected` attribute, so the browser silently fell back to the alphabetically-first option (`Africa/Abidjan`). The next form save POSTed that wrong value to /api/settings, poisoning the user record. Fix: prepend the stored `tzValue` to the option list whenever it's not in the canonical inventory, so the dropdown always has a real selected entry. The two earlier fixes (silent-path gate, picker-value gate) were no-ops because the writer was the form submit and `tzSelect.value` was already `'Africa/Abidjan'` by the time JS read it.

- Article-card tag display filters to the user's active hashtag list. Articles in the global pool can carry tags the current user hasn't selected (the LLM allowlist is the union of `DEFAULT_HASHTAGS` plus any tag with a cached source list, so a recently-dropped default whose KV cache hasn't been swept yet keeps appearing as a valid tag). Surfacing those on cards exposed taxonomy the user explicitly dropped. Filter at render across `/digest`, `/history`, and `/starred`.

- REQ-DISC-004 widened: the "Discover missing sources" section on the settings page now also surfaces user-added tags that have no entry in the curated source registry AND no successful discovery cache yet — previously a manually-added tag with neither a curated source nor a discovered feed was silently hidden, leaving the user with no way to trigger discovery for it. Tags that are covered by curated sources are still never flagged as stuck.

- Default hashtag seed reshaped (count unchanged at 20). Dropped: `workers` (the bare keyword surfaced HR/labour stories instead of Cloudflare Workers technology), `python`, `rust`, `terraform`, `postgres`, `observability` (low-value defaults for the project owner), plus the umbrella terms `ai`, `cloud`, and `microsegmentation` (subset of `zero-trust`). Renamed `agenticai` → `ai-agents` and `genai` → `generative-ai` so the slugs match how news headlines actually phrase the concepts. Added: `appsec`, `coding-agents`, `docker`, `iam`, `siem`, `pqc`, `openziti`, `supply-chain-security`, `gcp` to cover the security + identity + LLM-ops + cloud-vendor topics the project owner actually reads.

- Curated source registry reworked end-to-end (63 sources, every default tag has ≥1 verified source). Removed 15 sources that only served the dropped tags (sre-weekly, grafana-blog, scylladb-blog, postgres-news, rust-blog, python-insider, terraform-registry, railway-blog, go-blog, typescript-blog, bunny-blog, spotify-engineering, supabase-blog, mongodb-blog, redis-blog). Added 16 new sources for the new tags: snyk-blog, portswigger-blog, semgrep-blog, trail-of-bits, auth0-blog, okta-developer, workos-blog, cloudflare-cryptography, sigstore-blog, chainguard-blog, aquasec-blog, elastic-security-labs, sentinelone-blog, security-googleblog, github-copilot-tag, plus three Google News fallback queries (Anthropic, post-quantum cryptography, OpenZiti). Every URL was probed live before commit.

- REQ-SET-007 AC 6 extended to the manual picker: the settings dropdown's browser-detected pre-select now also stops once the stored timezone is anything other than the seeded UTC default. Previously the silent server path was gated correctly but the dropdown UI still flipped to the browser-resolved zone on every page load, so a privacy-masked browser whose Intl returns Africa/Abidjan as a UTC alias would silently re-stamp a deliberate manual choice the next time the user clicked Save.

- SEO + LLM-discovery metadata refresh: page description, og:image:alt, twitter:image:alt, llms.txt and llms-full.txt all updated to reflect the shipped reality (federated GitHub + Google sign-in, every-four-hours scrape cadence instead of hourly, 29-article dashboard cap, accurate cost figure of ~$1.20/day). The browser-tab title for the dashboard is now "Your feed" instead of the legacy "Today's digest" — the global pool is continuous, not date-scoped.

- REQ-READ-003 amended (AC 1–4 reconciliation): read-tracking is now described as a per-(user, article) mark on the global article pool rather than a per-digest UPDATE, matching the shipped behaviour after migration 0003 dropped the digests table.

- End-to-end audit reconciling sdd/ with shipped behaviour: README Vision and Actors row generalised from "GitHub user" to "federated user (GitHub or Google)" so the description matches the multi-provider sign-in shipped on 2026-04-24; an Admin actor row added to cover the Cloudflare-Access-gated operator surface (force refresh, bulk re-discover) that REQ-DISC-004 already implies. Authentication domain header drops the stale "platform-level rate limiting" line (REQ-AUTH-006 is Out of Scope) and REQ-AUTH-004 acceptance criteria are rewritten provider-agnostic so a Google-only or GitHub-only deployment maps onto the same error contract. REQ-AUTH-005 cascade list corrected: digests + articles are no longer per-user rows in the global-feed model, only stars / read-tracking / pending discoveries cascade on account deletion.

- Glossary refresh: stale entries describing the retired per-user digest pipeline (Digest, Generic source, Tag-specific source, Cron dispatcher, Queue consumer, Stuck-digest sweeper, Out-of-band generation, Refresh cooldown, Thundering herd) replaced with terms that match the shipped global-feed pipeline (Article pool, Curated source, Discovered source, Scrape coordinator, Chunk consumer, Discovery drain, Email dispatcher, Stuck tag). Source-health threshold corrected from 2 to 30 consecutive failures (the live REQ-DISC-003 contract); Workers AI entry drops the deprecated user-selectable model wording and reflects the single-global-model production reality. CON-AUTH-001 / Tech Stack table updated to describe federated OAuth/OIDC instead of GitHub-only OAuth.

- REQ-SET-007 amended (AC 1 tightened + AC 6 added): the silent timezone auto-correct now stops touching the user's stored timezone once it is anything other than the seeded UTC default. Previously, every authenticated page load compared browser-resolved tz to stored tz and overwrote the stored value on every mismatch — so a manually-saved zone would be re-overwritten by the next page load if the browser's Intl returned a different value (e.g., privacy-mode browsers that fall back to Africa/Abidjan as a UTC alias). The manual settings picker is now the only path that can change a non-default zone.

- REQ-READ-007 polish (no AC change): desktop / tablet cascade no longer hits the 750ms cap on every tap. The wrap layout has no horizontal scroll so every chip is always visible — the visible-fraction math now detects this case and uses the snappy 200ms floor instead of the slow 750ms cap. Mobile (single-row scrollable strip) is unchanged.

- REQ-READ-007 polish (no AC change): cascade animation duration halved across the board (target/floor/cap all 50% lower) so the slide feels snappier without changing the pop or the hold beat. Total tap-to-settled wall clock drops from ~1400ms to ~1200ms for near chips, and from ~2500ms to ~1750ms for far chips.

- REQ-READ-007 polish (no AC change): cascade animation temporarily uses constant velocity ('linear' easing) instead of the slow-start-fast-end ease-IN curve, pending user evaluation of which feels better.

- REQ-READ-007 polish (no AC change): pop and cascade durations tuned shorter so the tap-to-settled wall clock is roughly halved — pop 700ms→500ms, cascade target/min/max 700/800/3500ms→400/400/1500ms. Same pop/hold/cascade choreography, same easing, just snappier.

- REQ-READ-007 amended (AC 3 + AC 6 unselect symmetry): the cascade now also fires when the user UN-selects a previously selected chip, sliding the chip rightward back to its natural sort position (by article count descending, alpha tiebreak) with the chips it passes sliding leftward to fill the gap on the same pop/hold/duration/easing model. The convenience scroll-down reveal is gated on the chip landing at slot 0 — so unselect cascades, which land mid-railing, do not pull the railing's scroll position.

- REQ-READ-007 amended (AC 3 reshape): cascade duration now scales with the *visible-fraction* of the tapped chip's journey instead of the total travel distance. Earlier scaling held physical velocity uniform but most of a far chip's journey is off-screen — the user's eye still saw the visible portion flash past in 200ms while a near chip's full visible journey took 800ms. New scaling targets a constant on-screen crossing time, so chip 3 and chip 20 both feel the same to track regardless of how far each has to travel.

- REQ-READ-007 amended (AC 3 + AC 6 polish): cascade duration now scales with the tapped chip's travel distance so far hops no longer race past the eye in a blink — short hops stay quick, long hops stretch to a comfortable trackable pace. Plus, the next downward page scroll after a tap smoothly slides the railing back to its leftmost position so the just-selected chip is revealed at the start as the user begins to read the dashboard.

- REQ-READ-007 amended (AC 6 reshape): the tag railing no longer auto-scrolls when the user taps a chip — the chip cascades to data-position 0 in place, so on a horizontally-scrolled mobile viewport the chip may visually exit off the left edge until the user swipes the railing back. The railing's scroll position is preserved across the tap regardless of how it got there.

- REQ-READ-007 amended (AC 1/2 reshape): the tag-railing tap now plays a three-phase choreography — instant scale-bounce pop on the tapped chip, ~1-second hold with the chip visually elevated, then the slow cascade — instead of the prior single fast pulse. The earlier fast pulse looked like teleportation; the deliberate pop + hold + slow slide gives the user time to understand which chip is moving and where it's going.

- REQ-READ-007 added: tapping a chip in the shared tag railing now plays a cascading reorder animation — the tapped chip slides to slot 0 and the chips it passes shift right to fill its old slot, with a brief highlight pulse on tap for input confirmation, a tap lockout while the motion is in flight, and conditional scroll-follow on mobile only when the chip was off-screen.

- REQ-SET-007 amended: the settings page now offers a manual timezone picker pre-populated with the browser-detected zone, so users whose silent auto-sync failed (network error, server error, etc.) can fix their timezone in one click instead of being stuck at UTC.

- REQ-PIPE-007 added: the daily cleanup cron now also deletes orphan tag caches — discovered-feed entries whose tag no user has selected anymore — so a tag a user removed (or an account deleted) stops costing fetch + LLM cycles forever. Tags any user still has are left alone; the deletion count is logged for observability.

- REQ-AUTH-001 reshaped to "sign in with a federated identity provider" — GitHub or Google. The landing page renders one button per provider that has credentials configured, listed alphabetically; no-provider deployments surface a clear configuration message instead of dead buttons. Each provider's account is independent (no cross-provider email merging) and existing GitHub user ids stay in their bare-numeric format so legacy accounts are unchanged.

- Fork-friendly deploy contract: Resend (email) and the dev-bypass token are now genuinely optional — the deploy workflow refuses partial Resend config, skips the secret push when unset, and the runtime email step short-circuits cleanly. A fresh fork only needs four required secrets (Cloudflare, OAuth, APP_URL) to deploy a fully-functional in-app digest; email is opt-in.

- All admin endpoints consolidated under `/api/admin/*` so a single Cloudflare Access wildcard rule gates the entire surface (force-refresh, single-tag re-discover, bulk re-discover, plus any future operator action). The user-facing pages and routes are unchanged; only the operator-only POST URLs moved.

- REQ-DISC-004 AC 1/4 reshaped: the "Stuck tags" UI now surfaces a single "Discover missing sources" button that re-queues every empty-feed tag in one click, instead of N per-tag buttons. The single-tag JSON endpoint stays for scripted callers; the form submission path is bulk-by-default.

- REQ-HIST-002 AC 3 tightened: the Articles-read counter (XX of YY in the stats widget) is now scoped to the user's currently-active tag pool, matching the Articles-total denominator. Reads on articles whose only tag has since been deselected fall out of both numerator and denominator so the ratio always describes the visible pool.

## 2026-04-24

- REQ-PIPE-002 AC 3 tightens the summary length contract from 150–250 to 150–200 words. The earlier 50-word ceiling headroom pushed the model toward padded 230-word summaries that repeated facts; capping at 200 keeps the story tight without touching the 120-word floor that drops malformed output.

- REQ-DISC-004 tightened: the Re-discover affordance now actually exists in the UI (a "Re-discover #{tag}" button under a "Stuck tags" section on /settings, surfacing only for tags whose cached feeds are empty), the endpoint accepts both JSON and native form submissions, and the route is gated by Cloudflare Access at the zone level so only the admin operator can trigger it.

- REQ-DISC-003 un-deprecated and rewritten as a self-healing system: each discovered feed carries a per-URL fetch-failure counter, a URL is evicted from its tag's cache after 30 consecutive failures (about five days at the six-times-daily scrape cadence), and a tag whose cache empties is automatically re-queued for a fresh discovery pass — users never see a permanently empty tag when a feed goes dark.

- REQ-DISC-001 Intent and AC 3 broadened: the discovery prompt now names a Google News query-RSS fallback for tags without a first-party feed, so consumer/brand tags (ikea, tesla, netflix, etc.) produce at least one working source instead of looping through Re-discover with zero results.

- REQ-SET-002 AC 8 rewrote the second settings action as "Delete all tags" (not "Delete initial tags"): one click clears the whole list so a user can build a completely custom set without removing 20 default chips one-by-one. Visibility simplified to "show whenever the user has at least one tag".

- REQ-SET-002 AC 6 raised the hashtag cap from 20 to 25 so a new account, seeded with the 20-default set, has 5 slots of headroom to add custom interests immediately without having to delete a default first.

- REQ-READ-001 AC 5 and REQ-PIPE-001 AC 4 tightened to describe live-feed freshness: the dashboard now orders by "last feed sighting" (re-seen canonical URLs get re-stamped on every scrape tick) rather than first ingestion, so articles currently trending in any feed bubble to the top on every tick and stale items that have fallen out of every feed sink naturally. "Last feed sighting" is defined in the glossary.

- CON-SEC-002 reshaped to reflect the shipped boundary: the pipeline now fetches article bodies directly (HTTPS-only, SSRF-guarded, bounded timeout, size-capped) when a feed snippet is too thin to ground a faithful summary. REQ-PIPE-001 AC 8 adds the matching contract and tests/pipeline/article-fetch.test.ts pins the behaviour.

- REQ-DISC-002 (discovery progress banner), REQ-DISC-003 (feed health tracking), and REQ-SET-004 (model selection) marked Deprecated with Removed In 2026-04-24 — the first two were partially built and no longer worth the maintenance, and model selection has been hidden since the pipeline moved to a single global model.

- REQ-AUTH-006 (WAF OAuth rate limiting), REQ-MAIL-003 (sender-domain verification walkthrough), and REQ-PWA-002 (offline service-worker caching) were never built and have been moved to the Out of Scope list so the active backlog reflects only shipped or about-to-ship behaviour.

- REQ-PIPE-001, REQ-PIPE-006, REQ-SET-007, REQ-PWA-003 promoted from Partial to Implemented — each now has dedicated automated coverage (48-hour freshness-filter regression test; scrape-status endpoint contract + UI indicator tests; browser-tz silent auto-correct assertions against Base.astro; header-control 44×44 tap-target assertions). The four Partials were stale flags; the code had shipped earlier this week.

- REQ-SET-002 AC 8 extended: the settings page now surfaces a companion "Delete initial tags" action next to "Restore initial tags"; Delete strips only the default hashtags from the user's list and leaves custom tags intact. Both buttons render conditionally — Restore hides when every default is already present, Delete hides when the user has no customs, so a list identical to the initials or a list containing only customs surfaces the appropriate subset.

- REQ-READ-001 AC 5 reconciled with shipped ordering: the dashboard's 29 cards are now the most-recently-ingested articles (ingested-at descending, published-at tiebreaker) instead of the most-recently-published. Users see newly-scraped stories at the top of the feed immediately after every tick, even if a backlog item carries a newer source pubDate.

- REQ-PIPE-001 AC 7 added and auto-demoted to Partial: the coordinator now drops candidates whose source publish date is older than 48 hours before the current tick, so stale backlog items never reach the LLM or the dashboard. Candidates with no parsable pubDate are kept (a missing date is not treated as stale). No automated test verifies the drop yet.

- REQ-SET-007 reshaped and auto-demoted to Partial: browser-timezone correction runs silently on every authenticated page (no confirmation banner) so users who sign up and go straight to the reading surface no longer receive their daily email in the wrong local time. No automated test covers the cross-page behaviour yet.

- REQ-HIST-001 AC 7 added: Search & History now carries the same tag railing as the dashboard, scoped to the 7-day window (counts, add/remove, URL `?tags=` state). Selecting a tag renders the same flat grid the search uses, and tag + search filters combine with AND logic so a user can narrow to "cloudflare articles containing 'london'" in one view.

- REQ-HIST-001 AC 4 extended: search queries and tag selections are reflected in the URL (`?q=`, `?tags=`); opening an article from the filtered view and pressing browser Back restores the exact result set.

- REQ-READ-002 AC 4 updated: the article detail "Back" control now returns to the page the user arrived from (search results, starred list, history day view, etc.) rather than always going to the dashboard; direct-link visitors still land on `/digest`.

- REQ-PIPE-002 AC 3 relaxes the summary length contract to 150–250 words across 2 or 3 paragraphs (WHAT / HOW / optional IMPACT) — the earlier "exactly 3 paragraphs, 200–250 words" target over-constrained the model on thinner snippets and produced padded output; the shorter range is easier for the model to hit honestly without fabricating detail.

- REQ-PIPE-002 gains AC 7: every article returned by the LLM echoes its input candidate's index, and the consumer aligns output to input by that echoed value — an article whose summary ever gets stapled to the wrong canonical URL is now a dropped article, not a wire bug shown to users.

- REQ-READ-001 AC 5 cap drops from 50 to 29 articles and gains AC 6: the dashboard grid reserves slot 30 for a "see today in Search & History" tile that deep-links the user to the Search & History page scoped to today's local date.

- REQ-HIST-001 gains AC 6: a date query parameter renders the Search & History page in a focused single-day mode — only that day row, pre-expanded, with a Back control that returns to the full 7-day list.

## 2026-04-23

- REQ-AUTH-001 gains AC 6: new sign-ins land directly on the reading surface with sensible defaults (08:00 scheduled time, UTC timezone that the browser overwrites on first load, email notifications enabled) so a brand-new user sees real articles immediately instead of being detoured through the settings form. REQ-PIPE-006 extended with AC 5 and auto-demoted to Partial: a lightweight scrape-status signal now drives an "Update in progress — X/Y chunks" indicator on both the reading and settings surfaces, replacing the static countdown while a run is in flight; the new AC ships in code but has no automated test yet.

- REQ-READ-001 AC 5 dashboard cap raised from 30 to 50 newest articles so users with broader tag sets see more of each day's ticks without navigating away from `/digest`.

- REQ-DES-001 AC 1 typography surfaces reduced: the serif stack now applies to article titles and long-form reading only; the standalone dashboard digest headline was retired and the brand wordmark (sans stack) now carries that role.

- REQ-PIPE-001 gains AC 6: each candidate's published-at timestamp now reflects the source feed's real publish date, so a three-week-old article is no longer stamped "today" on the dashboard. When the feed provides no usable date, the ingestion time is used as a safe fallback.

- REQ-AUTH-005 AC 2 generalised to cover both transport paths: account deletion now succeeds via both a JSON API request and a native HTML form submission from `/settings`, so users on mobile in-app webviews (which do not reliably dispatch fetch-based DELETE) can still delete their account.

- REQ-PWA-003 AC 3 menu copy updated: the first user-menu entry is now "Search & History" (was "History") to reflect that the destination page supports both day-grouped browsing and keyword search.

- REQ-DES-002 AC 1 extended: anonymous (signed-out) pages now expose the same single-tap theme toggle in the same header position with visually matching styling, so the affordance is identical before and after sign-in.

- REQ-HIST-001 reworked: `/history` search now fires at 3+ characters and renders matches in a flat dashboard-style grid (clearing below 3 chars restores the day-grouped view), and the per-scrape-run tick breakdown is removed from each opened day since the summary row already shows cumulative tokens and cost.

- REQ-DES-002 and REQ-PWA-003 AC 3 updated: the theme toggle moves out of the avatar dropdown into a standalone sun/moon icon placed immediately to the left of the avatar in the header, so dark mode is a single-tap action on every viewport. REQ-PWA-003 gains AC 6 requiring interactive header controls to meet the 44×44 CSS-pixel tap-target minimum on mobile, and the REQ moves from Implemented to Partial until that AC has automated coverage.

- REQ-PIPE-001 cadence changes from hourly to every 4 hours (00/04/08/12/16/20 UTC) — the shared article pool refreshes six times a day instead of 24, cutting global LLM spend by ~4× while staying well above the minimum freshness users care about for tech news. REQ-READ-001 countdown reformatted from "Xm Ys" to "Xm" or "Xh Ym" so the longer inter-tick interval reads naturally on the dashboard header.

- REQ-GEN-002, REQ-GEN-007, and REQ-GEN-008 moved from Implemented to Deprecated, superseded by the global-feed pipeline (REQ-PIPE-001) and the history metrics REQ (REQ-HIST-002); all three carry `Replaced By` and `Removed In: 2026-04-23` fields. REQ-MAIL-002 acceptance criteria rewritten to drop stale references to the retired `digests` table and the magic 5-second timeout, and now explicitly require that one user's failed send never aborts a sibling user's send on the same cron tick and that failed sends do not advance the per-user "last emailed date" marker.

- Promotion sweep after new test coverage: REQ-READ-006, REQ-OPS-004, REQ-PWA-003, and REQ-SET-002 move from Partial to Implemented now that automated tests reference each REQ ID and cover the previously-unverified acceptance criteria. REQ-DISC-002 and REQ-DISC-003 keep Partial status with Notes refined to separate covered AC from deferred scope (tracked in pending.md).

- Post-polish pass: REQ-OPS-004 added for SEO metadata, robots/llms crawler policy, sitemap, and calm 404/500 pages. REQ-READ-006 auto-demoted to Partial — the retired `/digest/failed` + `/digest/no-stories` sub-routes took their tests with them and the newly-shipped 404/500 pages are not yet covered by tests. Operator-only `/force-refresh` endpoint added to kick the hourly coordinator on demand; footer now carries a Swiss Post sponsor block and a Codeflare attribution line. Per-source fetch failures in the coordinator no longer abort the whole run.

- Post-rework promotion sweep: REQ-PIPE-001..006, REQ-STAR-001..003, REQ-READ-001/002/005, REQ-HIST-001/002, REQ-MAIL-001, and REQ-AUTH-001 moved from Planned to Implemented now that the global-feed rework has code and passing tests referencing each REQ ID. REQ-READ-004 (per-user live generation state on `/digest`) marked Deprecated and replaced by REQ-PIPE-001 — the shared article pool removes the need for per-user in-progress polling.

- Global-feed rework: per-user digest generation replaced by an hourly global scrape that writes to a shared article pool filtered per user by active tags. REQ-GEN-* moved to Out of Scope; REQ-PIPE-001..006 introduced; REQ-STAR-001..003 added for the star feature; REQ-READ-001/002/005, REQ-HIST-001/002, REQ-MAIL-001, REQ-SET-004, REQ-AUTH-001 amended.

- REQ-DES-001 AC 1 admits a second, editorial serif font stack (Charter → Iowan → Georgia → Noto Serif → Source Serif Pro, all system-present) for article titles and the dashboard headline; body and chrome stay on the sans stack. Reading surfaces now feel like a magazine — serif headline, small-caps metadata line (SOURCE · DATE · N MIN READ), drop-cap lead paragraph, 62-ch reading measure with hyphenation, and a hairline vertical gradient on cards for a paper-under-lamp dark-mode depth.

- REQ-MAIL-001 extends to manual refreshes: the "your digest is ready" email now fires on both the scheduled-cron trigger and the manual-refresh trigger when `email_enabled = 1`. Manual refreshes take minutes of real time now, so surfacing the completion email gives users a useful "come back to the app" signal instead of needing to keep the tab open.

- REQ-PWA-002 AC 2 changes: `/digest/*` HTML is now served network-first with a short timeout (previously stale-while-revalidate), and the failure page is never served from cache so users always see the latest server state and asset bundle. Offline visitors now see the generic offline banner on the failure route instead of a stale cached copy.

- REQ-SET-002 and REQ-READ-001 gain a tag-filter behaviour: selecting a tag in the reading surface's tag strip inverts its colour and reveals a red × delete affordance, while the digest grid filters to articles whose stored tag list intersects the selection. When nothing matches, a short "no stories match" hint replaces the grid.

- REQ-READ-001 adds a per-card # affordance: tapping it opens a non-interactive popover listing the article's tags, which dismisses itself after 5 seconds.

- REQ-GEN-005 now asks the LLM to write punchy NYT-style headlines (≈45–80 characters, active voice) instead of echoing the source feed, and to emit a per-article tag list validated server-side against the user's current hashtags.

- REQ-DES-001 and REQ-DES-003 return to Implemented now that automated coverage for the Swiss-minimal visual language and the deliberate motion system has landed and is green.

- REQ-SET-002, REQ-READ-001, and REQ-GEN-006 auto-demoted to Partial: newly-added acceptance criteria (tag-strip selection toggle, per-card tag popover, tag filter, default-hashtag seed + restore, per-article tag persistence) ship in code but have no automated test yet.

- REQ-PWA-003 nav simplified: history moves out of the header and into the avatar user menu. The header now shows only the brand and the avatar trigger on every viewport.

- REQ-SET-003 / REQ-SET-004 settings layout refined: the account/delete surface gains a Gravatar tip explaining how the profile picture is fetched, the delete button is rendered as a solid-red primary action, the redundant second Log out button is removed (the user menu already has one), the email-enabled checkbox matches the primary-button colour, and the "Summary" section is renamed "Inference and Notification".

- REQ-READ-006 failure page simplifies to a single Try-again action — the secondary "Go to settings" link is removed and the retry button now always reports its outcome, even after a navigation.

- REQ-PWA-001 AC 2 relaxes from "PNG at 192 / 512 / 512 maskable" to "at least one any-purpose icon and one maskable icon, either PNG at those sizes or scalable SVG with sizes=any". The app ships a scalable SVG newspaper icon that also serves as the install/splash-screen artwork on modern installers.

- REQ-GEN-005 default model changes to OpenAI gpt-oss-120b after the previous llama-3.3-70b-instruct-fp8-fast default turned out to be unreliable for synchronous inference. Users keep the option to pick llama-3.1-8B Fast or Kimi K2.6 in settings.

- REQ-DES-001 and REQ-DES-003 demoted from Implemented to Partial: the code ships the full Swiss-minimal visual language and deliberate motion system, but no automated tests verified the typography scale, focus ring, touch-target minimum, easing curve, or reduced-motion gating. Tests are now in progress; both REQs will return to Implemented once those tests are in and green.

- REQ-GEN-005 and REQ-GEN-002 retuned together: the default model moves to a larger, longer-context option so richer six-article digests fit without truncation, the candidate headline pool tightens to the top 100, and the manual-refresh cooldown shortens to a debounce with a much higher daily ceiling. Users will notice deeper summaries, slightly higher per-digest cost, and far less friction when refreshing.

- REQ-DES-002 (theme toggle) now labels the *target* mode with a paired sun/moon icon rather than the current state, so the menu item reads as an action instead of a status.

- REQ-READ-006 (failure page) Try-again now reports outcomes inline — retrying, rate-limit reason with countdown, or network error — and only navigates to the digest once a new generation is accepted, instead of redirecting to a rate-limited page on 429.

- REQ-GEN-005 (single-call LLM summarization) reshaped to produce richer, deeper digests: up to six articles (down from ten), each with a one-sentence one-liner around 150–200 characters and three paragraph-length detail sections of roughly 200 words each. The model output budget grows accordingly so longer paragraphs are not truncated, and the JSON contract now explicitly accepts already-parsed object payloads alongside strings.

## 2026-04-22

- REQ-SET-002 (hashtag curation) rewritten: tag editing moves out of the settings form and into an inline strip at the top of the reading surface, with an always-visible remove control per tag and an add affordance that expands inline into an input. Every add or remove persists immediately via a dedicated tags write endpoint — no form submit.

- REQ-SET-006 (settings-incomplete gate) narrows: the gate now fires only when the scheduled digest time is not yet set. Having no hashtags no longer blocks the reading surface, because users add their first tag directly on the digest page.

- REQ-SET-003 (scheduled digest time with timezone) updates: the explicit "change" button and dropdown of common zones are removed in favor of fully automatic browser-based timezone detection that also re-syncs on revisit. Server-side contracts (`POST /api/auth/set-tz`, `PUT /api/settings`) are unchanged — only the settings UI control changed.

- REQ-PWA-003 (mobile-first layout) reshaped: the bottom tab bar and left sidebar are removed; all navigation now lives in the header (brand, theme toggle, History icon, avatar user menu) on every viewport. Cleaner on both mobile and desktop.

- REQ-DES-002 (light and dark mode) now requires the server to render the chosen theme on every request so the first byte already carries the correct theme, removing the visible theme flash that appeared on slow connections and preserved-element view transitions.

- REQ-DES-001 (Swiss-minimal visual language) adds a viewport-fill guarantee: short pages fill the mobile viewport and the content surface stays clear of the bottom navigation and device safe-area insets, so the chrome color never dominates the screen.

- REQ-SET-006 (settings-incomplete gate) now requires the global navigation to hide gated destinations during first-run so the user sees only the Settings entry until onboarding is complete.

- REQ-AUTH-003 (CSRF defense) narrows scope to endpoints that act on an authenticated session, and explicitly exempts OAuth flow entry points whose only effect is setting a short-lived state cookie and redirecting to the identity provider. No observable change for signed-in users; clarifies the existing behavior after the login endpoint gained a POST path.

- Feature-complete milestone: 28 requirements across onboarding, source discovery, digest generation, reading, email, and history moved from Planned to Implemented with passing test coverage; source-discovery progress banner (REQ-DISC-002) and feed-health tracking (REQ-DISC-003) land as Partial pending dedicated end-to-end tests.

- Phase 2 (authentication) and Track B (design system, PWA install, observability) shipped: 11 requirements moved from Planned to Implemented with passing test coverage. REQ-PWA-003 (mobile-first safe-area layout) is Partial — code ships but lacks automated tests.

- Initial product specification bootstrapped from `requirements.md` via `/sdd init` with `enforce_tdd: true`. Scope: 10 domains covering authentication, onboarding, source discovery, digest generation, reading, email, history, design system, PWA, and observability.
