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
    // The day-grouped layout iterates `days.map((day) => ...)` rather
    // than the legacy per-digest iteration, and renders the day's
    // aggregate metrics in a summary row.
    expect(historyPageSource).toMatch(/days\.map\(\(day\)/);
    expect(historyPageSource).toContain('local_date');
    expect(historyPageSource).toContain('article_count');
    // Legacy shape must be gone — no per-digest iteration, no
    // `digests.map(...)` frontmatter, no Load more pagination hook.
    expect(historyPageSource).not.toMatch(/digests\.map\(/);
    expect(historyPageSource).not.toContain('data-load-more');
  });

  it('REQ-HIST-001: each day row can expand to show ticks + article cards', () => {
    // Native <details>/<summary> is the expansion mechanism — no JS
    // handler required. The body contains both the tick list and a
    // DigestCard grid.
    expect(historyPageSource).toContain('<details');
    expect(historyPageSource).toContain('<summary');
    expect(historyPageSource).toContain('history__ticks');
    expect(historyPageSource).toContain('history__grid');
    expect(historyPageSource).toContain('DigestCard');
  });

  it('REQ-HIST-001: empty state reads "No articles in the last 7 days."', () => {
    expect(historyPageSource).toContain('No articles in the last 7 days.');
  });

  it('REQ-HIST-001: UserMenu link label reads "History" (rename to Search & History is a future phase)', () => {
    expect(userMenuSource).toContain('href="/history"');
    expect(userMenuSource).toMatch(/<span>History<\/span>/);
  });
});
