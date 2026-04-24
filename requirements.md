# news-digest — requirements (historical)

> **Note**: This document seeded the SDD specification and is kept for reference. The canonical source of truth going forward is [`sdd/README.md`](sdd/README.md) (product intent, requirements, acceptance criteria) and the [`documentation/`](documentation/) folder (implementation docs). Changes to product behavior should land in `sdd/`, not here.

A personalized daily tech news digest. Sign in with GitHub, pick your interests as hashtags, and get an AI-curated digest once per day at a time you choose. No feeds to manage — hashtags drive what gets scraped.

## How it works

1. **Sign in with GitHub** — account is created on first login
2. **Pick your interests** — tap hashtags from 20 defaults or type your own
3. **Set your digest time** — pick exact HH:MM in your timezone; one scheduled generation per day at that moment
4. **Read** — overview grid with one-line summaries, click any card for the full brief with source link
5. **Refresh on demand** — manual "refresh now" button any time

Every digest shows execution time, token count, and estimated cost, so you can see what the LLM actually did.

## Stack

| Layer | Choice |
|---|---|
| Framework | Astro 5 on Cloudflare Workers |
| Theme base | [AstroPaper](https://github.com/satnaing/astro-paper) (MIT, minimal reading surface) |
| Auth | Custom GitHub OAuth + HMAC-SHA256 session JWT (no auth library) |
| Database | Cloudflare D1 |
| Sessions | Stateless JWT in HttpOnly cookie |
| LLM | Workers AI (user-selectable model) |
| Scheduling | Cron Trigger every 5 minutes — dispatches per-user generation jobs to a Queue |
| Queues | `digest-jobs` — cron + manual refresh both enqueue; consumer processes with per-isolate isolation. Natural backpressure under thundering-herd (100 users at 08:00). |
| Email | Resend — "your daily digest is ready" notification after each scheduled run |
| Styling | Tailwind CSS 4 |
| PWA | `@vite-pwa/astro` — manifest, service worker, install prompt |

## Content sources

Sources are a combination of **generic search APIs** (query-based, always run) and **dynamically-discovered tag-specific feeds** (authoritative first-party sources for each tag, discovered on first use and cached).

### Generic sources — run for every hashtag

| Source | Endpoint pattern | Parsing |
|---|---|---|
| Hacker News (Algolia) | `hn.algolia.com/api/v1/search_by_date?query={tag}&tags=story&hitsPerPage=30` | `response.json()` |
| Google News RSS | `news.google.com/rss/search?q={tag}+when:1d&hl=en-US&gl=US&ceid=US:en` | `fast-xml-parser` |
| Reddit | `reddit.com/search.json?q={tag}&t=day&sort=top&limit=25` | `response.json()` — requires `User-Agent: news-digest/1.0` header |

### Dynamic tag-specific source discovery

When a user selects a tag (default or custom), the system discovers authoritative first-party feeds for it. Example: selecting `#cloudflare` discovers `blog.cloudflare.com/rss/` and `developers.cloudflare.com/changelog/index.xml`. Selecting `#langchain` discovers `blog.langchain.dev/rss/`. No hardcoded tag→source map is maintained.

### Discovery flow

Discovery is **fully asynchronous and cron-driven**. Settings save is instant; discovery happens over subsequent cron invocations via D1-queued work. Avoids HTTP-request timeouts.

```
On settings save (onboarding or edit):
  1. Validate + UPDATE users row with new hashtags_json (instant).
  2. For any submitted tag that doesn't yet have a `sources:{tag}` KV entry:
     INSERT OR IGNORE INTO pending_discoveries (user_id, tag, added_at)
     VALUES (?, ?, ?). Composite PK (user_id, tag) makes duplicates silent.
  3. Return 200 { ok: true, discovering: [tag1, tag2, ...] }.

On every 5-min cron invocation (before generation scheduling):
  1. SELECT tag FROM pending_discoveries
     GROUP BY tag
     ORDER BY MIN(added_at)
     LIMIT 3.
     Picks the 3 oldest distinct tags needing discovery across all users
     (shared work — each tag discovered once globally, regardless of how
     many users queued it).
  2. For each: run LLM + validation, write to `sources:{tag}` KV (no TTL).
     DELETE FROM pending_discoveries WHERE tag = ? (removes from ALL users'
     pending lists at once since discovery is global).
  3. A stubborn tag (3 consecutive discovery failures — tracked in
     `discovery_failures:{tag}` KV) is stored with an empty sources array
     `{ feeds: [], discovered_at: now }` and removed from all pending rows.
```

**State machine**: presence of a `(user_id, tag)` row in `pending_discoveries` means "this user is waiting for discovery on this tag". Presence of `sources:{tag}` KV key means "discovered" (the value shape is always `{ feeds: [{name, url, kind}], discovered_at: int }` — empty `feeds` means discovery tried but found nothing). Both stores are strongly consistent.

**UI indicator**: `/digest` fetches `/api/discovery/status` which returns `{ pending: [tag, ...] }` — scoped by user via `WHERE user_id = :session_user_id`. While non-empty, a subtle banner shows "Discovering sources for #{tag1}, #{tag2}… Your next digest will include them."

### New API

| Method | Path | Response |
|---|---|---|
| GET | `/api/discovery/status` | `{ pending: string[] }` — `SELECT tag FROM pending_discoveries WHERE user_id = :session_user_id`; empty array if none |

### First digest after adding a new tag

Uses generic sources only for that tag. Subsequent digests pick up tag-specific sources as discovery completes (typically within 5–15 min of save).

Discovery procedure:
  1. Ask an LLM (default llama-3.1-8b-instruct-fp8-fast for cost):
     System: "You suggest authoritative, stable, publicly accessible
              RSS/Atom/JSON feed URLs for a given technology or topic.
              Only real feeds you are confident exist. Return strict JSON."
     User:   "Topic: '#{tag}'. Return up to 5 feeds as
              [{ name, url, kind: 'rss'|'atom'|'json' }].
              Prefer official blogs, release notes, changelogs over news sites."
  2. For each suggested URL, validate with a GET (5s timeout, 1MB cap):
     - URL passes SSRF filter (HTTPS only, no private/localhost IPs)
     - HTTP 200
     - Content-Type matches kind (xml/atom for rss/atom, json for json)
     - Parse succeeds (fast-xml-parser or JSON.parse)
     - ≥1 item with a title and URL
     URLs failing any check are discarded.
  3. Store validated feeds as `sources:{tag}` in KV with no TTL
     (persist until evidence of staleness). Shape:
     `{ feeds: [{ name, url, kind }], discovered_at: unix_ts }`.
  4. If all suggestions fail, store `{ feeds: [], discovered_at: unix_ts }`;
     a manual "re-discover" button in /settings lets the user retry for a
     stubborn tag.
```

### Cache invalidation — validate on failure, not on a timer

Feed URLs don't rot on a schedule. A blog's RSS feed stays at the same URL for years, then breaks when the site is redesigned or shut down. Time-based TTLs either expire still-working feeds (wasting LLM calls) or keep broken ones too long.

Instead: the digest consumer tracks feed failures inline. If a feed in `sources:{tag}` returns a fetch error or parse error during digest generation, increment an in-memory counter. After 2 consecutive failures across digest runs (tracked in KV `source_health:{url}` with a counter + last_fail_at), the feed is evicted from `sources:{tag}` and the tag is flagged for re-discovery on the next settings save (or via the manual re-discover button).

This approach:
- Cached sources live as long as they work — zero needless LLM calls
- Dead feeds get pruned automatically within a few days
- No time-based cache management code

### Seed at deploy time (optional)

A one-time `npm run seed-sources` script runs discovery for the 20 default tags so new users land with rich sources on their first digest. Optional — the system works without seeding.

### Generation pipeline consumes both

For each user tag, the digest consumer fetches from both pools in parallel:
- Generic sources (always)
- `KV.get('sources:{tag}')` — if present, fan out to those feeds too

Per-hashtag item cap 30 per source (generics) and 20 per source (tag-specific), canonical-URL dedupe across the combined pool. Total headlines sent to the LLM: capped at **300** (prioritizing tag-specific sources first, then generics).

### KV keys

| Key | Value | TTL |
|---|---|---|
| `sources:{tag}` | `{ feeds: [{ name, url, kind }], discovered_at: int }` — empty `feeds` array means discovered-but-no-results | No TTL (evicted on repeated feed failures) |
| `source_health:{url}` | `{ consecutive_failures, last_fail_at }` counter per feed URL | 7 days |
| `discovery_failures:{tag}` | `{ count, last_attempt_at }` | 7 days |
| `headlines:{source_name}:{tag}` | Cached fetch results from a source for a tag, shared across users | 10 minutes |

### Security note on discovered URLs

The same canonicalization rules apply to discovered feed URLs as to article URLs: HTTPS only, reject IP literals / private ranges / localhost during validation. The LLM cannot coerce us to fetch internal addresses because the validation runs before any URL is stored.

Results are canonicalized and deduplicated (see URL canonicalization below), then a single LLM call ranks the top 10 across all hashtags and writes the one-line + longer summary for each.

### URL canonicalization

The consumer never fetches article pages — Workers AI only sees the headline text from search APIs. This eliminates SSRF surface entirely (nothing to redirect-chase).

URLs from the search APIs are canonicalized **string-only** before dedupe:

1. Reject any URL whose scheme is not `https:` or `http:` (the search APIs return http from arXiv occasionally; upgrade to https at canonicalization time).
2. Strip tracking params: `utm_*`, `ref`, `ref_src`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `igshid`, `si`, `source`.
3. Lowercase scheme and host, drop trailing slash on pathname.
4. Dedupe by canonical URL string. Occasional duplicates across mirror domains are acceptable for a daily digest.

Google News URLs redirect through `news.google.com/articles/...` — the `source_url` stored is the Google News URL itself (the browser handles the redirect to the real publisher when the user clicks). No server-side resolution. Simpler, no SSRF risk.

## Default hashtag proposals

Shown as toggleable chips on `/settings` (the same route handles first-run onboarding via `?first_run=1`). User may select any subset and add custom hashtags.

```
#cloudflare  #agenticai  #mcp         #aws            #aigateway
#llm         #ragsystems #vectordb    #workersai      #durableobjects
#typescript  #rust       #webassembly #edgecompute    #postgres
#openai      #anthropic  #opensource  #devtools       #observability
```

### Hashtag input rules

- Allowed characters: `a-z`, `0-9`, `-` (hyphen). Everything else is stripped on submit.
- Normalization: lowercase, strip leading `#` (optional when typing, never stored).
- Min length 2, max length 32 per tag.
- Max 25 tags per user (enforced server-side).
- Deduped before storage.

## Model selection

The settings page renders a dropdown populated from a hardcoded list in `src/lib/models.ts`. No runtime fetch, no KV cache, no Cloudflare API token needed. Updating the list is a code edit + deploy.

### Shape

```ts
// src/lib/models.ts
export type ModelOption = {
  id: string;                       // Workers AI model id
  name: string;                     // Display name
  description: string;              // One-line blurb for the dropdown
  inputPricePerMtok: number;        // USD per million input tokens
  outputPricePerMtok: number;       // USD per million output tokens
  category: 'featured' | 'budget';
};

export const DEFAULT_MODEL_ID = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';

export const MODELS: ModelOption[] = [
  // Featured — quality first
  { id: '@cf/moonshotai/kimi-k2.6', name: 'Kimi K2.6', description: 'Frontier-scale MoE (1T params, 32B active) from Moonshot AI', inputPricePerMtok: 0, outputPricePerMtok: 0, category: 'featured' },
  { id: '@cf/moonshotai/kimi-k2.5', name: 'Kimi K2.5', description: 'Open-source 256k-context large model', inputPricePerMtok: 0, outputPricePerMtok: 0, category: 'featured' },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B', description: 'Strongest Meta model, fast FP8 variant', inputPricePerMtok: 0.293, outputPricePerMtok: 2.253, category: 'featured' },
  { id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', name: 'Llama 3.1 8B Fast', description: 'Default. Good quality at low cost.', inputPricePerMtok: 0.045, outputPricePerMtok: 0.384, category: 'featured' },
  // Budget — cheapest viable options
  { id: '@cf/meta/llama-3.2-1b-instruct', name: 'Llama 3.2 1B', description: 'Cheapest option. Short summaries only.', inputPricePerMtok: 0.027, outputPricePerMtok: 0.201, category: 'budget' },
  { id: '@cf/mistral/mistral-7b-instruct-v0.1', name: 'Mistral 7B', description: 'Balanced small model', inputPricePerMtok: 0.110, outputPricePerMtok: 0.190, category: 'budget' },
  { id: '@cf/meta/llama-3.2-3b-instruct', name: 'Llama 3.2 3B', description: 'Small Meta model', inputPricePerMtok: 0.051, outputPricePerMtok: 0.335, category: 'budget' },
  { id: '@cf/meta/llama-3.2-11b-vision-instruct', name: 'Llama 3.2 11B', description: 'Mid-size Meta model', inputPricePerMtok: 0.049, outputPricePerMtok: 0.676, category: 'budget' },
  { id: '@cf/meta/llama-3.1-70b-instruct-fp8-fast', name: 'Llama 3.1 70B', description: 'Large Meta model, fast FP8', inputPricePerMtok: 0.293, outputPricePerMtok: 2.253, category: 'budget' },
  { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', name: 'DeepSeek R1 32B', description: 'Reasoning-distilled model', inputPricePerMtok: 0.497, outputPricePerMtok: 4.881, category: 'budget' }
];
```

### UI

Dropdown groups by category: "Featured" at top, "Budget" below. Each option shows name, short description, and estimated per-digest cost (based on typical prompt size). Default selection = `DEFAULT_MODEL_ID`.

### Validation

Server-side validation: `model_id` submitted by the client must appear in `MODELS` — reject 400 otherwise. No catalog fetch, no cold-start path, no 503. The list IS the source of truth.

### Maintenance

To add a model: grab the ID from Cloudflare's Workers AI catalog, check pricing at [the pricing page](https://developers.cloudflare.com/workers-ai/platform/pricing/), add an entry to the array, deploy. Kimi K2 prices are not yet published in Cloudflare's per-token table at the time of this spec — set from the changelog / documentation when available.

## Pages

| Route | Purpose |
|---|---|
| `/` | Landing page with "Sign in with GitHub" |
| `/settings` | Unified onboarding + settings. On `?first_run=1`, shows a "Welcome — let's set up your first digest" hero and the submit button reads "Generate my first digest". Once `hashtags_json` and `digest_hour` are set, `?first_run=1` is ignored and normal edit-mode renders (with logout, account deletion, install-app prompt) |
| `/digest` | Today's digest — card grid with one-line summaries, "Refresh now" button, execution/cost footer |
| `/digest/:id/:slug` | Article detail — longer summary with critical points and source link |
| `/history` | Past digests, newest first, 30 per page with a simple "Load more" button |

## Design system

Swiss-minimal aesthetic. Generous whitespace, restricted palette, no gradients, no drop shadows, one accent color. Content is the UI — chrome fades away.

- **Typography**: system font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif`). Five sizes only: `12, 14, 16, 20, 32px`. Two weights: 400 (body) and 600 (headings, labels).
- **Palette**: neutral grays + one accent. Defined as CSS custom properties on `:root` and `[data-theme="dark"]`. Tokens: `--bg`, `--surface`, `--text`, `--text-muted`, `--border`, `--accent`.
- **Light theme**: `--bg: #ffffff`, `--surface: #fafafa`, `--text: #111111`, `--text-muted: #666666`, `--border: #e5e5e5`, `--accent: #0066ff`.
- **Dark theme**: `--bg: #0a0a0a`, `--surface: #141414`, `--text: #f5f5f5`, `--text-muted: #999999`, `--border: #262626`, `--accent: #4d94ff`.
- **Base font size**: 16px on all inputs to prevent iOS zoom-on-focus.
- **Reduced motion**: all transitions wrapped in `@media (prefers-reduced-motion: no-preference)`.
- **Accessibility**: WCAG 2.1 AA floor. Full keyboard navigation, visible focus rings, semantic landmarks, skip-to-content link.

### Dark mode toggle

Single button in the header (sun icon in light, moon in dark). One click toggles the `data-theme` attribute on `<html>` and persists to `localStorage.theme`. Default follows `prefers-color-scheme`.

**Theme init**: `/theme-init.js` loaded in `<head>` with `defer`. Reads `localStorage.theme` (fallback to `matchMedia('(prefers-color-scheme: dark)')`) and sets `document.documentElement.dataset.theme`. A ~50ms theme flash is possible on first page load; trade-off accepted to keep the CSP strict (no inline scripts, no nonce plumbing).

## PWA & offline

Installable on iOS, Android, and desktop. Offline-readable for the last viewed digest.

### Manifest (`/manifest.webmanifest`)

```json
{
  "name": "News Digest",
  "short_name": "Digest",
  "description": "Your daily AI-curated tech news digest",
  "start_url": "/digest",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#ffffff",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

`theme_color` is updated live via JavaScript when the user toggles dark mode so the OS chrome matches.

### Service worker

Provided by `@vite-pwa/astro` (Workbox under the hood). Caching strategies:

| Asset type | Strategy |
|---|---|
| Static (JS, CSS, fonts, icons) | Cache-first, hashed filenames |
| `/digest/*` HTML | Stale-while-revalidate |
| `/api/*` | Network-first, 3s timeout, fall back to cache |
| `/manifest.webmanifest`, `/icons/*` | Cache-first |

The last viewed digest and its article detail pages remain readable offline. `/settings` and the refresh button show an "offline" banner when `navigator.onLine === false`.

**Logout cache clear**: the logout handler redirects to `/?logged_out=1`. The landing page's external script checks for this query param on load and calls `caches.delete('digest-cache-v1')` before rendering. No inline scripts, no postMessage unreliability.

### iOS / Apple meta tags

In the root layout:

```html
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Digest">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
```

### Install prompt

- **Android / desktop Chrome**: listen for `beforeinstallprompt`, stash the event, show an "Install app" button on `/settings`. OS handles repeat-prompt suppression; no per-user state tracking.
- **iOS Safari**: no programmatic prompt available — show a one-time instructional note ("Tap the share icon, then Add to Home Screen") when the app loads on iOS in a non-standalone context.

## Mobile & responsive

Mobile-first layout. Looks native on iOS, Android, and desktop without compromise.

- **Viewport**: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` on every page.
- **Breakpoints**: base (<640px) single-column, `md` (≥768px) two-column digest grid, `lg` (≥1024px) three-column grid with sidebar.
- **Safe-area insets**: sticky header and bottom nav use `padding-top: env(safe-area-inset-top)` / `padding-bottom: env(safe-area-inset-bottom)` for iPhone notches and Android gesture bars.
- **Touch targets**: minimum 44x44px (iOS HIG) / 48x48dp (Android Material) on all interactive elements.
- **Navigation**:
  - Mobile: bottom tab bar (Digest, History, Settings) with safe-area padding. Header shows logo + dark-mode toggle only.
  - Desktop: left sidebar with same three entries plus logout at the bottom.
- **Pull-to-refresh**: native browser behavior on `/digest` (mobile). The "Refresh now" button handles desktop.
- **Input zoom prevention**: all `<input>` and `<textarea>` have `font-size: 16px` minimum on iOS.
- **Tap highlights**: disabled via `-webkit-tap-highlight-color: transparent`; focus and active states handled by CSS.

## Onboarding flow

No dedicated `/onboarding` route. `/settings` IS the onboarding — the same form component renders in "first-run" or "edit" mode based on whether the user has completed initial setup.

```
1. GitHub OAuth callback creates the users row (id, email, gh_login, tz='UTC'
   placeholder, session_version=1).
2. Callback redirects to:
   - /settings?first_run=1 if hashtags_json IS NULL OR digest_hour IS NULL
   - /digest otherwise
3. On /settings page load:
   - If first_run=1 AND settings incomplete → render "Welcome" hero +
     "Generate my first digest" CTA
   - Otherwise render edit-mode with "Save" CTA + logout/delete/install
4. Client posts tz to /api/auth/set-tz on load (validated server-side against
   Intl.supportedValuesOf('timeZone')).
5. Form sections (rendered identically in both modes):
   a. Interests — 20 default hashtag chips, custom text input, min 1 required
   b. Schedule — HH:MM time picker (native <input type="time">). Timezone
      shown with a link "detected Europe/Zurich — change" that opens an
      IANA zone dropdown.
   c. Model — dropdown populated from the `MODELS` constant (grouped
      "Featured" / "Budget"), default pre-selected, collapsible "Advanced"
      disclosure hides this by default.
   d. Email notifications — a single toggle "Email me when my daily digest
      is ready" (default on), collapsible "Advanced" section along with Model.
6. On submit: server validates every field (tz in IANA list, model_id in
   MODELS list from src/lib/models.ts, hashtags against regex). UPDATE users. For first-run,
   trigger the digest pipeline immediately (out-of-band) and redirect to
   /digest with a loading state. For edit-mode, flash "Saved" and stay.
```

### Middleware gating

Every authenticated request checks: if `hashtags_json IS NULL OR digest_hour IS NULL` AND path is not `/settings` or an auth route → redirect to `/settings?first_run=1`. Gating is based on "settings incomplete", not "first digest not yet generated" — a user whose first digest fails is not trapped.

### Timezone handling

Captured at first login from the browser via `Intl.DateTimeFormat().resolvedOptions().timeZone` and stored on the users row. Editable in `/settings` (dropdown of common IANA zones + search), because users travel and the app should not require re-login to adjust. On every authenticated page load, the browser's current tz is compared to the stored value; if they differ, a one-time non-blocking banner offers "Detected Europe/Paris — update your setting?".

All scheduling math uses the stored tz via `Intl.DateTimeFormat` with the `timeZone` option (part of the Workers runtime, no external library needed). DST is handled by computing the next wall-clock hour in the user's tz and converting to UTC via `Intl`.

## Data model (D1)

Identity model: `users.id` IS the GitHub numeric id (as TEXT). There is no separate UUID. The JWT `sub` claim is the same value, so every query path uses one key. This eliminates the footgun where `sub` and `id` could drift.

Foreign keys are declared with `ON DELETE CASCADE`. D1 requires `PRAGMA foreign_keys=ON` to enforce them; this pragma is set on every connection.

```sql
PRAGMA foreign_keys = ON;

-- users.id == GitHub numeric id, stored as TEXT. Single source of identity.
CREATE TABLE users (
  id                          TEXT PRIMARY KEY,
  email                       TEXT NOT NULL,
  gh_login                    TEXT NOT NULL,
  tz                          TEXT NOT NULL,          -- IANA timezone (validated on write)
  digest_hour                 INTEGER,                -- 0-23 local time
  digest_minute               INTEGER NOT NULL DEFAULT 0,  -- 0-59 local time
  hashtags_json               TEXT,                   -- JSON array of strings
  model_id                    TEXT,                   -- Workers AI model id (validated against MODELS list)
  email_enabled               INTEGER NOT NULL DEFAULT 1,  -- 0=off, 1=on; user can opt out of email notifications
  last_generated_local_date   TEXT,                   -- YYYY-MM-DD in user tz; dedup key for scheduled runs
  last_refresh_at             INTEGER,                -- unix ts of most recent manual refresh (NULL if never)
  refresh_window_start        INTEGER NOT NULL DEFAULT 0,  -- start of current rolling 24h window (0 = never opened)
  refresh_count_24h           INTEGER NOT NULL DEFAULT 0,
  session_version             INTEGER NOT NULL DEFAULT 1,  -- bumped on logout/delete to revoke outstanding JWTs
  created_at                  INTEGER NOT NULL
);

CREATE TABLE digests (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date            TEXT NOT NULL,                -- YYYY-MM-DD in user's tz at generation time (unambiguous "today")
  generated_at          INTEGER NOT NULL,
  execution_ms          INTEGER,
  tokens_in             INTEGER,                      -- nullable: model may not return counts
  tokens_out            INTEGER,
  estimated_cost_usd    REAL,                         -- computed at insert from a constants file mapping model_id -> per-Mtok prices
  model_id              TEXT NOT NULL,
  status                TEXT NOT NULL,                -- 'in_progress' | 'ready' | 'failed'
  error_code            TEXT,                         -- sanitized code only (see error handling)
  trigger               TEXT NOT NULL                 -- 'scheduled' | 'manual'
);
CREATE INDEX idx_digests_user_generated ON digests(user_id, generated_at DESC);
CREATE INDEX idx_digests_user_date ON digests(user_id, local_date DESC);

CREATE TABLE articles (
  id              TEXT PRIMARY KEY,                   -- ULID (sortable, 26 chars, generated in-process)
  digest_id       TEXT NOT NULL REFERENCES digests(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL,                      -- URL-safe slug from title, unique per digest
  source_url      TEXT NOT NULL,                      -- canonical, post-resolution URL
  title           TEXT NOT NULL,
  one_liner       TEXT NOT NULL,                      -- <=120 chars, sanitized
  details_json    TEXT NOT NULL,                      -- JSON array of plaintext bullet strings (typically 3 bullets)
  source_name     TEXT,                               -- 'Google News' | 'Hacker News' | 'Reddit' | tag-specific feed name
  published_at    INTEGER,
  rank            INTEGER NOT NULL,
  read_at         INTEGER                             -- unix ts when user first opened the detail view; NULL if unread
);
CREATE UNIQUE INDEX idx_articles_digest_slug ON articles(digest_id, slug);
CREATE INDEX idx_articles_digest_rank ON articles(digest_id, rank);
CREATE INDEX idx_articles_read ON articles(digest_id, read_at);  -- supports "articles read" stats

-- Pending tag discoveries (queue-like; cron processes a few per invocation).
-- Composite PK so each user sees their own pending list while the global
-- `sources:{tag}` cache still dedupes the actual discovery work.
CREATE TABLE pending_discoveries (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, tag)
);
CREATE INDEX idx_pending_discoveries_added ON pending_discoveries(added_at);
CREATE INDEX idx_pending_discoveries_tag ON pending_discoveries(tag);

-- no sessions table: sessions are stateless JWTs in HttpOnly cookies
-- no resolved-URL cache: we never fetch article pages, so no resolution needed
```

**Query discipline**: every query against `digests` and `articles` MUST include `AND user_id = :session_user_id` (or a JOIN that enforces it via `digests.user_id`). This is the only defense against IDOR if a future change introduces a query path that forgets it. Code review must flag any query touching these tables that doesn't scope by user_id.

### ID and slug generation

- `digests.id` and `articles.id`: **ULID** (26-char Crockford-base32, sortable by creation time). Generated in-process via a small helper.
- `articles.slug`: derived from `title` — lowercase, replace non-`[a-z0-9]` runs with `-`, trim hyphens, truncate to 60 chars. On the rare collision within the same digest (same two titles slugify to the same string), append `-2`, `-3`, etc. The `UNIQUE(digest_id, slug)` index enforces uniqueness.

### Migrations

Schema evolution managed via `wrangler d1 migrations`. Migration files live in `migrations/NNNN_description.sql` and are applied with `wrangler d1 migrations apply DB_NAME`. The initial schema above is `0001_initial.sql`.

## Authentication

Custom implementation, no third-party auth library. Pattern lifted from the codeflare repo — proven, ~250 lines of TypeScript, zero ORM or dependency churn.

### Flow

```
/api/auth/github/login
  1. Generate 32 random bytes via crypto.getRandomValues(), base64url-encoded
     (not a UUID — stronger entropy, no structural pattern)
  2. Set oauth_state cookie (HttpOnly, Secure, SameSite=Lax, Path=/, 5 min TTL)
  3. Redirect to github.com/login/oauth/authorize with client_id, redirect_uri,
     scope=user:email, state

/api/auth/github/callback
  1. Validate state cookie === state query param via constant-time comparison
     (reject 403 if mismatch). Clear oauth_state cookie.
  2. POST code to github.com/login/oauth/access_token → access token
  3. GET api.github.com/user and /user/emails in parallel → extract primary
     verified email, numeric id (stringified), login
  4. INSERT OR IGNORE into users (id, email, gh_login, tz, created_at) with
     tz='UTC' placeholder. Other columns (digest_minute, email_enabled,
     refresh_window_start, refresh_count_24h, session_version) take their
     NOT NULL DEFAULT values from the schema. users.id IS the GitHub numeric
     id as TEXT.
  5. Sign HMAC-SHA256 JWT with claims
     { sub: users.id, ghl: gh_login, sv: users.session_version, iat, exp }.
     sv is the session_version at issue time — validation rejects JWTs whose
     sv does not match the current users.session_version.
  6. Set __Host-news_digest_session cookie (HttpOnly, Secure, SameSite=Lax,
     Path=/, no Domain attribute, 1h TTL)
  7. Redirect to /settings?first_run=1 (the app hosts both onboarding and
     settings on a single /settings route — first_run=1 makes the "Welcome"
     hero visible and changes the submit button label).

Tz is NOT carried through the OAuth callback URL (keeps it out of access
logs and browser history). After /settings loads, an authenticated
POST /api/auth/set-tz sends the browser's Intl-detected tz; the handler
validates it against Intl.supportedValuesOf('timeZone') and UPDATEs users.tz.

/api/auth/github/logout
  1. UPDATE users SET session_version = session_version + 1 WHERE id = :sub
     (invalidates every outstanding JWT for this user, including any stolen
     one — a single DB write is the revocation mechanism).
  2. Clear __Host-news_digest_session cookie (Max-Age=0).
  3. Redirect to /?logged_out=1. The landing page's own script calls
     caches.delete('digest-cache-v1') on load when that query param is
     present. Uses the external /theme-init.js sibling file; no inline
     scripts needed.
```

### Cookie hardening

- Cookie name uses the **`__Host-` prefix** — browser enforces `Secure`, `Path=/`, and no `Domain` attribute. This blocks entire classes of cookie-injection attacks (e.g., a subdomain setting a cookie that shadows ours).
- Full attribute set: `__Host-news_digest_session=<jwt>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600`.
- `SameSite=Lax` (not `Strict`) because we need the cookie to accompany the redirect back from GitHub OAuth.

### CSRF protection for state-changing endpoints

Every `POST/PUT/PATCH/DELETE` handler enforces an **Origin check**: reject with 403 if the `Origin` header is missing or not equal to the app's canonical origin. Workers receives `Origin` on every non-GET fetch from browsers. Combined with `SameSite=Lax` on the session cookie, this is the full CSRF defense.

The earlier spec included a double-submit CSRF token cookie. That was dropped: a non-HttpOnly token cookie is XSS-readable, so it adds no defense-in-depth beyond what the Origin check already provides. Invest the effort in XSS prevention (markdown sanitization, nonce-based CSP) instead.

### Session validation

Every protected Astro route and API endpoint calls a shared helper that:

1. Reads `__Host-news_digest_session`.
2. Verifies the HMAC signature with `OAUTH_JWT_SECRET` (constant-time compare).
3. Checks `exp` is in the future.
4. Loads the user row from D1 via `users.id = jwt.sub`.
5. Checks `jwt.sv === users.session_version` — rejects otherwise (revoked token).

Unauthenticated requests redirect to `/`.

### Rate limiting on authentication endpoints

`/api/auth/github/login` and `/api/auth/github/callback` are protected by a Cloudflare WAF rate-limiting rule (configured out-of-band, not in application code): 10 requests/minute per source IP. Prevents account-creation loops and state-cookie flooding. Application-level rate limiting on Workers requires a KV counter per IP, which is noisy — platform WAF is the right layer.

### Session auto-refresh

A middleware runs on every response. If the JWT has less than 15 minutes remaining, it issues a fresh 1-hour JWT and updates the cookie. Users stay signed in as long as they visit at least once per hour.

### OAuth error contract

Failures redirect to `/?error={code}` with one of these allowlisted codes; the landing page renders a human-readable message based on the code.

| Code | Meaning |
|---|---|
| `access_denied` | User clicked "Cancel" on GitHub's consent screen |
| `no_verified_email` | User has no primary + verified email on GitHub |
| `invalid_state` | CSRF state mismatch (possible forgery or expired flow) |
| `oauth_error` | Any other GitHub error — details logged server-side, user sees generic message |

### Account deletion

`/settings` has a "Delete account" button (confirmation dialog required). Endpoint `DELETE /api/auth/account` deletes the users row and cascades to all digests and articles. Session cookie is cleared, user is redirected to `/` with a one-time confirmation banner.

### Secrets

Deployed via `wrangler secret put`:

| Secret | Purpose |
|---|---|
| `OAUTH_CLIENT_ID` | GitHub OAuth App client ID |
| `OAUTH_CLIENT_SECRET` | GitHub OAuth App client secret |
| `OAUTH_JWT_SECRET` | Random 32+ char string for HMAC signing |
| `RESEND_API_KEY` | Resend API key (starts with `re_`) for sending digest-ready notification emails |
| `RESEND_FROM` | Sender address for Resend, e.g., `News Digest <digest@yourdomain.com>` — must match a verified domain |
| `APP_URL` | Canonical app URL (e.g., `https://digest.yourdomain.com`) — used in email CTAs |

### Why no auth library

- Single provider (GitHub), no passwords, no 2FA, no passkeys, no teams — library features we'd never use
- Stateless JWT + 1h TTL means a stolen token dies quickly even without a revocation list
- No ORM dependency pulled in by Better Auth / Auth.js adapters
- If scope later demands multi-provider, passkeys, or session management UI, a one-day migration to Better Auth is bounded — not worth paying that cost up front

## Generation pipeline

Producer/consumer architecture. Cron and the refresh API both **enqueue** messages to `digest-jobs`; the **consumer** processes them with Cloudflare Queues' built-in concurrency and backpressure. Handles the 100-users-at-08:00 thundering herd naturally.

### Cron (every 5 minutes) — dispatcher only

```
1. Cron fires at HH:MM where MM % 5 == 0.
2. Maintenance passes (fast, single queries):
   a. Stuck-digest sweeper: UPDATE digests SET status='failed',
      error_code='generation_stalled' WHERE status='in_progress'
      AND generated_at < (now - 600).
   b. Discovery processor: pick up to 3 distinct tags via
      `SELECT tag FROM pending_discoveries GROUP BY tag ORDER BY MIN(added_at) LIMIT 3`.
      For each: run LLM + validation, write `sources:{tag}` KV, then
      `DELETE FROM pending_discoveries WHERE tag = ?` (removes from all
      users' pending lists since discovery is global).
3. Scheduling pass: for each distinct tz in users:
   a. Compute local_time = now_utc in this tz.
   b. Window = [floor(minute/5)*5, +5) — half-open, non-overlapping.
   c. Query:
      SELECT id FROM users
      WHERE hashtags_json IS NOT NULL
        AND tz = ?
        AND digest_hour = ?
        AND digest_minute >= ? AND digest_minute < ?
        AND (last_generated_local_date IS NULL
             OR last_generated_local_date != ?)
   d. For each matched user, enqueue { trigger: 'scheduled', user_id,
      local_date } to `digest-jobs`. Use sendBatch for efficiency.
4. Cron returns quickly for the dispatch step itself (scheduling pass is <1s — it only runs SELECTs and sendBatch). Maintenance passes (step 2) can take longer: the stuck-digest sweeper is fast (<100ms), but the discovery processor can take up to ~45s when 3 tags are pending (one LLM call + up to 5 validation GETs each). Total cron wall time is bounded at ~1 min on a busy invocation, well within the 15-min budget.
```

### Consumer (`digest-jobs` handler)

Runs with Cloudflare Queues' default concurrency (10 concurrent messages). Each message runs in its own isolate — no shared-memory OOM risk. Backpressure is automatic: 100 messages enqueued at 08:00 process over ~10 minutes naturally.

```
For each message { trigger, user_id, local_date, digest_id? }:
  await generateDigest(user, trigger, digest_id)
Queue retry: 3 attempts on consumer throw. No DLQ (logs suffice).
```
```

No 15-min polling. Each user gets exactly one scheduled job per day, delivered at their local hour.

### Manual refresh (POST /api/digest/refresh)

Handler enqueues and returns immediately. Same consumer handles it.

```
1. Rate-limit check via atomic conditional UPDATE (see rate limits below).
2. Conditional INSERT prevents double-click duplicates:
   INSERT INTO digests (id, user_id, local_date, generated_at, model_id,
                        status, trigger)
   SELECT ?, ?, ?, ?, model_id, 'in_progress', 'manual'
   FROM users
   WHERE id = ?
     AND NOT EXISTS (
       SELECT 1 FROM digests
       WHERE user_id = ? AND local_date = ? AND status = 'in_progress'
     );
   If 0 rows inserted → return 409 already_in_progress.
3. Enqueue { trigger: 'manual', user_id, local_date, digest_id }
   to `digest-jobs` with no delay.
4. Return 202 { digest_id, status: 'in_progress' }.
Client polls /api/digest/:id as before.
```

### `generateDigest(user, trigger, digestId?)` — the one function

```
1. If called from cron (no digestId passed):
   First check: SELECT 1 FROM digests WHERE user_id=? AND local_date=?
   AND status IN ('in_progress', 'ready'). If a row exists → exit (a manual
   refresh may be mid-flight via queue consumer, or today's digest already
   completed; either way, do not start a concurrent generation).
   Otherwise INSERT a new digest row: status='in_progress', trigger='scheduled'.
2. For each hashtag in user.hashtags_json, fan out in parallel:
   - Generic sources (HN, Google News, Reddit) queried with the tag
   - Feeds cached under KV key `sources:{tag}`
   Per-source 5s timeout, 1MB body cap, 30 items (generic) / 20 items
   (tag-specific) per feed. Global concurrency cap 10 across all fetches.
   **Before each fetch**, check KV `headlines:{source_name}:{tag}` — if
   present, use cached results and skip the fetch. Cache TTL 10 minutes.
   At 100 users sharing common tags, cache hit rate is high during hot
   windows (08:00 etc.) — cuts redundant fetches by ~10-20x.
3. Canonicalize + dedupe URLs. Cap pool at 300 headlines, tag-specific first.
4. Single Workers AI call using the prompts from src/lib/prompts.ts
   (see "LLM prompts" section below).
5. Parse JSON strictly. If parse fails: write status='failed',
   error_code='llm_invalid_json', exit.
6. For each article in the response: strip HTML tags, strip control chars,
   collapse whitespace on title, one_liner, and each bullet in details.
   Store bullets as JSON array in articles.details_json. Client renders
   as <ul><li>{bullet}</li></ul> with textContent — XSS-safe by construction.
7-9. Atomic final write via `db.batch([...])` — D1 runs all statements
   in a single transaction. One call, all-or-nothing:
   - INSERT articles (one statement per article, prepared in bulk)
   - UPDATE digests SET status='ready', execution_ms, tokens_in, tokens_out,
     estimated_cost_usd WHERE id=? AND status='in_progress'
   - UPDATE users SET last_generated_local_date=today_local_date
   All succeed together or none are applied. No interactive transactions
   (D1 doesn't support them over its HTTP API).
10. If trigger='scheduled' AND user.email_enabled: send Resend email.
11. All steps wrapped in try/catch. On exception: UPDATE digests
    SET status='failed', error_code=<sanitized> WHERE id=?. Log full error
    to console.log JSON. No automatic retry — user can click Refresh.
```

### Manual refresh rate limits

Triggered from the UI "Refresh now" button. Rate limits are enforced atomically in a single conditional UPDATE on the users row. Concurrent requests from the same user cannot both pass — the UPDATE returns 0 affected rows when the limit is hit:

```sql
UPDATE users SET
  last_refresh_at = :now,
  refresh_window_start = CASE WHEN :now > refresh_window_start + 86400
                              THEN :now ELSE refresh_window_start END,
  refresh_count_24h = CASE WHEN :now > refresh_window_start + 86400
                           THEN 1 ELSE refresh_count_24h + 1 END
WHERE id = :user_id
  AND (last_refresh_at IS NULL OR :now - last_refresh_at >= 300)
  AND (refresh_count_24h < 10 OR :now > refresh_window_start + 86400)
RETURNING refresh_count_24h;
```

Zero rows returned → rate-limited (return 429 with `retry_after_seconds`). One row returned → accepted, INSERT the digest row, enqueue `digest-jobs`, return 202. No read-then-write race.

### Rate-limit UX

When rejected, the API returns `429` with a JSON body `{ error, retry_after_seconds, reason }`. The UI shows a non-blocking toast: "You've hit today's refresh limit — try again in 4h 12m" or "Hold on — you can refresh again in 2:30". The refresh button disables with a live countdown until the cooldown expires.

### Retry strategy

- **Per-source fetch failures**: skip the failing source, proceed with whatever succeeded. Only if ALL sources fail for ALL hashtags → digest status='failed' with error_code='all_sources_failed'.
- **LLM failures**: mark digest failed with error_code='llm_failed'. No automatic retry — the user can click Refresh to try again.
- **No durable retry**. We accept this tradeoff for simplicity: the failure window is narrow (transient LLM hiccups are rare), and users get immediate visual feedback + a Refresh button. No Queue retry machinery.

### Stuck `in_progress` sweeper

If a Queue consumer crashes mid-generation (rare, but Queue retry + isolate eviction can leave rows stuck), the digest row stays `status='in_progress'` and polling hangs. Prevention: the 5-min cron runs a sweep before its scheduling work:

```sql
UPDATE digests
SET status = 'failed', error_code = 'generation_stalled'
WHERE status = 'in_progress' AND generated_at < :now - 600;
```

10-minute staleness threshold — longer than any legitimate generation, short enough that users see a failure and can retry within 10 minutes of the crash.

### Cron/queue race prevention

If a manual refresh's queue consumer is still generating when the user's scheduled HH:MM window hits, cron would otherwise enqueue a second concurrent job. Prevention: the cron scheduling query skips any user who has an in-progress or ready digest for today's local_date (not just 'ready'):

```sql
-- scheduled path: skip if any non-failed digest exists for today
SELECT 1 FROM digests
WHERE user_id = ? AND local_date = ? AND status IN ('in_progress', 'ready')
LIMIT 1;
```

If present → exit. The in_progress manual generation will complete and mark ready; scheduled path acks the slot via `last_generated_local_date` during its normal update cycle (which step 9 handles for both trigger types).

### Error handling

The `error_code` column stores only sanitized short codes (e.g., `llm_timeout`, `llm_invalid_json`, `all_sources_failed`, `rate_limit_hit`). Raw exception messages, HTTP response bodies from external APIs, and stack traces are logged server-side (structured JSON) but never stored in D1 and never returned to the client. The user-facing message is generic: "Something went wrong generating your digest. Try again or check /settings."

### Loading and error states

These are first-class design surfaces, not afterthoughts. Generation takes 2–10 seconds typically, longer on large models — the user should never stare at a blank screen.

**Live generation indicator** (while a digest is being built, whether first-run, scheduled, or manual refresh):

- Full-width indeterminate progress bar at the top of `/digest` with the label "Generating your digest…".
- 10 card skeletons matching real card dimensions (no layout shift when real cards arrive). Shimmer sweep at 1.4s linear gradient, disabled under reduced-motion.
- Footer shows a running clock: "Generating — 3.2s elapsed". Snaps to final execution_ms + token count + cost on completion.
- Client polls `GET /api/digest/:id` every 5 seconds until `status='ready'` (render cards with a staggered fade-in) or `status='failed'` (render the error page layout). Polling stops immediately on status change.

**First-run loading**: identical to above but with a welcome message above the rail — "Welcome, @gh_login. Your first digest is on the way."

**Pending-today state** (user opens `/digest` before today's scheduled time, no live generation in progress): page shows the most recent completed digest (usually yesterday's) with a subtle banner at top: "Next digest scheduled at 08:00 — in 3h 12m. You can also [refresh now]." Banner derives from `/api/digest/today` `next_scheduled_at`. This avoids the silently-bad UX of showing yesterday's content with no indication that today's is coming.

**No stories today**: defined as the LLM returning fewer than 3 articles (post-parsing, post-sanitization). Triggers the "No stories today — try broader hashtags" error page. 3 articles is the minimum threshold because a digest with 1–2 articles looks broken.

**Error pages**: dedicated Astro route components, not inline banners. Every error state uses the same layout (centered content, one-line headline, short explanation, one primary action, one secondary action) for consistency.

| Scenario | Headline | Explanation | Primary action | Secondary action |
|---|---|---|---|---|
| `status='failed'` (generation error) | "We couldn't build your digest" | "Something went wrong on our side. Your settings are safe." | "Try again" (re-triggers pipeline) | "Go to settings" |
| All sources returned zero results | "No stories today" | "None of your hashtags matched fresh articles in the last 24 hours. Try broader tags." | "Edit hashtags" | "Refresh anyway" |
| Rate-limited manual refresh | "Slow down a little" | "You've already refreshed X times today. Next refresh available in Yh Zm." | (disabled until cooldown, live countdown) | "Go to today's digest" |
| Offline | "You're offline" | "Showing the last digest you viewed. We'll reconnect when you're back." | (none — banner is non-modal) | "Retry now" |
| 404 (missing digest) | "Digest not found" | "This digest doesn't exist or has been deleted." | "Today's digest" | "History" |
| 500 (unhandled server error) | "Something broke" | "We've logged it. Try again in a moment." | "Retry" | "Go home" |
| Auth failure (expired/revoked session) | "You've been signed out" | "Sign back in to continue." | "Sign in with GitHub" | (none) |
| OAuth error (`access_denied`, `no_verified_email`, etc.) | Mapped from error code | Human-readable match for the code | "Try again" | "Help" |

**Visual treatment** of error pages: no illustrations, no emoji, no exclamation marks. A single icon (16–20px) in the accent color next to the headline, generous whitespace, monospace for any error code shown in a muted footer. The tone is calm and matter-of-fact — errors happen, the app handles them.

## LLM prompts

All prompts live in `src/lib/prompts.ts`. Kept in one file so iteration is easy and the system/user split is obvious.

### Inference parameters (shared)

```ts
export const LLM_PARAMS = {
  temperature: 0.2,          // low — summaries should be consistent, not creative
  max_tokens: 4096,          // hard cap to prevent runaway generation
  response_format: { type: 'json_object' },  // force JSON on models that support it
};
```

Workers AI returns the response body directly; we parse as JSON with `JSON.parse`. On parse failure, the digest is marked `status='failed', error_code='llm_invalid_json'` — no retry.

### Digest generation prompt

```ts
export const DIGEST_SYSTEM = `You are a tech news curator. Read the list of headlines and pick the 10 most relevant to the user's interests.

Rules:
- Return strict JSON only. No prose, no code fences, no explanations.
- All strings are PLAINTEXT. No HTML, no Markdown syntax, no inline links.
- Rank by relevance to the user's interests, then by recency.
- Skip duplicates, press releases with no substance, and pure advertising.
- If fewer than 10 good matches exist, return fewer — do not pad with weak results.`;

export function digestUserPrompt(hashtags: string[], headlines: Headline[]) {
  return `User interests (hashtags):
\`\`\`
${hashtags.join(', ')}
\`\`\`

Candidate headlines (JSON array):
\`\`\`json
${JSON.stringify(headlines)}
\`\`\`

Return exactly this JSON shape:
{
  "articles": [
    {
      "title": "plaintext title, copy as-is from input",
      "url": "URL from input",
      "one_liner": "plaintext, max 120 chars, the single most important fact",
      "details": ["bullet 1", "bullet 2", "bullet 3"]
    }
  ]
}

Each bullet is a complete plaintext sentence covering a critical point. Exactly 3 bullets per article, no leading "- " or "•" characters.`;
}
```

Fencing (triple backticks) around user-controlled data (hashtags, headlines) limits prompt-injection blast radius — instructions from a hostile article title get read as data, not instructions.

### Source discovery prompt

```ts
export const DISCOVERY_SYSTEM = `You suggest authoritative, stable, publicly accessible RSS/Atom/JSON feed URLs for a given technology or topic.

Rules:
- Return strict JSON only.
- Only suggest feeds you are highly confident exist at the given URL. Do NOT guess.
- Prefer official blogs, release notes, and changelogs over third-party news sites.
- If you are unsure about a feed, omit it — returning fewer correct URLs is better than more guessed URLs.`;

export function discoveryUserPrompt(tag: string) {
  return `Topic: #${tag}

Return up to 5 authoritative feed URLs as:
{
  "feeds": [
    { "name": "Human-readable name", "url": "https://...", "kind": "rss" }
  ]
}

"kind" is one of "rss" | "atom" | "json". If you have no confident suggestions, return { "feeds": [] }.`;
}
```

### Why a single file

- Easy to audit for prompt injection handling (all fencing in one place)
- Easy to iterate when tuning quality
- Easy to version — changing a prompt is a commit; each revision is a rollback point
- No per-user prompt customization in MVP — that's a product-level feature decision, not user-tunable

## Email notifications (Resend)

After every successful scheduled digest (not manual refreshes — the user already saw the result when they clicked), send a "your daily digest is ready" email via Resend. One email per user per day.

### When it fires

Immediately after the consumer commits `status='ready'` for a `trigger='scheduled'` digest AND `users.email_enabled=1`. Manual refreshes do not trigger email. Failed digests do not trigger email. Users who toggle email off in settings never receive one.

Email sending is best-effort: if the Resend API call fails, log the error and continue. The digest itself is still available in the app — email is convenience, not core functionality.

### Email template

Two-part multipart MIME (HTML + plaintext fallback). Matches the app's Swiss-minimal aesthetic: system fonts, generous whitespace, one accent color, no drop shadows, no images.

**Subject**: `Your news digest is ready · {N} stories`

**HTML body** (inlined styles because email clients strip `<style>`):

```html
<!doctype html>
<html>
  <body style="margin:0; padding:48px 24px; background:#fafafa; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif; color:#111;">
    <table role="presentation" width="100%" style="max-width:560px; margin:0 auto;">
      <tr><td style="padding-bottom:32px; font-size:14px; color:#666; letter-spacing:0.02em; text-transform:uppercase;">News Digest</td></tr>
      <tr><td style="padding-bottom:24px; font-size:32px; font-weight:600; line-height:1.2;">Your daily digest is ready</td></tr>
      <tr><td style="padding-bottom:32px; font-size:16px; color:#444; line-height:1.6;">{N} stories curated from your interests: {top-3 hashtags}.</td></tr>
      <tr><td style="padding-bottom:48px;"><a href="{APP_URL}/digest" style="display:inline-block; padding:14px 28px; background:#0066ff; color:#fff; text-decoration:none; font-weight:600; border-radius:6px;">Read today's digest</a></td></tr>
      <tr><td style="padding-top:32px; border-top:1px solid #e5e5e5; font-size:13px; color:#999;">Generated in {execution_s}s · {tokens} tokens · ~${cost}<br><a href="{APP_URL}/settings" style="color:#999;">Edit interests or schedule</a></td></tr>
    </table>
  </body>
</html>
```

**Plaintext body**:

```
Your daily digest is ready.

{N} stories curated from your interests: {top-3 hashtags}.

Read today's digest: {APP_URL}/digest

---
Generated in {execution_s}s · {tokens} tokens · ~${cost}
Edit interests or schedule: {APP_URL}/settings
```

Both bodies use the same variables: `N` (article count), top 3 hashtags joined with `, `, `execution_s` (execution_ms / 1000, 1 decimal), `tokens`, `cost`. `APP_URL` is baked in at deploy time via an env var.

### Resend call

```ts
await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${env.RESEND_API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    from: env.RESEND_FROM,             // e.g., 'News Digest <digest@yourdomain.com>'
    to: [user.email],
    subject: `Your news digest is ready · ${N} stories`,
    html: htmlBody,
    text: plainBody,
    tags: [{ name: 'kind', value: 'daily-digest' }]
  }),
  signal: AbortSignal.timeout(5000)
});
```

On non-2xx response: log `console.log({ level: 'error', event: 'email.send.failed', user_id, digest_id, status, ... })` and move on.

### Secrets

Both values are stored as GitHub repo Secrets (Settings → Secrets → Actions) AND pushed to Cloudflare as Worker secrets during deploy:

| Repo Secret | Worker Secret | Purpose |
|---|---|---|
| `RESEND_API_KEY` | `RESEND_API_KEY` | Resend API key (starts with `re_`) |
| `RESEND_FROM` | `RESEND_FROM` | Sender address, e.g., `News Digest <digest@yourdomain.com>` |

The deploy GitHub Actions workflow syncs both into the Worker:

```yaml
- name: Push Resend secrets to Worker
  run: |
    TMP=$(mktemp) && echo -n "$RESEND_API_KEY" > "$TMP" && npx -y wrangler secret put RESEND_API_KEY < "$TMP" && rm "$TMP"
    TMP=$(mktemp) && echo -n "$RESEND_FROM" > "$TMP" && npx -y wrangler secret put RESEND_FROM < "$TMP" && rm "$TMP"
  env:
    RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
    RESEND_FROM: ${{ secrets.RESEND_FROM }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

File-redirect form (not pipe) per the standard secret-injection pattern — pipes can silently store empty values in some CI environments.

### Sender domain

Resend requires a verified sending domain. Configure in Resend dashboard by adding DNS records for the domain that will appear in `RESEND_FROM`. Until verification completes, emails send from Resend's default sandbox address.

## Cost and time transparency

Every digest view renders a footer like:

```
Generated 07:59 CET  ·  2.4s  ·  3,847 tokens  ·  ~$0.0012  ·  llama-3.1-8b-instruct-fast
```

Values come from the `execution_ms`, `tokens_in + tokens_out`, and `model_id` columns on the digest row. Cost is computed from the model's published per-token price.

## Motion & polish

High-class polish is part of the MVP, not a later pass. Every transition has a purpose — orient the user, mask latency, or reward an action. All motion respects `prefers-reduced-motion: reduce` and collapses to instant state changes.

### Foundations

- **Easing**: one curve everywhere, `cubic-bezier(0.22, 1, 0.36, 1)` (sharp start, soft finish). Durations: 150ms (micro), 250ms (component), 400ms (page).
- **Astro View Transitions API**: enabled globally. Route changes cross-fade by default; specific elements use `transition:name` for shared-element morphs (digest card → article detail view).
- **No motion library**: pure CSS + Astro's built-in transitions. If a specific interaction needs more (spring physics, FLIP), add `motion` (Motion One, ~3KB) — not Framer Motion.

### Cascading content reveals

- **Digest grid entrance**: each card fades in + rises 8px, staggered by 40ms (`animation-delay: calc(var(--i) * 40ms)`). Stops at 10 cards so the last one lands within 400ms.
- **Article detail**: title, then summary paragraph, then bullet list, each staggered 80ms. Source link draws in last with a subtle underline-expand.
- **History list**: rows stagger-fade at 30ms intervals.
- **Settings form**: each section (interests, schedule, model) slides up 12px with 100ms stagger on first paint.

### Skeleton loaders (LLM generation)

- **Card skeletons** match real card dimensions exactly so there's no layout shift. Shimmer runs as a 1.4s linear-gradient sweep (disabled under reduced-motion).
- **Manual refresh**: button morphs into an indeterminate progress bar while the job is in flight. On completion, the bar fades out and new cards fade in.

### Micro-interactions

- **Buttons**: `transform: scale(0.97)` on `:active`, 100ms.
- **Hashtag chips**: selecting scales from 1 → 1.1 → 1, with accent color fill sweeping in from left to right (150ms).
- **Theme toggle**: instant swap of the `data-theme` attribute with a 150ms cross-fade on the `color` and `background-color` properties. No circular wipe — View Transitions API for this single element adds complexity without proportionate value.
- **Card hover (desktop)**: lift 2px + border shifts to accent color, 200ms.
- **Link underlines**: animate stroke from 0 to 100% width on hover, 200ms.

### First-run choreography

- **Step entrance**: each of the three sections (Interests → Schedule → Model) fades in sequentially with 100ms stagger on first paint. A subtle left-side rail visualizes progress.
- **Submit button**: on click, "Generate my first digest" disables and shows an inline spinner while the out-of-band generation kicks off and the redirect to `/digest` fires.

### Page transitions

- **Route changes**: Astro View Transitions cross-fade at 250ms.
- **Digest card → Article detail**: shared-element morph — the card expands into the detail view's hero block using View Transitions' `transition:name`. Back button reverses it.
- **Route failures**: full-screen fade to a minimal error state with a "return home" action.

### Cut from scope (previously specified, removed as decorative)

Number count-up animations, typing effect for "Detected: Europe/Zurich", particle burst on chip tap, SVG checkmark draw animation, circular wipe theme transition, haptic feedback via `navigator.vibrate`. These were polish-for-polish's-sake. The earned motion above is the complete spec.

## What is explicitly out of scope for MVP

- Multiple digests per day (one scheduled run plus rate-limited manual refreshes is the model)
- Slack, Telegram, or RSS output (email is the only notification channel)
- OPML import, user-added feeds
- Sharing, bookmarking, cross-user recommendations
- Embeddings or vector search (single LLM call handles ranking)
- R2 archive of digest HTML (D1 stores sanitized HTML directly; digests are small)
- Fetching article page bodies (summaries derive from search-API headlines+snippets)

These may be revisited after v1 ships.

## HTTP API

All mutating endpoints require an authenticated session (valid `__Host-news_digest_session` cookie with matching `session_version`) AND an `Origin` header equal to the app's canonical origin. All response bodies are JSON unless otherwise noted. Error responses use `{ error: string, code: string, ... }`.

### Auth

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| GET | `/api/auth/github/login` | — | 302 to github.com; sets `oauth_state` cookie | — |
| GET | `/api/auth/github/callback?code&state` | — | 302 to `/settings?first_run=1` or `/digest`; sets session cookie | 403 `invalid_state`; 302 `/?error=<code>` |
| POST | `/api/auth/github/logout` | — | 200 HTML page that clears SW cache and redirects | 401 if not authenticated |
| POST | `/api/auth/set-tz` | `{ tz: string }` | `200 { ok: true }` | 400 `invalid_tz`; 401 |
| DELETE | `/api/auth/account` | `{ confirm: "DELETE" }` | `200 { ok: true }` (also clears cookie, bumps session_version) | 400 `confirm_required`; 401 |

### Settings

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| GET | `/api/settings` | — | `{ hashtags: string[], digest_hour: int, digest_minute: int, tz: string, model_id: string, email_enabled: bool, first_run: bool }` | 401 |
| PUT | `/api/settings` | `{ hashtags, digest_hour, digest_minute, model_id, email_enabled }` | `{ ok: true, discovering: string[] }` — `discovering` lists any newly-added tags awaiting discovery | 400 `invalid_hashtags` \| `invalid_time` \| `invalid_model_id` \| `invalid_email_enabled`; 401 |
| GET | `/api/discovery/status` | — | `{ pending: string[] }` — `SELECT tag FROM pending_discoveries WHERE user_id = :session_user_id` | 401 |
| POST | `/api/discovery/retry` | `{ tag: string }` | `{ ok: true }` — verifies tag is in the user's hashtags_json, DELETEs `discovery_failures:{tag}` and `sources:{tag}` KV entries, INSERTs a fresh `pending_discoveries` row. Next cron picks it up. | 400 `unknown_tag` (tag not in user's hashtags_json); 401 |

### Digest and refresh

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| GET | `/api/digest/today` | — | `{ digest: {...} \| null, articles: [...], live: bool, next_scheduled_at: int \| null }`. Query: `SELECT * FROM digests WHERE user_id = :session_user_id ORDER BY generated_at DESC LIMIT 1`. `live=true` if that row has `status='in_progress'`. If `local_date != today_in_user_tz`, compute `next_scheduled_at` from user's `digest_hour:digest_minute` in their tz. | 401 |
| GET | `/api/digest/:id` | — | Same shape as `/today`, for a specific digest | 401; 403 `not_yours` (shouldn't happen — filtered by query); 404 |
| POST | `/api/digest/refresh` | — | `202 { digest_id, status: 'in_progress' }` — handler does a conditional INSERT (0 rows → 409), enqueues `{ trigger: 'manual', user_id, local_date, digest_id }` to the `digest-jobs` queue, returns 202. Consumer runs `generateDigest(message)`. | 401; 429 `rate_limited` `{ retry_after_seconds, reason: 'cooldown' \| 'daily_cap' }`; 409 `already_in_progress` — returned when the conditional INSERT matches 0 rows because an in-progress digest already exists for this user's local_date today |

### History and stats

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| GET | `/api/history?offset=0` | query: `offset` (default 0) | `{ digests: [{ id, generated_at, status, execution_ms, tokens_in, tokens_out, estimated_cost_usd, model_id, article_count }], has_more: bool }` (30 per page; `article_count` via `(SELECT COUNT(*) FROM articles WHERE digest_id=d.id)` subquery in the SELECT) | 401 |
| GET | `/api/stats` | — | `{ digests_generated, articles_read, articles_total, tokens_consumed, cost_usd }` | 401 |

### Client-side polling during generation

No SSE, no WebSocket, no cancel endpoint. While a digest is `status='in_progress'`, the client polls `GET /api/digest/:id` every 5 seconds until it returns `status='ready'` or `'failed'`. Typical wait is ~60 seconds. The loading UI shows a skeleton grid + an indeterminate progress bar; on status change, real cards render with staggered fade-in.

**Why polling is enough**: the primary completion signal for scheduled digests is the email — users get "your digest is ready" and open the app when it's already done. Polling only matters for the rare case where the user clicks Refresh and waits on the page. 5-second interval × 60s = 12 tiny requests, negligible overhead and no architectural plumbing.

## User stats widget

A compact stats widget rendered in the header of `/settings` (and optionally repeated at the top of `/history`). Four tiles, each a big number + small label, pulled from a single D1 query.

All stats queries are returned by a single `GET /api/stats` that runs these queries in parallel (all IDOR-safe: every article query JOINs to digests and filters by `d.user_id=?`):

| Tile | Source | Example |
|---|---|---|
| Digests generated | `SELECT COUNT(*) FROM digests WHERE user_id=? AND status='ready'` | `142` |
| Articles read / total | Read: `SELECT COUNT(*) FROM articles a JOIN digests d ON a.digest_id=d.id WHERE d.user_id=? AND a.read_at IS NOT NULL`. Total: `SELECT COUNT(*) FROM articles a JOIN digests d ON a.digest_id=d.id WHERE d.user_id=?`. Rendered as `{read} of {total}`. | `318 of 1,420` |
| Tokens consumed | `SELECT COALESCE(SUM(tokens_in+tokens_out),0) FROM digests WHERE user_id=? AND status='ready'` | `482,193` |
| Cost to date | `SELECT COALESCE(SUM(estimated_cost_usd),0) FROM digests WHERE user_id=? AND status='ready'` | `$0.14` |

### Tracking "read"

Add `read_at INTEGER` (nullable) to the articles table. The `/digest/:id/:slug` Astro page loader marks read directly in its server-side fetch: the same query that loads the article also runs `UPDATE articles SET read_at = :now WHERE id = :id AND digest_id IN (SELECT id FROM digests WHERE user_id = :session_user_id) AND read_at IS NULL`. No separate API endpoint. The scoped subquery enforces user_id — IDOR-safe.

Clicking the source link does NOT mark read — only opening the detail view counts as engagement.

### Widget implementation

No third-party charting/dashboard library. The widget is a single Astro component (~40 lines) rendering four tiles in a CSS grid. For a solo tool, pulling in `recharts`, `nivo`, `apexcharts`, or `shadcn/ui` is unjustified weight. Tailwind utility classes handle the styling; the "big number + small label" pattern is trivial to build and looks better hand-tuned than any library default.

Optional v1.1: a sparkline next to each tile showing the last 30 days. Pure SVG, ~20 lines — not a library. Skip for MVP.

### My take on this requirement

**Worth it.** Stats add personal value, make the app feel like yours, and cost very little to implement (one SQL query, one component, one new column). The "articles read" tile is the most valuable because it's the only stat that measures engagement rather than volume — it tells you whether the digests are actually useful. Keep it to four tiles; resist the urge to add charts, streaks, leaderboards, or "top hashtag this week" — those are v2 decisions.

## Security headers

Every response includes these headers, set by a Cloudflare Worker response middleware:

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://github.com` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `geolocation=(), microphone=(), camera=(), payment=(), clipboard-read=()` |

**No inline scripts**: the theme-init script is served as an external file `/theme-init.js` with `defer` in the `<head>`. A small flash of the wrong theme is possible on first paint; it's a ~50ms visual blip, acceptable in exchange for a strict no-inline-scripts CSP. All client code lives in external modules served from `'self'`. `'unsafe-inline'` remains on `style-src` because Astro's scoped component styles require it; CSS injection is low-severity and there is no client-side HTML rendering to amplify it.

**CSP works end-to-end** because the app makes NO off-origin browser-side fetches. All external APIs (GitHub, Resend, Cloudflare, search APIs) are called only from the Worker. The service worker is registered from the same origin (`navigator.serviceWorker.register('/sw.js')`), which `connect-src 'self'` permits. GitHub OAuth uses a top-level navigation (not a fetch), which CSP does not restrict — `form-action 'self' https://github.com` covers the POST from the OAuth consent screen.

`X-Frame-Options: DENY` is not emitted; CSP `frame-ancestors 'none'` supersedes it in all modern browsers.

## Observability

Structured JSON logs only. No Analytics Engine, no Logpush, no separate metrics pipeline — Cloudflare Logs surface `console.log` output as queryable fields, which is sufficient for a solo tool.

Every log line emits `console.log(JSON.stringify({ ts, level, event, user_id?, ...fields }))`. The events worth logging:

| Event | Purpose |
|---|---|
| `auth.login` | `{ user_id, gh_login, new_user, status: 'success'\|'failed', error_code? }` |
| `digest.generation` | `{ user_id, digest_id, trigger, status, execution_ms?, tokens_in?, tokens_out?, article_count?, error_code? }` |
| `source.fetch.failed` | `{ source_name, hashtag, http_status?, error_code }` |
| `refresh.rejected` | `{ user_id, reason: 'cooldown'\|'daily_cap', retry_after_seconds }` |

Internal error details (exception messages, response bodies) are logged at `level: 'error'` but never stored in D1 and never returned to clients. Adding an aggregation layer later is a one-commit change — not needed up front.

## History pagination

`/history` renders the 30 most recent digests newest first with a "Load more" button that extends the list by 30. Query: `SELECT ... FROM digests WHERE user_id = :session_user_id ORDER BY generated_at DESC LIMIT 30 OFFSET :offset`. Simple offset pagination — a solo user will accumulate at most ~365 digests per year, so the duplicate-risk scenarios that justify cursor pagination do not apply.

## Deployment

Cloudflare Workers. Cron Trigger every 5 minutes in `wrangler.toml` (`crons = ["*/5 * * * *"]`). D1, KV (discovered sources cache + source_health + headline cache), and a single Queue `digest-jobs` (default 3-retry, no DLQ) bindings provisioned via `wrangler`. GitHub OAuth client ID/secret, `OAUTH_JWT_SECRET`, `RESEND_API_KEY`, `RESEND_FROM`, and `APP_URL` configured as Worker secrets. Schema migrations applied with `wrangler d1 migrations apply`.

## Scale and tradeoffs

**Target: ~100 users.** Architecture chosen to handle the worst realistic case: all 100 users pick the same scheduled time (thundering herd).

### What's sized for 100-user scale

| Component | Sizing | Why |
|---|---|---|
| `digest-jobs` Queue | Default concurrency 10, 3 retries, no DLQ | 100 concurrent enqueues processed in ~10 min; Queues handle backpressure. |
| Cron = dispatcher only | <1s per invocation regardless of user count | Generation happens in Queue consumer, isolated per message. |
| `headlines:{source}:{tag}` cache | 10-min TTL | In a hot window, 30 users with `#cloudflare` produce 1 cache write + 29 reads, not 30 full fetches. |
| Consumer isolate memory | ~5MB per digest, each in own isolate | No shared-memory OOM from batching. |
| Workers AI | Paid plan required at 100 users/day (~$16/month Neurons) | Free tier (10K Neurons/day) only covers ~20 digests. |
| Resend | Paid plan (~$20/month) | Free tier is 100/day — borderline; Pro gives deliverability + monitoring. |

### Known tradeoffs (accepted)

| Tradeoff | Why it's fine at 100 users | Migration path if scale grows |
|---|---|---|
| Reddit + Google News from Cloudflare IPs | Some requests may throttle. 3 generic sources + per-tag discovery means partial coverage is fine. Logs track `source.fetch.failed`. | Switch to Brave Search API or Tavily (one-file change in `src/lib/sources.ts`). |
| Discovery cron-serial (3 tags per 5-min) | 100 users × ~2 new unique tags each = 200 total over lifetime. Processes in ~6 hours of operation. | Dedicate a discovery consumer Worker or use Queues for discovery too. |
| D1 single-region write | D1 handles ~1K writes/sec; 100 users generates ~1K writes/day total. | Shard users across D1 databases or add read replicas. |
| No DLQ on digest-jobs | 3 Queues retries + structured logging catches failures. DLQ inspection adds ops burden. | Add DLQ + admin UI when failure rate warrants it. |

## Scaffolding order

When implementation starts, build in this order — each layer unblocks the next:

1. `migrations/0001_initial.sql` — the D1 schema from the Data model section
2. `src/lib/db.ts` — D1 wrapper with `PRAGMA foreign_keys=ON`, prepared statements, a `batch()` helper for atomic multi-statement writes (D1 does NOT support interactive transactions — use `db.batch([stmt1, stmt2])` for atomicity)
3. `src/lib/models.ts` — MODELS constant + DEFAULT_MODEL_ID
4. `src/lib/prompts.ts` — DIGEST_SYSTEM, DISCOVERY_SYSTEM, helper functions, LLM_PARAMS
5. `src/lib/session-jwt.ts` — HMAC-SHA256 sign/verify (lift from codeflare)
6. `src/pages/api/auth/github/{login,callback,logout}.ts` — OAuth flow
7. `src/middleware/auth.ts` — session validation with session_version check
8. `src/pages/settings.astro` + `PUT /api/settings` — form component that handles both onboarding and edit
9. `src/lib/sources.ts` — generic sources + discovery logic
10. `src/lib/generate.ts` — `generateDigest(user, trigger, digestId?)`
11. `src/pages/api/digest/refresh.ts` — POST handler with rate limit + enqueue to `digest-jobs`
11b. `src/queue/digest-consumer.ts` — Queue consumer that calls `generateDigest(message)`
12. `src/pages/digest.astro` — overview grid with polling
13. `src/pages/digest/[id]/[slug].astro` — detail view (marks read)
14. `src/pages/history.astro` + `GET /api/history`
15. `src/worker.ts` cron handler — sweeper + discovery processor + dispatcher (enqueues to `digest-jobs`; does NOT generate inline)
16. `src/lib/email.ts` + Resend integration
17. PWA manifest + service worker + icons
18. Polish (animations, stats widget, install prompt)
