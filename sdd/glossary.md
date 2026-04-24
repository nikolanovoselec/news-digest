# Glossary

Canonical definitions for terms used across the spec, code, and documentation. Use these terms consistently everywhere.

| Term | Definition |
|------|-----------|
| **Digest** | A user's curated set of up to 10 articles for a given local date, produced by a single LLM call and stored as one `digests` row + its `articles` rows. |
| **Hashtag** | A lowercase alphanumeric-plus-hyphen interest label (no leading `#` stored) that drives source fetching and LLM ranking. Each user has between 1 and 25. |
| **Generic source** | A search-API-backed source that runs for every hashtag regardless of topic: Hacker News Algolia, Google News RSS, Reddit. |
| **Tag-specific source** | A first-party feed (blog, changelog) discovered once per tag via the LLM and stored in the `sources:{tag}` KV entry. |
| **Pending discovery** | A `(user_id, tag)` row in D1 awaiting LLM-assisted source discovery during the next cron invocation. |
| **Source health** | A KV counter of consecutive fetch failures per feed URL; a feed is evicted after 2 consecutive failures. |
| **Cron dispatcher** | The 5-minute Cron Trigger that runs the stuck-sweeper + discovery processor, then enqueues scheduled digest jobs to the `digest-jobs` Queue. |
| **Queue consumer** | The Worker handler that processes `digest-jobs` messages, runs `generateDigest`, and writes the final atomic batch. |
| **Thundering herd** | The case where many users schedule their digest at the same local time (e.g., 08:00); the Queue absorbs this without overwhelming the isolate. |
| **Stuck-digest sweeper** | SQL executed at the start of every cron run that marks any `in_progress` digest older than 10 minutes as `failed` with `error_code='generation_stalled'`. |
| **First-run mode** | The `/settings?first_run=1` rendering that shows a "Welcome" hero and a "Generate my first digest" CTA; applies until hashtags and digest time are set. |
| **Refresh cooldown** | The 5-minute gap enforced between manual refreshes, in addition to the 10-per-24h cap. |
| **Local date** | The user's current date in their stored IANA timezone, used as the dedupe key for one-digest-per-day. |
| **Session version** | An integer on the users row incremented on logout or account deletion; a JWT whose `sv` claim does not match the current `session_version` is rejected. |
| **Origin check** | The server-side CSRF defense: reject any state-changing request whose `Origin` header is missing or does not match the canonical app origin. |
| **Theme init** | The external `/theme-init.js` loaded with `defer` that reads `localStorage.theme` and sets `data-theme` on `<html>` before CSS resolves. |
| **Swiss-minimal** | The aesthetic style — system font stack, five type sizes, two weights, neutral palette + one accent, no gradients or drop shadows. |
| **Out-of-band generation** | A digest triggered by `/settings` first-run save that runs immediately (not at the scheduled hour) so the user lands on a real digest. |
| **Workers AI** | The Cloudflare LLM inference platform used for digest summarization and source discovery; model selected from the hardcoded `MODELS` list. |
| **ULID** | 26-character Crockford-base32 identifier used for `digests.id` and `articles.id`; sortable by creation time. |
| **Last feed sighting** | The most recent scrape tick at which an article's canonical URL was emitted by any source feed. A newly summarised article's last-feed-sighting equals its first ingestion; re-seen articles are re-stamped on every subsequent tick. The dashboard orders by this value so live feed freshness, not first discovery, drives visibility. |
