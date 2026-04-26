// Tests for src/lib/email.ts `renderDigestReadyEmail` — REQ-MAIL-001.
//
// The renderer produces a rich daily-digest email: dynamic subject
// (`{N} new articles · {top tags}`), hidden inbox preheader, top-N
// unread headlines linking to article detail pages, "since midnight"
// tag tally, recipient-tz local-time line, "Manage notifications"
// footer, and a clickable Gray Matter signature.
//
// Tests pin the observable shape of the output. They cover:
//   - subject/preheader content for both populated and zero-headline cases
//   - presence + ordering of headline rows in HTML and plain-text
//   - tag tally formatting (and omission when empty)
//   - local-time line ("Sent HH:MM tz · next digest tomorrow at HH:MM")
//   - footer + signature anchors
//   - regression guards: no <style>, no <script>, trailing-slash trim,
//     HTML escaping of metacharacters in interpolated strings

import { describe, it, expect } from 'vitest';
import {
  renderDigestReadyEmail,
  type DigestReadyEmailParams,
} from '~/lib/email';
import type { Headline, TagTally } from '~/lib/email-data';

const FIVE_HEADLINES: Headline[] = [
  { id: 'a-1', title: 'Cloudflare ships D1 GA',     source_name: 'Cloudflare Blog', slug: 'cloudflare-ships-d1-ga',     primary_source_url: 'https://blog.cloudflare.com/d1-ga' },
  { id: 'a-2', title: 'MCP servers explode in 2026', source_name: 'Hacker News',     slug: 'mcp-servers-explode-in-2026', primary_source_url: 'https://news.ycombinator.com/item?id=1' },
  { id: 'a-3', title: 'OpenZiti 1.0 released',       source_name: 'OpenZiti Blog',   slug: 'openziti-10-released',         primary_source_url: 'https://openziti.io/blog' },
  { id: 'a-4', title: 'Kubernetes 1.34 highlights',  source_name: 'KubeCon Recap',   slug: 'kubernetes-134-highlights',    primary_source_url: 'https://k8s.io/blog' },
  { id: 'a-5', title: 'AI agents for incident triage', source_name: 'PagerDuty',     slug: 'ai-agents-for-incident-triage', primary_source_url: 'https://pagerduty.com/blog' },
];

const FIVE_TAGS: TagTally[] = [
  { tag: 'kubernetes', count: 4 },
  { tag: 'ai-agents',  count: 3 },
  { tag: 'mcp',        count: 2 },
  { tag: 'openziti',   count: 1 },
  { tag: 'cloudflare', count: 1 },
];

function makeParams(overrides: Partial<DigestReadyEmailParams> = {}): DigestReadyEmailParams {
  return {
    appUrl: 'https://news-digest.example.com',
    userDisplayName: 'alice',
    headlines: FIVE_HEADLINES,
    tagTally: FIVE_TAGS,
    totalSinceMidnight: 11,
    sentLocal: { hour: 8, minute: 0, tz: 'Europe/Zurich' },
    nextDigestLocal: { hour: 8, minute: 0 },
    ...overrides,
  };
}

// ---------- Subject (AC 3) ----------

describe('renderDigestReadyEmail subject — REQ-MAIL-001 AC 3', () => {
  it('REQ-MAIL-001 AC 3: subject reads "{N} new articles · {top tags}" when N>0', () => {
    const { subject } = renderDigestReadyEmail(makeParams());
    expect(subject).toBe('5 new articles · kubernetes, ai-agents, mcp');
  });

  it('REQ-MAIL-001 AC 3: subject lists at most 3 tags', () => {
    const { subject } = renderDigestReadyEmail(makeParams());
    // Tally has 5 tags but only top 3 should appear.
    const afterBullet = subject.split(' · ')[1] ?? '';
    expect(afterBullet.split(', ')).toHaveLength(3);
  });

  it('REQ-MAIL-001 AC 3: subject reads "Your news digest is ready" when headlines empty (AC 10 fallback)', () => {
    const { subject } = renderDigestReadyEmail(makeParams({ headlines: [] }));
    expect(subject).toBe('Your news digest is ready');
  });

  it('REQ-MAIL-001 AC 3: subject omits the bullet when tally is empty but headlines non-empty', () => {
    const { subject } = renderDigestReadyEmail(makeParams({ tagTally: [] }));
    expect(subject).toBe('5 new articles');
    expect(subject).not.toContain('·');
  });
});

// ---------- Preheader ----------

describe('renderDigestReadyEmail preheader — REQ-MAIL-001', () => {
  it('REQ-MAIL-001 (preheader): hidden div appears at the top of <body>', () => {
    const { html } = renderDigestReadyEmail(makeParams());
    // The preheader div must be the first non-whitespace child of <body>.
    const bodyMatch = html.match(/<body[^>]*>\s*(<div[^>]*>)/);
    expect(bodyMatch).not.toBeNull();
    expect(bodyMatch![1]).toMatch(/display:none/);
    expect(bodyMatch![1]).toMatch(/mso-hide:all/);
  });

  it('REQ-MAIL-001 (preheader): preheader text is the comma-joined top-3 headline titles', () => {
    const { html } = renderDigestReadyEmail(makeParams());
    expect(html).toContain('Cloudflare ships D1 GA, MCP servers explode in 2026, OpenZiti 1.0 released');
  });

  it('REQ-MAIL-001 (preheader): preheader is empty when headlines empty', () => {
    const { html } = renderDigestReadyEmail(makeParams({ headlines: [] }));
    // Hidden div still present, but its inner text is empty (just whitespace).
    expect(html).toMatch(/<div style="display:none[^"]*">\s*<\/div>/);
  });
});

// ---------- Headline block (AC 4) ----------

describe('renderDigestReadyEmail headlines — REQ-MAIL-001 AC 4', () => {
  it('REQ-MAIL-001 AC 4: html lists exactly headlines.length anchor rows', () => {
    const { html } = renderDigestReadyEmail(makeParams());
    // Each headline renders as one <a href=".../digest/{id}/{slug}">.
    const anchors = html.match(/<a href="[^"]*\/digest\/[^/]+\/[^"]+"/g) ?? [];
    expect(anchors).toHaveLength(5);
  });

  it('REQ-MAIL-001 AC 4: each headline anchor targets ${appUrl}/digest/{id}/{slug}', () => {
    const { html } = renderDigestReadyEmail(makeParams());
    expect(html).toContain('href="https://news-digest.example.com/digest/a-1/cloudflare-ships-d1-ga"');
    expect(html).toContain('href="https://news-digest.example.com/digest/a-3/openziti-10-released"');
  });

  it('REQ-MAIL-001 AC 4: each headline shows its source name', () => {
    const { html } = renderDigestReadyEmail(makeParams());
    expect(html).toContain('Cloudflare Blog');
    expect(html).toContain('OpenZiti Blog');
  });

  it('REQ-MAIL-001 AC 4: html escapes title and source name', () => {
    const evilHeadlines: Headline[] = [
      { id: 'evil-1', title: 'Evil <script>alert(1)</script> title', source_name: 'A & B "Newsroom"', slug: 'evil', primary_source_url: 'https://x' },
    ];
    const { html } = renderDigestReadyEmail(makeParams({ headlines: evilHeadlines, tagTally: [] }));
    expect(html).not.toContain('<script>alert(1)</script> title');
    expect(html).toContain('Evil &lt;script&gt;alert(1)&lt;/script&gt; title');
    expect(html).toContain('A &amp; B &quot;Newsroom&quot;');
  });

  it('REQ-MAIL-001 AC 4: text body lists each headline once with title and source', () => {
    const { text } = renderDigestReadyEmail(makeParams());
    expect(text).toContain('- Cloudflare ships D1 GA (Cloudflare Blog)');
    expect(text).toContain('- MCP servers explode in 2026 (Hacker News)');
    // Each headline URL appears exactly once as a "  https://..." line.
    expect(text.split('https://news-digest.example.com/digest/a-1/cloudflare-ships-d1-ga').length - 1).toBe(1);
  });

  it('REQ-MAIL-001 AC 4: zero headlines → no headline rows in html', () => {
    const { html } = renderDigestReadyEmail(makeParams({ headlines: [] }));
    const anchors = html.match(/<a href="[^"]*\/digest\/[^/]+\/[^"]+"/g) ?? [];
    expect(anchors).toHaveLength(0);
  });
});

// ---------- Tag tally (AC 5) ----------

describe('renderDigestReadyEmail tag tally — REQ-MAIL-001 AC 5', () => {
  it('REQ-MAIL-001 AC 5: html includes "Since midnight: {N} articles" prefix', () => {
    const { html } = renderDigestReadyEmail(makeParams({ totalSinceMidnight: 11 }));
    expect(html).toMatch(/Since midnight:\s*11\s*articles/);
  });

  it('REQ-MAIL-001 AC 5: tally renders "#tag (count)" for each entry', () => {
    const { html } = renderDigestReadyEmail(makeParams());
    expect(html).toContain('#kubernetes</span> (4)');
    expect(html).toContain('#ai-agents</span> (3)');
    expect(html).toContain('#mcp</span> (2)');
  });

  it('REQ-MAIL-001 AC 5: tally line is omitted entirely when tally is empty', () => {
    const { html, text } = renderDigestReadyEmail(makeParams({ tagTally: [], totalSinceMidnight: 0 }));
    expect(html).not.toMatch(/Since midnight/);
    expect(text).not.toMatch(/Since midnight/);
  });

  it('REQ-MAIL-001 AC 5: pluralisation — "1 article" (singular) when totalSinceMidnight is 1', () => {
    const { html } = renderDigestReadyEmail(makeParams({
      tagTally: [{ tag: 'mcp', count: 1 }],
      totalSinceMidnight: 1,
    }));
    expect(html).toMatch(/Since midnight:\s*1\s*article\b/);
    expect(html).not.toMatch(/1 articles/);
  });
});

// ---------- Local-time line (AC 6) ----------

describe('renderDigestReadyEmail local-time line — REQ-MAIL-001 AC 6', () => {
  it('REQ-MAIL-001 AC 6: html shows "Sent {HH:MM} {tz}"', () => {
    const { html } = renderDigestReadyEmail(makeParams({
      sentLocal: { hour: 8, minute: 0, tz: 'Europe/Zurich' },
    }));
    expect(html).toContain('Sent 08:00 Europe/Zurich');
  });

  it('REQ-MAIL-001 AC 6: html shows "next digest tomorrow at {HH:MM}"', () => {
    const { html } = renderDigestReadyEmail(makeParams({
      nextDigestLocal: { hour: 8, minute: 30 },
    }));
    expect(html).toContain('next digest tomorrow at 08:30');
  });

  it('REQ-MAIL-001 AC 6: HH and MM are zero-padded', () => {
    const { html } = renderDigestReadyEmail(makeParams({
      sentLocal: { hour: 7, minute: 5, tz: 'UTC' },
      nextDigestLocal: { hour: 7, minute: 5 },
    }));
    expect(html).toContain('Sent 07:05 UTC');
    expect(html).toContain('next digest tomorrow at 07:05');
  });
});

// ---------- Footer (AC 7) ----------

describe('renderDigestReadyEmail footer — REQ-MAIL-001 AC 7', () => {
  it('REQ-MAIL-001 AC 7: footer contains "Manage notifications" link to ${appUrl}/settings', () => {
    const { html } = renderDigestReadyEmail(makeParams());
    expect(html).toContain('Manage notifications');
    expect(html).toContain('href="https://news-digest.example.com/settings"');
  });

  it('REQ-MAIL-001 AC 7: text body includes Manage notifications URL', () => {
    const { text } = renderDigestReadyEmail(makeParams());
    expect(text).toContain('Manage notifications: https://news-digest.example.com/settings');
  });
});

// ---------- Signature (AC 8) ----------

describe('renderDigestReadyEmail signature — REQ-MAIL-001 AC 8', () => {
  it('REQ-MAIL-001 AC 8: signature "Gray Matter" is a hyperlink to https://graymatter.ch', () => {
    const { html } = renderDigestReadyEmail(makeParams());
    expect(html).toMatch(/<a href="https:\/\/graymatter\.ch"[^>]*>— Gray Matter<\/a>/);
  });

  it('REQ-MAIL-001 AC 8: text signature includes the graymatter.ch URL', () => {
    const { text } = renderDigestReadyEmail(makeParams());
    expect(text).toContain('— Gray Matter (https://graymatter.ch)');
  });
});

// ---------- AC 10 fallback ----------

describe('renderDigestReadyEmail zero-unread fallback — REQ-MAIL-001 AC 10', () => {
  it('REQ-MAIL-001 AC 10: zero-headline subject is the static fallback', () => {
    const { subject } = renderDigestReadyEmail(makeParams({ headlines: [] }));
    expect(subject).toBe('Your news digest is ready');
  });

  it('REQ-MAIL-001 AC 10: zero-headline body still has the tally line (when non-empty)', () => {
    const { html } = renderDigestReadyEmail(makeParams({ headlines: [] }));
    expect(html).toMatch(/Since midnight/);
  });

  it('REQ-MAIL-001 AC 10: zero-headline body still has the local-time line', () => {
    const { html } = renderDigestReadyEmail(makeParams({ headlines: [] }));
    expect(html).toContain('Sent 08:00 Europe/Zurich');
  });

  it('REQ-MAIL-001 AC 10: zero-headline body still has the footer + signature', () => {
    const { html } = renderDigestReadyEmail(makeParams({ headlines: [] }));
    expect(html).toContain('Manage notifications');
    expect(html).toContain('href="https://graymatter.ch"');
  });
});

// ---------- Constraints / regression guards ----------

describe('renderDigestReadyEmail constraints — REQ-MAIL-001', () => {
  it('REQ-MAIL-001 (constraint): no <style> blocks (inline styles only)', () => {
    const { html } = renderDigestReadyEmail(makeParams());
    expect(html).not.toMatch(/<style\b/i);
  });

  it('REQ-MAIL-001 (constraint): no <script> tags anywhere', () => {
    const { html } = renderDigestReadyEmail(makeParams());
    expect(html).not.toMatch(/<script\b/i);
  });

  it('REQ-MAIL-001 (constraint): trailing slash in appUrl is trimmed (no //digest, no //settings)', () => {
    const { html, text } = renderDigestReadyEmail(makeParams({
      appUrl: 'https://news-digest.example.com///',
    }));
    expect(html).not.toContain('//digest');
    expect(html).not.toContain('//settings');
    expect(text).not.toContain('//digest');
    expect(text).not.toContain('//settings');
  });

  it('REQ-MAIL-001 (constraint): html escapes appUrl metacharacters', () => {
    const { html } = renderDigestReadyEmail(makeParams({
      appUrl: 'https://evil"<x>&example.com',
    }));
    expect(html).not.toContain('"<x>&example');
    expect(html).toContain('&quot;');
    expect(html).toContain('&lt;x&gt;');
  });

  it('REQ-MAIL-001: return shape is { subject, text, html } with non-empty strings', () => {
    const r = renderDigestReadyEmail(makeParams());
    expect(typeof r.subject).toBe('string');
    expect(typeof r.text).toBe('string');
    expect(typeof r.html).toBe('string');
    expect(r.subject.length).toBeGreaterThan(0);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.html.length).toBeGreaterThan(0);
  });
});
