#!/usr/bin/env node
// Infrastructure / build artifact — no REQ.
//
// Compile every `src/scripts/*.ts` that ships as a static client-side
// asset (CSP `script-src 'self'` requires it to be served from the
// origin) to a corresponding `public/scripts/*.js`. The hand-maintained
// JS mirrors that previously lived in `public/scripts/` drifted from
// their TypeScript sources (CF-001) — having esbuild rebuild them
// every `npm run build` eliminates the drift class.
//
// Convention:
//  - One TypeScript file per static script.
//  - Skip files that are imported by Astro components (those are
//    bundled into the page's hashed JS by Vite/Astro). The skip list
//    is hardcoded below.
//  - Output is IIFE format with ES2022 target so the browsers we
//    support (last-2 evergreen + iOS 15+) parse without polyfills.

import { readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { build } from 'esbuild';

const SRC_DIR = 'src/scripts';
const OUT_DIR = 'public/scripts';

// theme-toggle.ts is consumed by Base.astro as an ES module import,
// not as a static script tag — skip so we don't ship a duplicate.
const SKIP = new Set(['theme-toggle']);

const entries = readdirSync(SRC_DIR)
  .filter((f) => extname(f) === '.ts')
  .filter((f) => !SKIP.has(basename(f, '.ts')))
  .map((f) => join(SRC_DIR, f));

if (entries.length === 0) {
  console.error('build-client-scripts: no entry files found in', SRC_DIR);
  process.exit(1);
}

console.log(`build-client-scripts: bundling ${entries.length} entries → ${OUT_DIR}/`);
for (const entry of entries) {
  const name = basename(entry, '.ts');
  const out = join(OUT_DIR, `${name}.js`);
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'iife',
    target: 'es2022',
    sourcemap: false,
    minify: false,
    platform: 'browser',
    logLevel: 'warning',
  });
  const size = statSync(out).size;
  console.log(`  ${name.padEnd(24)}  ${String(size).padStart(7)} bytes`);
}
console.log('build-client-scripts: done');
