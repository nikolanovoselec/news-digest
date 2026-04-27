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

  it('REQ-READ-002: metadata line renders source, published date, and ingested time', () => {
    // The metadata strip is `<source> · <publishedLabel> · <ingestedLabel>`.
    // ingestedLabel is wall-clock time only — the published date is right
    // beside it in the strip, so prefixing the ingested slot with a
    // duplicate "INGESTED APR 27" was redundant noise.
    expect(detailSource).toContain('article-detail__meta');
    expect(detailSource).toContain('publishedLabel');
    expect(detailSource).toContain('ingestedLabel');
    // Time-only formatter: hour:minute, no date, no "INGESTED " prefix.
    expect(detailSource).not.toMatch(/INGESTED \$\{datePart\}/);
    expect(detailSource).toMatch(/hour:\s*['"]2-digit['"]/);
    expect(detailSource).toMatch(/minute:\s*['"]2-digit['"]/);
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

  it('REQ-READ-002: button label is plain "Read at source" — no (+N) suffix in either branch', () => {
    // Per user ask: the label never leaks the alt-source count.
    // Single-source → direct link, multi-source → button that opens
    // the picker; the *copy* is identical in both branches so the
    // reader sees the same affordance either way.
    expect(detailSource).toContain("'Read at source'");
    expect(detailSource).not.toMatch(/Read at source \(\+\$\{altCount\}\)/);
    expect(detailSource).not.toMatch(/Read at source \(\+/);
  });

  it('REQ-READ-002: header carries transition:name for shared-element morph back to card', () => {
    expect(detailSource).toContain('transition:name={transitionName}');
    expect(detailSource).toMatch(/card-\$\{canonicalSlug\}/);
  });

  it('REQ-READ-002: back control returns to /digest', () => {
    expect(detailSource).toMatch(/href="\/digest"/);
  });

  it('REQ-READ-002: back-button hijack accepts SPA-nav signal (history.state.index > 0) AND same-origin referrer', () => {
    // The earlier implementation used document.referrer alone to
    // decide whether to call window.history.back(). SPA navigations
    // never refresh document.referrer (the document was never re-
    // fetched), so a user who hard-loaded /history and SPA-clicked
    // a card landed on this page with referrer === '' and the
    // hijack fell through to the static href="/digest" — taking
    // them to the dashboard instead of back to /history. Astro's
    // ClientRouter sets history.state.index on every navigation;
    // index > 0 proves an in-app SPA hop has happened.
    expect(detailSource).toMatch(
      /history\.state[\s\S]{0,200}\.index/,
    );
    expect(detailSource).toMatch(
      /typeof\s+stateIndex\s*===\s*['"]number['"]\s*&&\s*stateIndex\s*>\s*0/,
    );
    // Same-origin referrer remains a valid in-app signal for the
    // hard-load case (no SPA navigation happened, so history.state
    // may still be index 0).
    expect(detailSource).toMatch(
      /document\.referrer[\s\S]{0,200}window\.location\.origin/,
    );
    // The handler still calls window.history.back() when at least
    // one of the two signals is present.
    expect(detailSource).toMatch(
      /if\s*\(\s*!arrivedInAppViaSpa\s*&&\s*!sameOriginReferrer\s*\)/,
    );
    expect(detailSource).toContain('window.history.back()');
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
  it('REQ-AUTH-002: redirects to the landing page when no session', () => {
    // Was a fixed redirect to /api/auth/github/login; now bounces to
    // / so the landing page can render the configured providers
    // (REQ-AUTH-001 — GitHub may not be the only provider).
    expect(detailSource).toMatch(/Astro\.redirect\('\/',\s*303\)/);
  });

  it('REQ-SET-006: applies the settings-complete gate before rendering', () => {
    expect(detailSource).toContain('requireSettingsComplete');
  });
});
