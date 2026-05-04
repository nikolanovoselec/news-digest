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
// Convention (CF-023):
//  - Top-level src/scripts/*.ts → static script tags loaded by-path
//    from /scripts/<name>.js (Pattern B). esbuild compiles these
//    into public/scripts/.
//  - src/scripts/bundled/*.ts → imported by Astro components or
//    pages and bundled into the page's hashed JS by Vite/Astro
//    (Pattern A). The bundler owns these; this script ignores them.
//  - Adding a third Pattern A file no longer requires updating a
//    hand-maintained skip list — drop the file under bundled/.
//  - Output is IIFE format with ES2022 target so the browsers we
//    support (last-2 evergreen + iOS 15+) parse without polyfills.

import { readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { build } from 'esbuild';

const SRC_DIR = 'src/scripts';
const OUT_DIR = 'public/scripts';

const entries = readdirSync(SRC_DIR, { withFileTypes: true })
  .filter((d) => d.isFile() && extname(d.name) === '.ts')
  .map((d) => join(SRC_DIR, d.name));

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
