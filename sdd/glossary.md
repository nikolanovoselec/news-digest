# Glossary

Canonical definitions for terms used across the spec, code, and documentation. Use these terms consistently everywhere.

| Term | Definition |
|------|-----------|
| **Article pool** | The shared, global article store written by the scrape pipeline and read per-user by tag intersection. Replaces the per-user "digest" concept retired in the global-feed rework. |
| **Hashtag** | A lowercase alphanumeric-plus-hyphen interest label (no leading `#` stored) that drives source fetching and LLM ranking. Each user has between 1 and 25. |
| **Curated source** | An operator-maintained feed entry in the global registry, declaring at least one tag drawn from the system tag list. Replacement is a code change, not a runtime mutation. |
| **Discovered source** | A first-party feed (blog, changelog, or Google News query-RSS fallback) discovered once per tag via the LLM and cached globally for every user who selected that tag. |
| **Pending discovery** | A `(user_id, tag)` row awaiting LLM-assisted source discovery during the next discovery-cron invocation. The 5-minute discovery cron processes up to 3 distinct tags per tick. |
| **Source health** | A per-feed-URL counter of consecutive fetch failures, kept in the eventually-consistent edge cache; a feed is evicted from its tag's cached list after 30 consecutive failures (about five days at the six-times-daily scrape cadence). |
| **Scrape coordinator** | The cron-triggered job that runs every 4 hours (00/04/08/12/16/20 UTC), assembles candidates from the curated source registry plus discovered tag feeds, canonical-URL-dedupes them, and fans chunks of ~100 candidates out to the LLM consumer. |
| **Chunk consumer** | The Worker handler that processes a single ~100-candidate scrape chunk, runs the LLM call, and writes the resulting summaries + tags + cluster groupings into the shared article pool. |
| **Discovery drain** | The 5-minute cron that picks up to 3 pending tags from the discovery queue and resolves their feed URLs via the LLM + SSRF-validated check. |
| **Email dispatcher** | The 5-minute cron that, for every user whose configured local digest time has elapsed today and whose `last_emailed_local_date` is not today, sends one "your digest is ready" notification through the email provider. |
| **First-run mode** | The `/settings?first_run=1` rendering that shows a "Welcome" hero and a "Generate my first digest" CTA; applies until both hashtags and digest time are set. |
| **Settings-incomplete gate** | The middleware redirect that keeps users without a configured digest time on the settings page. Hashtags are NOT part of the gate — they are edited on the reading surface. |
| **Local date** | The user's current date in their stored IANA timezone, used to gate the once-per-day email and the today-scoped deep-link into Search & History. |
| **Session version** | An integer on the users row incremented on logout or account deletion; a JWT whose `sv` claim does not match the current `session_version` is rejected. |
| **Origin check** | The server-side CSRF defense: reject any state-changing request whose `Origin` header is missing or does not match the canonical app origin. |
| **Theme init** | An external script loaded with `defer` from the document head that reads the persisted theme preference and sets the document's theme attribute before CSS resolves, so the first paint never shows the wrong theme. |
| **Swiss-minimal** | The aesthetic style — system font stack, five type sizes, two weights, neutral palette + one accent, no gradients or drop shadows on steady-state surfaces. |
| **Workers AI** | The Cloudflare LLM inference platform used for chunk summarisation and source discovery. Runs on a single global model in production. |
| **ULID** | 26-character Crockford-base32 identifier used for article and scrape-run primary keys; sortable by creation time. |
| **Last feed sighting** | The most recent scrape tick at which an article's canonical URL was emitted by any source feed. A newly summarised article's last-feed-sighting equals its first ingestion; re-seen articles are re-stamped on every subsequent tick. The dashboard orders by this value so live feed freshness, not first discovery, drives visibility. |
| **Stuck tag** | A tag in the user's saved list whose cached feed list is explicitly empty (not "never written"). The settings page surfaces a single "Discover missing sources" button when at least one stuck tag exists. |
