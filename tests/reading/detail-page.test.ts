// Tests for src/pages/digest/[id]/[slug].astro — REQ-READ-002, REQ-READ-003.
//
// The detail page is a server-rendered Astro component that executes
// its frontmatter on every request. We test two contracts:
//
//   1. Source-level: paragraphs use textContent (Astro {expression}) —
//      no innerHTML, no markdown, no sanitizer. The source-link branch
//      renders either a plain <a target="_blank" rel="noopener ...">
//      (single source) or a <button data-alt-sources-trigger> that
//      opens the <AltSourcesModal /> dialog (multi source). View
//      Transitions shared-element morph uses transition:name.
//   2. Runtime semantics: the INSERT OR IGNORE for REQ-READ-003 writes
//      a row into article_reads scoped by (user_id, article_id).

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

  it('REQ-READ-002: single-source article keeps direct-link behavior', () => {
    // When there are no alternative sources, the page renders a plain
    // <a> with target=_blank and rel=noopener noreferrer pointing at
    // primary_source_url — the legacy behaviour preserved verbatim.
    expect(detailSource).toMatch(/altSources\.length\s*===\s*0/);
    expect(detailSource).toMatch(/href=\{articleRow\.primary_source_url\}/);
    expect(detailSource).toMatch(/target="_blank"/);
    expect(detailSource).toMatch(/rel="noopener noreferrer"/);
  });

  it('REQ-READ-002: multi-source article shows alt-sources modal trigger', () => {
    // When at least one alt source exists, the "Read at source" affordance
    // becomes a <button data-alt-sources-trigger> and the page mounts
    // <AltSourcesModal />.
    expect(detailSource).toContain('data-alt-sources-trigger');
    expect(detailSource).toMatch(/altSources\.length\s*>=\s*1/);
    expect(detailSource).toContain('AltSourcesModal');
    expect(detailSource).toMatch(
      /import\s+AltSourcesModal\s+from\s+['"]~\/components\/AltSourcesModal\.astro['"]/,
    );
  });

  it('REQ-READ-002: button label is "Read at source (+N)" for multi-source', () => {
    // readAtLabel is the single source of truth for the copy — the
    // detail-page uses a template literal `Read at source (+${altCount})`.
    expect(detailSource).toMatch(/Read at source \(\+\$\{altCount\}\)/);
  });

  it('REQ-READ-002: header carries transition:name for shared-element morph back to card', () => {
    expect(detailSource).toContain('transition:name={transitionName}');
    expect(detailSource).toMatch(/card-\$\{canonicalSlug\}/);
  });

  it('REQ-READ-002: back control returns to /digest', () => {
    expect(detailSource).toMatch(/href="\/digest"/);
  });

  it('REQ-READ-002: articleId and slug are pulled from Astro.params', () => {
    expect(detailSource).toContain("Astro.params['id']");
    expect(detailSource).toContain("Astro.params['slug']");
  });
});

describe('detail page source contract — REQ-READ-003 read tracking', () => {
  it('REQ-READ-003: inserts into article_reads scoped by (user_id, article_id)', () => {
    expect(detailSource).toMatch(
      /INSERT\s+OR\s+IGNORE\s+INTO\s+article_reads/i,
    );
    expect(detailSource).toMatch(
      /\(user_id,\s*article_id,\s*read_at\)\s+VALUES/i,
    );
  });

  it('REQ-READ-003: INSERT is only issued when the user has not already read the article', () => {
    // The page skips the INSERT when alreadyRead is true.
    expect(detailSource).toMatch(/if\s*\(\s*!alreadyRead\s*\)/);
  });

  it('REQ-READ-003: binds (user_id, article_id, now) in that order', () => {
    expect(detailSource).toMatch(
      /\.bind\(\s*user\.id\s*,\s*articleRow\.id\s*,\s*nowSec\s*\)/,
    );
  });

  it('REQ-READ-003: article lookup by id from the global pool', () => {
    expect(detailSource).toMatch(
      /SELECT id, title, details_json[\s\S]*FROM articles WHERE id = \?1/,
    );
  });

  it('REQ-READ-003: 404 for unknown article id', () => {
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
