// Tests for src/pages/history.astro — REQ-HIST-001.
//
// Astro pages can't be fully rendered in a vitest worker without the
// full Astro runtime, so we validate observable contract via `?raw`
// source imports (same pattern used throughout the repo — see
// tests/reading/digest-page.test.ts).
//
// The assertions focus on the observable structure the day-grouped
// layout must satisfy:
//   - the page is grouped by day (<details> + per-day summary) rather
//     than the legacy flat per-digest list
//   - each day row can expand to show ticks + article cards inline
//   - the empty state copy is user-friendly
//   - the UserMenu label still reads "History" (rename to
//     "Search & History" is a future phase)

import { describe, it, expect } from 'vitest';

import historyPageSource from '../../src/pages/history.astro?raw';
import userMenuSource from '../../src/components/UserMenu.astro?raw';

describe('history.astro — REQ-HIST-001', () => {
  it('REQ-HIST-001: Implements REQ-HIST-001 marker is present', () => {
    expect(historyPageSource).toContain('REQ-HIST-001');
  });

  it('REQ-HIST-001: renders a day-grouped list (not a flat per-digest list)', () => {
    // The day-grouped layout iterates `visibleDays.map((day) => ...)`
    // rather than the legacy per-digest iteration, and renders the
    // day's aggregate metrics in a summary row. The variable is
    // `visibleDays` (not `days`) so the deep-link mode can filter
    // the list down to a single day without touching the underlying
    // data source.
    expect(historyPageSource).toMatch(/visibleDays\.map\(\(day\)/);
    expect(historyPageSource).toContain('local_date');
    expect(historyPageSource).toContain('article_count');
    // Legacy shape must be gone — no per-digest iteration, no
    // `digests.map(...)` frontmatter, no Load more pagination hook.
    expect(historyPageSource).not.toMatch(/digests\.map\(/);
    expect(historyPageSource).not.toContain('data-load-more');
  });

  it('REQ-HIST-001: each day row expands to show the day\'s article grid (per-tick detail removed)', () => {
    // Native <details>/<summary> is the expansion mechanism — no JS
    // handler required. Opening a day now reveals just the article
    // grid; cumulative stats (tokens + cost) sit in the summary row,
    // not in a per-tick breakdown.
    expect(historyPageSource).toContain('<details');
    expect(historyPageSource).toContain('<summary');
    expect(historyPageSource).toContain('history__grid');
    expect(historyPageSource).toContain('DigestCard');
    // Regression guard: per-tick list must NOT come back.
    expect(historyPageSource).not.toContain('history__ticks');
    expect(historyPageSource).not.toContain('history__tick-time');
    expect(historyPageSource).not.toContain('data-history-tick');
  });

  it('REQ-HIST-001: search at 3+ chars renders matches in a dashboard-style flat grid', () => {
    // The [data-search-grid] container is the flat-grid surface; the
    // day-grouped <ol data-history-list> hides while it is visible.
    expect(historyPageSource).toContain('data-search-grid');
    expect(historyPageSource).toContain('data-search-empty');
    // Minimum query length — 3 chars — is the contract the user
    // actually cares about (no firing on 1- or 2-letter noise).
    expect(historyPageSource).toMatch(/MIN_QUERY_LEN\s*=\s*3/);
    // Breakpoints of the flat search grid mirror .digest-page__grid.
    expect(historyPageSource).toMatch(
      /\.history__search-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr/,
    );
    expect(historyPageSource).toMatch(
      /@media\s*\(min-width:\s*768px\)[\s\S]*?\.history__search-grid[\s\S]*?repeat\(2/,
    );
    expect(historyPageSource).toMatch(
      /@media\s*\(min-width:\s*1024px\)[\s\S]*?\.history__search-grid[\s\S]*?repeat\(3/,
    );
  });

  it('REQ-HIST-001: search clones cards (not live-moves them) so scroll position is preserved on query change', () => {
    // The `data-bound` clear step is what rebinds star + tag-
    // disclosure handlers on the cloned buttons — without it the
    // clones would be visually present but dead to taps.
    expect(historyPageSource).toMatch(/cloneNode\(true\)/);
    expect(historyPageSource).toMatch(/removeAttribute\('data-bound'\)/);
    expect(historyPageSource).toMatch(/initCardInteractions\(searchGrid\)/);
  });

  it('REQ-HIST-001: cloned cards strip data-astro-transition-scope so they do not collide with the hidden originals in View Transitions', () => {
    // Astro's `transition:name={id}` generates a
    // `data-astro-transition-scope="..."` attribute + a scoped
    // stylesheet rule mapping scope → view-transition-name. The spec
    // requires unique view-transition-name values across participating
    // elements; duplicates silently abort the transition. Since the
    // ORIGINAL card stays in the hidden [data-history-list] while its
    // clone shows in the search grid, the clone must drop the scope
    // to avoid the collision.
    expect(historyPageSource).toMatch(
      /removeAttribute\('data-astro-transition-scope'\)/,
    );
  });

  it('REQ-HIST-001: astro:before-swap + astro:page-load listeners are gated by documentElement flag so returning to /history does not stack handlers', () => {
    // Without this guard, each View-Transitions return re-executes
    // the top-level <script> and adds another before-swap +
    // page-load listener on document — after N visits one input
    // event fires N apply() runs.
    expect(historyPageSource).toMatch(/historySearchBound/);
    expect(historyPageSource).toMatch(
      /dataset\['historySearchBound'\]\s*!==\s*'1'/,
    );
  });

  it('REQ-HIST-001: empty state reads "No articles in the last 7 days."', () => {
    expect(historyPageSource).toContain('No articles in the last 7 days.');
  });

  it('REQ-HIST-001: UserMenu link label reads "Search & History" (route stays /history)', () => {
    expect(userMenuSource).toContain('href="/history"');
    // The label now advertises the search affordance that lives on
    // the /history page. Route is unchanged so bookmarks survive.
    expect(userMenuSource).toMatch(/Search\s*&amp;\s*History/);
  });

  it('REQ-HIST-001 AC 6: reads ?date= query param, validates YYYY-MM-DD, and filters the rendered list to the matching day', () => {
    // Validation regex present.
    expect(historyPageSource).toMatch(/\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
    // Deep-link variable is threaded into the visible-days selection
    // (not into an unrelated block) so a valid date collapses the list.
    expect(historyPageSource).toContain('deepLinkedDay');
    expect(historyPageSource).toContain('visibleDays');
  });

  it('REQ-HIST-001 AC 6: renders a "Back to all days" control in deep-link mode that returns to /history', () => {
    expect(historyPageSource).toContain('history__back');
    // href must strip the query param — the back button is a plain
    // link to the unparamterised route.
    expect(historyPageSource).toMatch(/class="history__back"\s+href="\/history"/);
    expect(historyPageSource).toContain('Back to all days');
  });

  it('REQ-HIST-001 AC 6: in deep-link mode the day row is opened by default and the search input is suppressed', () => {
    // <details ... open={isFocused}> — the isFocused flag controls
    // the open attribute so navigation directly to a day gets it
    // already expanded.
    expect(historyPageSource).toMatch(/<details[^>]*open=\{isFocused\}/);
    // The search input is conditional on !isFocused.
    expect(historyPageSource).toMatch(/\{!isFocused\s*&&\s*\(/);
  });
});
