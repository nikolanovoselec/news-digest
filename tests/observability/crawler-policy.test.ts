// Tests for REQ-OPS-004 — crawler policy and public-surface discoverability.
//
// AC 1: landing carries title + description + canonical + OG metadata
// AC 2: robots.txt allows landing + static assets, disallows API and
//       authenticated routes, blocks known AI training UAs
// AC 3: llms.txt describes the product and forbids training on
//       authenticated content
// AC 4: sitemap serves from a stable URL, lists only public URLs,
//       referenced from robots.txt
// AC 5: error pages (404/500) are noindex

import { describe, it, expect } from 'vitest';
import { GET as sitemapGet } from '~/pages/sitemap.xml';
import baseSource from '../../src/layouts/Base.astro?raw';
// node:fs isn't available in the Workers-pool runtime; Vite's `?raw`
// handles plain text files so we inline the crawler-policy payloads
// directly into the bundle at test time.
import robots from '../../public/robots.txt?raw';
import llms from '../../public/llms.txt?raw';
import llmsFull from '../../public/llms-full.txt?raw';

describe('robots.txt — REQ-OPS-004 AC 2', () => {
  it('REQ-OPS-004: default User-agent allows the landing page and explicit static assets', () => {
    // The "$" anchor on `Allow: /$` is load-bearing: it allows the
    // landing page but NOT arbitrary paths that start with `/`.
    // Without the anchor, Disallow entries below would be shadowed.
    expect(robots).toMatch(/User-agent:\s*\*/);
    expect(robots).toMatch(/Allow:\s*\/\$/);
    expect(robots).toMatch(/Allow:\s*\/manifest\.webmanifest/);
    expect(robots).toMatch(/Allow:\s*\/favicon\.svg/);
    expect(robots).toMatch(/Allow:\s*\/sitemap\.xml/);
    // og:image default points at /og.png — robots must not block it.
    // /og.svg (the master) is also allowed for vector-capable scrapers.
    expect(robots).toMatch(/Allow:\s*\/og\.png/);
    expect(robots).toMatch(/Allow:\s*\/og\.svg/);
  });

  it('REQ-OPS-004: every authenticated surface is explicitly Disallowed for the default UA', () => {
    // Each authenticated route needs its own Disallow entry — a single
    // catch-all would also hide the landing page. AC 2 requires
    // /api/, /digest, /starred, /history, /settings all blocked.
    //
    // Isolate the "User-agent: *" block so a Disallow belonging to
    // one of the AI-crawler UAs can't accidentally satisfy the
    // assertion. The split yields [header, *-block, UA2-block, ...];
    // the default block is [1] (index [0] is the file header above
    // the first User-agent line).
    const blocks = robots.split(/\nUser-agent:/);
    const defaultBlock = blocks[1] ?? '';
    expect(defaultBlock.trim().startsWith('*'), '* UA block should be first after header').toBe(true);
    expect(defaultBlock).toMatch(/Disallow:\s*\/api\//);
    expect(defaultBlock).toMatch(/Disallow:\s*\/digest($|\n|\/)/);
    expect(defaultBlock).toMatch(/Disallow:\s*\/starred/);
    expect(defaultBlock).toMatch(/Disallow:\s*\/history/);
    expect(defaultBlock).toMatch(/Disallow:\s*\/settings/);
  });

  it('REQ-OPS-004: blocks the canonical AI training crawlers with Disallow: /', () => {
    // Each of these UAs gets its own User-agent block with a single
    // Disallow: / so they can't pull any surface — not even the
    // public landing, because the LLM-friendly summary lives in
    // llms.txt and re-training on the site itself is not consented.
    const mustBlock = [
      'GPTBot',
      'anthropic-ai',
      'ClaudeBot',
      'Google-Extended',
      'CCBot',
      'PerplexityBot',
    ];
    for (const ua of mustBlock) {
      // Match "User-agent: UA\nDisallow: /" (tolerant of single
      // blank-line separators) so a reordering of the file doesn't
      // break the assertion as long as each UA has its own block.
      const uaRe = new RegExp(
        `User-agent:\\s*${ua}\\s*\\n\\s*Disallow:\\s*\\/\\s*(\\n|$)`,
      );
      expect(robots, `${ua} should be fully blocked`).toMatch(uaRe);
    }
  });

  it('REQ-OPS-004: declares a sitemap URL that points at the production origin', () => {
    expect(robots).toMatch(/Sitemap:\s*https:\/\/[^\s]+\/sitemap\.xml/);
  });
});

describe('llms.txt — REQ-OPS-004 AC 3', () => {
  it('REQ-OPS-004: opens with an H1 + blockquote summary per llmstxt.org convention', () => {
    // llmstxt.org spec: first two elements are "# Title" and
    // "> summary". Crawlers key off exactly that shape.
    const lines = llms.trim().split('\n');
    expect(lines[0]).toMatch(/^#\s+News Digest/);
    // First non-empty line after the title should be the blockquote.
    const firstContentful = lines.slice(1).find((l) => l.trim() !== '');
    expect(firstContentful).toMatch(/^>\s+/);
  });

  it('REQ-OPS-004: explicitly names the routes that crawlers must NOT ingest', () => {
    // AC 3 — the policy must be concrete about what's off-limits so
    // a well-behaved agent can enforce it without re-reading the
    // product. Each authenticated surface is mentioned by path.
    expect(llms).toMatch(/\/api\//);
    expect(llms).toMatch(/\/digest/);
    expect(llms).toMatch(/\/starred/);
    expect(llms).toMatch(/\/history/);
    expect(llms).toMatch(/\/settings/);
  });

  it('REQ-OPS-004: llms-full.txt carries a detailed architecture reference (not just a summary)', () => {
    // Having BOTH llms.txt + llms-full.txt is the recommended pattern
    // — the short one is a crawler card, the full one is the
    // agent-consumable "how to think about this system" reference.
    expect(llmsFull).toMatch(/^#\s+News Digest/);
    // Full file includes pipeline details, data model, cost model —
    // features the short llms.txt deliberately leaves out.
    expect(llmsFull).toMatch(/pipeline|data model|cost|retention/i);
  });
});

describe('GET /sitemap.xml — REQ-OPS-004 AC 4', () => {
  it('REQ-OPS-004: returns valid XML with a urlset wrapper', async () => {
    const url = new URL('https://news.graymatter.ch/sitemap.xml');
    const res = sitemapGet({ url } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/application\/xml/);
    const body = await res.text();
    expect(body).toMatch(/<\?xml\s+version="1\.0"\s+encoding="UTF-8"\?>/);
    expect(body).toMatch(/<urlset\s+xmlns="http:\/\/www\.sitemaps\.org/);
    expect(body).toMatch(/<\/urlset>/);
  });

  it('REQ-OPS-004: includes the landing page as a <url> entry with the request origin', async () => {
    const url = new URL('https://news.graymatter.ch/sitemap.xml');
    const res = sitemapGet({ url } as never);
    const body = await res.text();
    // The sitemap must use the REQUEST origin, not a hardcoded one —
    // otherwise a preview/staging deploy would link back to prod.
    expect(body).toMatch(
      /<url><loc>https:\/\/news\.graymatter\.ch\/<\/loc>/,
    );
  });

  it('REQ-OPS-004: does NOT list any authenticated or API route', async () => {
    const url = new URL('https://news.graymatter.ch/sitemap.xml');
    const res = sitemapGet({ url } as never);
    const body = await res.text();
    expect(body).not.toMatch(/<loc>[^<]*\/api\//);
    expect(body).not.toMatch(/<loc>[^<]*\/digest/);
    expect(body).not.toMatch(/<loc>[^<]*\/starred/);
    expect(body).not.toMatch(/<loc>[^<]*\/history/);
    expect(body).not.toMatch(/<loc>[^<]*\/settings/);
  });

  it('REQ-OPS-004: sitemap origin follows the request, not a hardcoded hostname', async () => {
    // Fork-friendliness: a staging deploy at preview.news.example.com
    // must emit preview URLs, not production ones.
    const url = new URL('https://preview.example.com/sitemap.xml');
    const res = sitemapGet({ url } as never);
    const body = await res.text();
    expect(body).toMatch(
      /<url><loc>https:\/\/preview\.example\.com\//,
    );
    expect(body).not.toMatch(/news\.graymatter\.ch/);
  });

  it('REQ-OPS-004: serves a Cache-Control header so Googlebot can cheaply recheck', async () => {
    const url = new URL('https://news.graymatter.ch/sitemap.xml');
    const res = sitemapGet({ url } as never);
    // Some TTL — even a short one — is better than no caching hint.
    expect(res.headers.get('Cache-Control')).toMatch(/max-age=\d+/);
  });
});

describe('SEO metadata in Base.astro — REQ-OPS-004 AC 1', () => {
  it('REQ-OPS-004: emits canonical, og:*, twitter:* tags, and JSON-LD', () => {
    // Structural assertions — the exact values are derived at
    // request time, but the tag scaffolding has to be present.
    expect(baseSource).toMatch(/<link\s+rel="canonical"/);
    expect(baseSource).toMatch(/property="og:type"/);
    expect(baseSource).toMatch(/property="og:title"/);
    expect(baseSource).toMatch(/property="og:description"/);
    expect(baseSource).toMatch(/property="og:url"/);
    expect(baseSource).toMatch(/property="og:image"/);
    expect(baseSource).toMatch(/name="twitter:card"/);
    expect(baseSource).toMatch(/application\/ld\+json/);
  });

  it('REQ-OPS-004: og:image defaults to /og.png with explicit type + dimensions + alt so every major scraper renders summary_large_image', () => {
    // PNG (not SVG) is the default because Facebook, iMessage, WhatsApp,
    // LinkedIn, and Slack silently drop SVG og:images. Twitter and
    // Discord do render SVG, but raster is the lowest common denominator.
    expect(baseSource).toMatch(/\/og\.png/);
    expect(baseSource).not.toMatch(/ogImage\s*\?\?\s*`\$\{Astro\.url\.origin\}\/og\.svg`/);
    expect(baseSource).toMatch(/property="og:image:type"/);
    expect(baseSource).toMatch(/property="og:image:width"\s+content="1200"/);
    expect(baseSource).toMatch(/property="og:image:height"\s+content="630"/);
    expect(baseSource).toMatch(/property="og:image:alt"/);
    expect(baseSource).toMatch(/name="twitter:card"\s+content="summary_large_image"/);
  });

  it('REQ-OPS-004: emits dual theme-color metas for light + dark OS schemes', () => {
    expect(baseSource).toMatch(
      /theme-color[\s\S]{0,120}media="\(prefers-color-scheme:\s*light\)"/,
    );
    expect(baseSource).toMatch(
      /theme-color[\s\S]{0,120}media="\(prefers-color-scheme:\s*dark\)"/,
    );
    expect(baseSource).toMatch(/name="color-scheme"\s+content="light dark"/);
  });

  it('REQ-OPS-004: JSON-LD declares both a WebSite and an Organization node', () => {
    // These are the two nodes Google's knowledge-panel parsers key
    // on. Missing Organization = no publisher attribution; missing
    // WebSite = no sitelinks search box.
    expect(baseSource).toMatch(/@type.*WebSite/);
    expect(baseSource).toMatch(/@type.*Organization/);
  });

  it('REQ-OPS-004: noindex prop emits the robots meta when true', () => {
    expect(baseSource).toMatch(/name="robots"\s+content="noindex/);
  });
});
