// Tests for the /starred surface — REQ-STAR-002 and REQ-STAR-003.
//
// Coverage:
//   - The /starred page reuses the DigestCard grid and feeds it from
//     article_stars rows, newest star first.
//   - The empty-state copy is exactly "No starred articles yet."
//   - No countdown header (/starred is a bookmark list, not a live feed).
//   - UserMenu renders a "Starred" link with star-outline icon positioned
//     between the History and Settings entries.
//
// The page is server-rendered Astro; vitest workers can't execute the
// full runtime, so we validate observable contract by:
//   1. `?raw` source imports for DOM/copy invariants (same pattern used
//      in tests/reading/digest-page.test.ts).
//   2. Direct calls into `loadStarredPayload` from
//      src/pages/api/starred.ts with a mocked D1 for the data contract.

import { describe, it, expect, vi } from 'vitest';

import starredPageSource from '../../src/pages/starred.astro?raw';
import userMenuSource from '../../src/components/UserMenu.astro?raw';
import { loadStarredPayload } from '~/pages/api/starred';

describe('/starred — REQ-STAR-002', () => {
  it('REQ-STAR-002: /starred renders the identical card grid from article_stars rows', async () => {
    // Grid layout invariants mirror digest.astro so the page reads as
    // the same surface: 1 column on mobile, 2 at 768px, 3 at 1024px.
    expect(starredPageSource).toMatch(/grid-template-columns:\s*1fr/);
    expect(starredPageSource).toMatch(
      /@media\s*\(min-width:\s*768px\)[\s\S]*?grid-template-columns:\s*repeat\(2/,
    );
    expect(starredPageSource).toMatch(
      /@media\s*\(min-width:\s*1024px\)[\s\S]*?grid-template-columns:\s*repeat\(3/,
    );
    // Cards are rendered via the shared DigestCard component so every
    // star/tag/title affordance stays identical between the two feeds.
    expect(starredPageSource).toContain('DigestCard');
    // Data flows from loadStarredPayload (not from /api/starred via a
    // subrequest hop) so the auth context and DB match the browser.
    expect(starredPageSource).toContain('loadStarredPayload');

    // Data-contract side: a real payload call against a mocked D1 must
    // return rows ordered DESC by starred_at and every row flagged
    // starred=true by construction of the endpoint.
    const now = Math.floor(Date.now() / 1000);
    const rows = [
      {
        id: 'art-a',
        title: 'Older star',
        details_json: JSON.stringify(['a']),
        primary_source_name: 'Example',
        primary_source_url: 'https://example.com/a',
        published_at: now - 200,
        tags_json: JSON.stringify(['cloudflare']),
        alt_source_count: 0,
        starred_at: now - 3000,
        read: 0,
      },
      {
        id: 'art-b',
        title: 'Newer star',
        details_json: JSON.stringify(['b']),
        primary_source_name: 'Example',
        primary_source_url: 'https://example.com/b',
        published_at: now - 100,
        tags_json: JSON.stringify(['generative-ai']),
        alt_source_count: 2,
        starred_at: now - 60,
        read: 1,
      },
    ];
    const boundParams: unknown[] = [];
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: (...params: unknown[]) => ({
          all: vi.fn().mockImplementation(async () => {
            boundParams.push(...params);
            // Mock the server-side ORDER BY starred_at DESC.
            const sorted = sql.includes('ORDER BY st.starred_at DESC')
              ? [...rows].sort((x, y) => y.starred_at - x.starred_at)
              : rows;
            return { success: true, results: sorted };
          }),
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
        }),
      })),
    } as unknown as D1Database;
    const payload = await loadStarredPayload(db, 'user-1');
    // Two rows, newest-starred first.
    expect(payload.articles).toHaveLength(2);
    expect(payload.articles[0]?.id).toBe('art-b');
    expect(payload.articles[1]?.id).toBe('art-a');
    // Every returned article is starred by definition of this endpoint.
    expect(payload.articles.every((a) => a.starred === true)).toBe(true);
    // The user id is bound as the first positional parameter — this is
    // what makes the query user-scoped (no cross-user leak).
    expect(boundParams[0]).toBe('user-1');
  });

  it('REQ-STAR-002: empty state reads exactly "No starred articles yet."', () => {
    expect(starredPageSource).toContain('No starred articles yet.');
  });

  it('REQ-STAR-002: no countdown header', () => {
    // /starred is NOT a live feed — it's a personal bookmark list, so
    // the "Last updated at / Next update in" countdown hooks MUST NOT
    // appear on this page (distinct from /digest).
    expect(starredPageSource).not.toContain('Last updated at');
    expect(starredPageSource).not.toContain('Next update in');
    expect(starredPageSource).not.toContain('data-next-at');
    expect(starredPageSource).not.toContain('tickCountdown');
    expect(starredPageSource).not.toContain('next_scrape_at');
  });
});

describe('UserMenu — REQ-STAR-003', () => {
  it('REQ-STAR-003: UserMenu has a "Starred" entry between History and Settings', () => {
    // The menu items appear in source order, so a substring-positional
    // check is sufficient: history row BEFORE starred row BEFORE
    // settings row.
    const historyIdx = userMenuSource.indexOf('href="/history"');
    const starredIdx = userMenuSource.indexOf('href="/starred"');
    const settingsIdx = userMenuSource.indexOf('href="/settings"');

    expect(historyIdx).toBeGreaterThan(-1);
    expect(starredIdx).toBeGreaterThan(-1);
    expect(settingsIdx).toBeGreaterThan(-1);
    expect(starredIdx).toBeGreaterThan(historyIdx);
    expect(settingsIdx).toBeGreaterThan(starredIdx);

    // The visible label is "Starred".
    expect(userMenuSource).toMatch(/<span>Starred<\/span>/);
  });

  it('REQ-STAR-003: the Starred entry has a star-outline icon on the right side', () => {
    // The row reuses the shared .user-menu__row styling (same as
    // History) — label on the left, icon on the right.
    expect(userMenuSource).toContain('user-menu__row');
    expect(userMenuSource).toContain('user-menu__row-icon');
    // MDI star-outline path (24×24 viewBox) — the distinguishing
    // shape fragment is the polygon vertex run "M12 2 9.19 8.63 2 9.24"
    // shared across the star-outline + star filled glyphs, combined
    // with stroke-only rendering (fill="none" stroke="currentColor")
    // which is what makes it an outline (not a filled star).
    expect(userMenuSource).toMatch(/href="\/starred"[\s\S]*?fill="none"[\s\S]*?stroke="currentColor"/);
    expect(userMenuSource).toMatch(/href="\/starred"[\s\S]*?M12 2 9\.19 8\.63 2 9\.24/);
  });
});
