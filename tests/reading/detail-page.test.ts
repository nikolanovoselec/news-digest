// Tests for src/pages/digest/[id]/[slug].astro — REQ-READ-002, REQ-READ-003.
//
// The detail page is a server-rendered Astro component that executes
// its frontmatter on every request. We test two contracts:
//
//   1. Source-level: bullets use textContent (Astro {expression}) — no
//      innerHTML, no markdown, no sanitizer. The "Read at source" link
//      uses target=_blank + rel=noopener noreferrer. View Transitions
//      shared-element morph uses transition:name.
//   2. Runtime semantics: the UPDATE statement for REQ-READ-003 is
//      user-scoped via a subquery, runs only when read_at IS NULL
//      (idempotent), and binds (now, article_id, user_id).

import { describe, it, expect } from 'vitest';

import detailSource from '../../src/pages/digest/[id]/[slug].astro?raw';

describe('detail page source contract — REQ-READ-002', () => {
  it('REQ-READ-002: declares it implements REQ-READ-002 and REQ-READ-003', () => {
    expect(detailSource).toContain('REQ-READ-002');
    expect(detailSource).toContain('REQ-READ-003');
  });

  it('REQ-READ-002: renders each details entry as a <p> paragraph', () => {
    // Editorial prose layout (drop cap + 62ch measure) requires real
    // paragraphs, not <li> bullets. The AC explicitly says "long-form
    // reading prose"; the test pins that shape.
    expect(detailSource).toMatch(/<div[\s\S]*?class="article-detail__body"/);
    expect(detailSource).toMatch(/details\.map\(\(paragraph,\s*i\)\s*=>\s*\(/);
    expect(detailSource).toContain('article-detail__paragraph');
    // First paragraph carries the drop-cap modifier.
    expect(detailSource).toContain('article-detail__paragraph--lead');
  });

  it('REQ-READ-002: metadata line renders source, date, and read-time', () => {
    expect(detailSource).toContain('article-detail__meta');
    expect(detailSource).toMatch(/MIN READ/);
  });

  it('REQ-READ-002: never uses innerHTML in the frontmatter render', () => {
    expect(detailSource).not.toContain('innerHTML');
  });

  it('REQ-READ-002: paragraphs render via textContent (Astro {expression}) — no set:html', () => {
    expect(detailSource).not.toContain('set:html');
  });

  it('REQ-READ-002: no markdown parser is imported (no unified/remark/marked/markdown-it)', () => {
    expect(detailSource).not.toMatch(/unified|remark|marked|markdown-it/);
  });

  it('REQ-READ-002: source link opens in a new tab with rel=noopener noreferrer', () => {
    expect(detailSource).toMatch(/target="_blank"/);
    expect(detailSource).toMatch(/rel="noopener noreferrer"/);
  });

  it('REQ-READ-002: source link uses source_url from the article row', () => {
    expect(detailSource).toContain('articleRow.source_url');
  });

  it('REQ-READ-002: header carries transition:name for shared-element morph back to card', () => {
    expect(detailSource).toContain('transition:name={transitionName}');
    expect(detailSource).toMatch(/card-\$\{articleRow\.slug\}/);
  });

  it('REQ-READ-002: back control returns to /digest', () => {
    expect(detailSource).toMatch(/href="\/digest"/);
  });

  it('REQ-READ-002: digestId and slug are pulled from Astro.params', () => {
    expect(detailSource).toContain("Astro.params['id']");
    expect(detailSource).toContain("Astro.params['slug']");
  });
});

describe('detail page source contract — REQ-READ-003 read tracking', () => {
  it('REQ-READ-003: UPDATE statement is user-scoped via subquery', () => {
    expect(detailSource).toMatch(
      /UPDATE articles SET read_at[\s\S]*digest_id IN \(SELECT id FROM digests WHERE user_id = \?3\)/,
    );
  });

  it('REQ-READ-003: UPDATE is idempotent via read_at IS NULL filter', () => {
    expect(detailSource).toContain('read_at IS NULL');
  });

  it('REQ-READ-003: UPDATE is only issued when read_at is NULL on load (early return)', () => {
    // The page skips the UPDATE when articleRow.read_at !== null.
    expect(detailSource).toMatch(/if\s*\(\s*articleRow\.read_at\s*===\s*null\s*\)/);
  });

  it('REQ-READ-003: binds (now, article_id, user_id) in that order', () => {
    // bind(nowSec, articleRow.id, user.id).run()
    expect(detailSource).toMatch(/\.bind\(\s*nowSec\s*,\s*articleRow\.id\s*,\s*user\.id\s*\)/);
  });

  it('REQ-READ-003: digest row is user-scoped in the ownership check', () => {
    expect(detailSource).toMatch(
      /SELECT id, user_id, local_date[\s\S]*FROM digests WHERE id = \?1 AND user_id = \?2/,
    );
  });

  it('REQ-READ-003: 404 for unknown or non-owned digest', () => {
    expect(detailSource).toContain("'Not found'");
    expect(detailSource).toContain('status: 404');
  });
});

describe('detail page source contract — auth gating', () => {
  it('REQ-AUTH-002: redirects to GitHub login when no session', () => {
    expect(detailSource).toContain('/api/auth/github/login');
  });

  it('REQ-SET-006: applies the settings-complete gate before rendering', () => {
    expect(detailSource).toContain('requireSettingsComplete');
  });
});
