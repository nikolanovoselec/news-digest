#!/usr/bin/env node
// Infrastructure / build artifact — no REQ.
//
// `@cloudflare/vite-plugin@13` (bundled with `@astrojs/cloudflare@13`)
// validates `wrangler.toml`'s `main` field at typecheck time. Our `main`
// points at `dist/_worker.js/_merged.mjs`, which is the post-merge
// artifact written by `scripts/merge-worker-handlers.mjs` AFTER
// `astro build` (see the `build` script in package.json). At
// typecheck time no build has run yet, so the file doesn't exist
// and the plugin throws.
//
// Workaround: write a stub at the expected path before `astro check`.
// The real build pipeline overwrites the stub with the merged worker
// content, so the stub never reaches a deploy unless someone
// short-circuits `npm run build` and goes straight to `wrangler
// deploy` — in which case the stub's `console.error` clearly tells
// them what they're about to ship.

import { mkdirSync, existsSync, writeFileSync } from 'node:fs';

const DIR = 'dist/_worker.js';
const PATH = `${DIR}/_merged.mjs`;
const STUB = `// Stub written by scripts/ensure-worker-stub.mjs to satisfy
// @cloudflare/vite-plugin's wrangler.toml main-field existence check
// at typecheck time. The real worker is written here by
// scripts/merge-worker-handlers.mjs after \`astro build\`.
//
// Reaching this code at runtime means the build pipeline was skipped.
export default {
  fetch() {
    return new Response(
      'Worker stub reached at runtime — build pipeline was skipped. ' +
      'Run \`npm run build\` (which calls merge-worker-handlers) before deploy.',
      { status: 500, headers: { 'Content-Type': 'text/plain' } },
    );
  },
};
`;

mkdirSync(DIR, { recursive: true });
if (!existsSync(PATH)) {
  writeFileSync(PATH, STUB);
  console.log(`ensure-worker-stub: wrote ${PATH}`);
} else {
  console.log(`ensure-worker-stub: ${PATH} already exists, leaving alone`);
}
