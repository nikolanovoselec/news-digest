# Design System

Swiss-minimal aesthetic — system fonts, five type sizes, two weights, neutral palette with one accent, no gradients or drop shadows. Light and dark mode toggled with a single click, persisted in `localStorage`, with a no-FOUC external theme-init script. Motion is deliberate, single-curve, and always respects `prefers-reduced-motion`.

---

### REQ-DES-001: Swiss-minimal visual language

**Intent:** The UI feels calm and content-first rather than decorated, so the digest content is always the focal point.

**Applies To:** User

**Acceptance Criteria:**
1. Typography uses the system font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif`) with five sizes (12, 14, 16, 20, 32 px) and two weights (400 body, 600 headings and labels).
2. The palette is restricted to neutral grays with a single accent color per theme; no gradients or drop shadows appear anywhere in the UI.
3. Inputs render with a minimum 16 px font size to prevent iOS zoom-on-focus.
4. Every interactive element shows a visible focus ring on keyboard focus.
5. All interactive elements have a minimum 44 × 44 pixel touch target.

**Constraints:** CON-A11Y-001
**Priority:** P0
**Dependencies:** None
**Verification:** Manual check
**Status:** Implemented

---

### REQ-DES-002: Light and dark mode with no flash

**Intent:** Users can switch themes with one click, the choice persists across sessions, and the wrong theme never appears on first paint.

**Applies To:** User

**Acceptance Criteria:**
1. The header shows a single theme toggle button with sun and moon icons for the two states.
2. Clicking the toggle toggles `data-theme` on `<html>` between `light` and `dark` and persists the choice to `localStorage.theme`.
3. First-paint theme is resolved by an external `/theme-init.js` loaded with `defer` in the document head before any stylesheet.
4. When no `localStorage.theme` is set, the theme follows `prefers-color-scheme`.
5. CSS custom properties define color tokens per theme: `--bg`, `--surface`, `--text`, `--text-muted`, `--border`, `--accent`.

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
**Verification:** Manual check
**Status:** Implemented
