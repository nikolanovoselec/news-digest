# PWA & Mobile

The app is installable on iOS, Android, and desktop via a standards web manifest. The dashboard requires network on launch — offline content caching is intentionally not in scope (see Out of Scope in the README). Mobile layout respects safe-area insets for the iPhone notch and Android gesture bars. Navigation is consolidated into the header on every viewport — no separate sidebar or bottom tab bar.

---

### REQ-PWA-001: Installable PWA manifest

**Intent:** Users can install the app to their home screen and launch it like a native app.

**Applies To:** User

**Acceptance Criteria:**
1. `/manifest.webmanifest` declares `name`, `short_name`, `description`, `start_url=/digest`, `display=standalone`, `theme_color`, and `background_color`.
2. The manifest's `theme_color` and `background_color` are pinned to the dark-theme background colour so that PWA users in dark mode (the common case for a news reader at the typical reading hours) never see a light-coloured splash or status bar at cold launch or during standalone-mode navigation transitions.
3. Users in light mode see a brief dark splash at cold launch only, after which the runtime theme controls take over and paint the document in their selected theme.
4. The icon set declared in `/manifest.webmanifest` includes at least one icon with `purpose: "any"` and one with `purpose: "maskable"`. Scalable SVG icons (`type: "image/svg+xml"`, `sizes: "any"`) satisfy both requirements; raster PNG icons at 192 × 192 and 512 × 512 also satisfy both requirements. Apple-touch-icon for iOS is referenced from the root layout.
5. Apple meta tags in the root layout set `apple-mobile-web-app-capable=yes`, `apple-mobile-web-app-status-bar-style=black-translucent`, `apple-mobile-web-app-title`, and `apple-touch-icon` (180×180 PNG).
6. iOS Safari users (detected via user agent with `!navigator.standalone`) see a one-time instructional note: "Tap the share icon, then Add to Home Screen."
7. Android and desktop Chrome users see an "Install app" button in `/settings`; click triggers the `beforeinstallprompt` event's prompt.

**Constraints:** None

**Priority:** P1

**Dependencies:** [REQ-DES-001](design.md#req-des-001-swiss-minimal-visual-language)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-PWA-003: Mobile-first responsive layout

**Intent:** The UI feels native on iOS and Android without compromising desktop.

**Applies To:** User

**Acceptance Criteria:**
1. The viewport meta tag on every page is `width=device-width, initial-scale=1, viewport-fit=cover`.
2. The header respects iPhone notches and Android gesture bars via safe-area insets so its controls never sit under system chrome.
3. Navigation is consolidated into the header on every viewport: brand on the left, and on the right a standalone theme-toggle icon immediately followed by an avatar-triggered user menu. The user menu contains a "Search & History" entry, Starred, Settings, and Log out. No separate sidebar or bottom tab bar, and no standalone header buttons beyond the brand, theme toggle, and avatar.
4. Tap highlights are disabled globally; focus and active states are handled by CSS.
5. Interactive header controls (theme toggle, avatar) meet the 44×44 CSS-pixel minimum tap-target guidance on mobile viewports.

**Constraints:** [CON-A11Y-001](constraints.md#con-a11y-001-accessibility-minimum)

**Priority:** P1

**Dependencies:** [REQ-DES-001](design.md#req-des-001-swiss-minimal-visual-language)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-PWA-004: Brand link interaction contract

**Intent:** The header brand is the user's "go home" affordance and behaves predictably under every variant: it returns to the digest as the app home, scrolls to the top when already there, clears any active filter when one is on, never hijacks modifier-clicks meant for new tab / window, and stretches its tap target to fill the left half of the header so the gesture lands on every device.

**Applies To:** User

**Acceptance Criteria:**
1. The digest is the app home and clicking the brand returns to it when signed in.
2. On the unfiltered digest URL, the brand scrolls to the top of the list (a "back to top" affordance) rather than self-navigating.
3. On a filtered digest URL (any query string present), the brand falls through to natural navigation so the filter clears (a "click to reset" affordance).
4. Modifier-clicks (Cmd/Ctrl/Shift/Alt) and non-primary mouse buttons are never intercepted, so "open in new tab/window" continues to work on the brand.
5. The brand tap target stretches to fill the entire left half of the header between the safe-area inset and the right-side controls, with visible content remaining left-aligned so the layout is unchanged.

**Constraints:** [CON-A11Y-001](constraints.md#con-a11y-001-accessibility-minimum)

**Priority:** P1

**Dependencies:** [REQ-PWA-003](#req-pwa-003-mobile-first-responsive-layout)

**Verification:** Integration test

**Status:** Implemented
