// Dynamic sitemap. Only exposes public surfaces — everything behind
// the login is deliberately absent so crawlers don't follow a
// redirect chain into the OAuth flow.

import type { APIContext } from 'astro';

export function GET(context: APIContext): Response {
  const origin = context.url.origin;
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${origin}/`, priority: '1.0', changefreq: 'daily' },
  ];
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map(
      (u) =>
        `  <url><loc>${u.loc}</loc><lastmod>${lastmod}</lastmod>` +
        `<changefreq>${u.changefreq}</changefreq>` +
        `<priority>${u.priority}</priority></url>`,
    ),
    '</urlset>',
    '',
  ].join('\n');
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
