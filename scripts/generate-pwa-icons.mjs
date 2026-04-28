#!/usr/bin/env node
// Implements REQ-PWA-001
//
// Render the PWA app icon SVG to PNG at the sizes Samsung Internet and
// older Android Chrome require for the "Install app" install dialog.
// Some browsers refuse the install prompt when the manifest only ships
// SVG icons; pinning a 192×192 + 512×512 raster pair restores the
// install affordance without losing the SVG vector lane.
//
// Runs as a build step (see `build` in package.json). The PNGs are
// written to `public/icons/`; Astro copies the `public/` directory
// into `dist/` during `astro build`, which is what ships to the
// static-asset bundle. The PNGs are NOT committed — they are
// reproducible from the SVG.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');
const iconsDir = join(repoRoot, 'public', 'icons');
const svgPath = join(iconsDir, 'app-icon.svg');

const svgRaw = readFileSync(svgPath, 'utf-8');

// Strip every `@media (...)` block from the SVG so the static PNG is
// rendered with the default (dark) palette and never picks up an
// alternative theme. resvg ignores @media queries by default — this
// strip is a belt-and-braces guard against future resvg releases that
// might evaluate them, and it stays correct as the SVG grows new
// rules. Balanced-brace scan handles arbitrary nesting and any number
// of inner rules without the brittleness of a hand-written regex.
function stripMediaBlocks(source) {
  let out = source;
  while (true) {
    const start = out.search(/@media\b[^{]*\{/);
    if (start === -1) return out;
    let depth = 0;
    let i = start;
    for (; i < out.length; i++) {
      const c = out[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    out = out.slice(0, start) + out.slice(i);
  }
}

const svgFlat = stripMediaBlocks(svgRaw);

const sizes = [192, 512];
mkdirSync(iconsDir, { recursive: true });

for (const size of sizes) {
  const resvg = new Resvg(svgFlat, {
    fitTo: { mode: 'width', value: size },
    background: '#0a0a0a',
  });
  const png = resvg.render().asPng();
  const outPath = join(iconsDir, `app-icon-${size}.png`);
  writeFileSync(outPath, png);
  console.log(`[pwa-icons] wrote ${outPath} (${png.length} bytes, ${size}×${size})`);
}
