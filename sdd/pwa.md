# PWA & Mobile

The app is installable on iOS, Android, and desktop via a standards web manifest. A service worker caches the last viewed digest for offline reading. Mobile layout respects safe-area insets for the iPhone notch and Android gesture bars. Navigation is consolidated into the header on every viewport — no separate sidebar or bottom tab bar.

---

### REQ-PWA-001: Installable PWA manifest

**Intent:** Users can install the app to their home screen and launch it like a native app.

**Applies To:** User

**Acceptance Criteria:**
1. `/manifest.webmanifest` declares `name`, `short_name`, `description`, `start_url=/digest`, `display=standalone`, `theme_color`, and `background_color`.
2. The icon set declared in `/manifest.webmanifest` includes at least one icon with `purpose: "any"` and one with `purpose: "maskable"`. Scalable SVG icons (`type: "image/svg+xml"`, `sizes: "any"`) satisfy both requirements; raster PNG icons at 192 × 192 and 512 × 512 also satisfy both requirements. Apple-touch-icon for iOS is referenced from the root layout.
3. Apple meta tags in the root layout set `apple-mobile-web-app-capable=yes`, `apple-mobile-web-app-status-bar-style=black-translucent`, `apple-mobile-web-app-title`, and `apple-touch-icon` (180×180 PNG).
4. iOS Safari users (detected via user agent with `!navigator.standalone`) see a one-time instructional note: "Tap the share icon, then Add to Home Screen."
5. Android and desktop Chrome users see an "Install app" button in `/settings`; click triggers the `beforeinstallprompt` event's prompt.

**Constraints:** None
**Priority:** P1
**Dependencies:** REQ-DES-001
**Verification:** Manual check
**Status:** Implemented

---

### REQ-PWA-002: Offline reading of the last digest

**Intent:** Users can open the installed app on the subway and read the most recently-viewed digest without a network connection.

**Applies To:** User

**Acceptance Criteria:**
1. A service worker (via `@vite-pwa/astro`) caches static assets (JS, CSS, fonts, icons) with a cache-first strategy using hashed filenames.
2. `/digest/*` HTML uses a network-first strategy with a short timeout so a healthy network always serves the latest build, falling back to the cached copy only when the network is slow or unavailable. The failure page is never served from cache — it must always reflect the latest server state and the latest asset bundle, so offline visitors see the generic offline banner instead of a stale failure page.
3. `/api/*` uses a network-first strategy with a 3-second timeout and cache fallback.
4. When `navigator.onLine` is false, a top-of-page banner appears and the "Refresh now" button is disabled with a tooltip.
5. On logout, every runtime cache holding digest content is explicitly deleted so a subsequent user on the same device does not see the previous user's content. The purge iterates all cache names so future runtime-cache version bumps cannot silently leave stale content behind.

**Constraints:** CON-SEC-001
**Priority:** P2
**Dependencies:** REQ-PWA-001
**Verification:** Manual check
**Status:** Planned

---

### REQ-PWA-003: Mobile-first responsive layout

**Intent:** The UI feels native on iOS and Android without compromising desktop.

**Applies To:** User

**Acceptance Criteria:**
1. The viewport meta tag on every page is `width=device-width, initial-scale=1, viewport-fit=cover`.
2. The header respects iPhone notches and Android gesture bars via safe-area insets so its controls never sit under system chrome.
3. Navigation is consolidated into the header on every viewport: brand on the left, and on the right a standalone theme-toggle icon immediately followed by an avatar-triggered user menu. The user menu contains a History entry, Starred, Settings, and Log out — the theme toggle is no longer an item inside the menu. No separate sidebar or bottom tab bar, and no standalone header buttons beyond the brand, theme toggle, and avatar.
4. The digest is the app home; clicking the brand returns to it when signed in.
5. Tap highlights are disabled globally; focus and active states are handled by CSS.
6. Interactive header controls (theme toggle, avatar) meet the 44×44 CSS-pixel minimum tap-target guidance on mobile viewports.

**Constraints:** CON-A11Y-001
**Priority:** P1
**Dependencies:** REQ-DES-001
**Verification:** Integration test
**Status:** Partial
**Notes:** AC 1–5 are covered by tests/pwa/mobile-layout.test.ts; AC 6 (44×44 tap-target minimum on header controls) has no automated test yet.
