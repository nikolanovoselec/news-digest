# Design System

Swiss-minimal aesthetic — system fonts, five type sizes, two weights, neutral palette with one accent, no gradients or drop shadows. Light and dark mode toggled with a single click, persisted for the browser, and server-rendered on every request so the first byte always carries the correct theme. Motion is deliberate, single-curve, and always respects `prefers-reduced-motion`.

---

### REQ-DES-001: Swiss-minimal visual language

**Intent:** The UI feels calm and content-first rather than decorated, so the digest content is always the focal point.

**Applies To:** User

**Acceptance Criteria:**
1. Typography uses the system font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif`) with five sizes (12, 14, 16, 20, 32 px) and two weights (400 body, 600 headings and labels).
2. The palette is restricted to neutral grays with a single accent color per theme; no decorative gradients or drop shadows appear on steady-state UI surfaces. Motion-driven gradients (e.g., skeleton loading shimmer specifically required by another REQ) are exempt.
3. Inputs render with a minimum 16 px font size to prevent iOS zoom-on-focus.
4. Every interactive element shows a visible focus ring on keyboard focus.
5. All interactive elements have a minimum 44 × 44 pixel touch target.
6. Every page fills the mobile viewport, even when content is shorter than the viewport, so the chrome color never dominates the screen; the top of the content surface stays clear of the header and the bottom stays clear of device safe-area insets.

**Constraints:** CON-A11Y-001
**Priority:** P0
**Dependencies:** None
**Verification:** Integration test
**Status:** Implemented

---

### REQ-DES-002: Light and dark mode with no flash

**Intent:** Users can switch themes with one click, the choice persists across sessions, and the wrong theme never appears on first paint.

**Applies To:** User

**Acceptance Criteria:**
1. The user menu contains a single theme toggle control that labels the *target* mode — when the current theme is light it reads "Dark Mode" and shows a moon icon; when dark it reads "Light Mode" and shows a sun icon. Clicking it performs that switch.
2. Clicking the toggle toggles the theme between `light` and `dark`, persists the choice for the current browser, and propagates the choice to the server so subsequent navigations render the correct theme in the first byte.
3. On every authenticated or anonymous request, the server renders the document root with the user's chosen theme already applied, so the first paint is never the wrong theme even on slow connections or when client-side scripts are deferred.
4. When the user has not yet expressed a preference, the theme follows `prefers-color-scheme`.
5. The theme system exposes a consistent set of color tokens per theme (background, surface, text, muted text, border, accent) as CSS custom properties.

**Constraints:** CON-A11Y-001, CON-SEC-001
**Priority:** P0
**Dependencies:** REQ-DES-001
**Verification:** Integration test
**Status:** Implemented

---

### REQ-DES-003: Deliberate motion system

**Intent:** Animations serve comprehension (orienting, masking latency, rewarding action) and never decorate; motion-sensitive users get an instant UI with zero transitions.

**Applies To:** User

**Acceptance Criteria:**
1. A single easing curve `cubic-bezier(0.22, 1, 0.36, 1)` is used everywhere; durations are 150 ms (micro interactions), 250 ms (components), 400 ms (page transitions).
2. Astro View Transitions handle route changes with a 250 ms cross-fade by default.
3. The digest card → article detail route uses the View Transitions shared-element morph so the card expands into the detail view.
4. All motion is wrapped in `@media (prefers-reduced-motion: no-preference)`; under `reduce`, transitions collapse to instant state changes.
5. Hashtag chip selection, button `:active` press, and card hover (desktop) each have a single, short transition (150–200 ms) on the relevant property only.

**Constraints:** CON-A11Y-001
**Priority:** P1
**Dependencies:** REQ-DES-001
**Verification:** Integration test
**Status:** Implemented
