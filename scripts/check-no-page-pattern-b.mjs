#!/usr/bin/env node
// Infrastructure / build artifact — no REQ.
//
// CI gate per ADR AD20: NO Astro page or component may statically
// import a top-level `src/scripts/*.ts` file. Top-level scripts under
// `src/scripts/` are Pattern B (CSP-imposed self-contained IIFE
// bundles loaded layout-wide via `<script type="module" src="/scripts/
// <name>.js">`). When a page also imports the same module via Vite
// (Pattern A), the module is evaluated TWICE — once as the standalone
// IIFE and once as part of the page's hashed `_astro/*.js` chunk.
// Each evaluation has its own closure with its own listener-
// idempotency flag. Two listeners get registered on `document`. Star
// toggles fire POST + DELETE in parallel and the favourite UI
// silently reverts.
//
// PRs #182, #184, #185 all swung at this and missed because vitest
// evaluates each module once. AD20 captures the failure mode; this
// script is the regression gate.
//
// Pages that genuinely need to share helper code with the standalone
// IIFE must EITHER:
//   (a) move that code under `src/scripts/bundled/` so it's Pattern A
//       only, NOT also exposed as a static IIFE bundle, OR
//   (b) reach the IIFE's exports via a `window.__*` global hook (the
//       pattern card-interactions.ts uses to expose
//       `window.__cardInteractions.init`).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Recursively list every .astro file under a starting directory. */
function listAstroFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listAstroFiles(full));
    } else if (entry.isFile() && extname(entry.name) === '.astro') {
      out.push(full);
    }
  }
  return out;
}

/** List the basenames of every Pattern B script (top-level
 *  src/scripts/*.ts). Excludes the bundled/ subdir which is Pattern A
 *  by convention. */
function patternBScriptNames() {
  const dir = join(REPO_ROOT, 'src/scripts');
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && extname(d.name) === '.ts')
    .map((d) => basename(d.name, '.ts'));
}

/** Catches `from '~/scripts/<name>'`, `from '~/scripts/<name>.ts'`,
 *  and the same with relative `./` or `../` prefixes. The optional
 *  `.ts` extension lets the gate fire even on tooling configs that
 *  enable `allowImportingTsExtensions`. */
const IMPORT_REGEX =
  /from\s+['"](?:~\/scripts|\.{1,2}\/(?:\.{1,2}\/)*scripts)\/([a-zA-Z0-9_-]+)(?:\.ts)?['"]/g;

/** True when the import is type-only (`import type { … } from …`).
 *  Type-only imports are erased by tsc and never reach the bundler;
 *  flagging them would be a false positive. */
function isTypeOnlyImport(line) {
  return /^\s*import\s+type\b/.test(line);
}

function scanDir(rootDir, patternBNames) {
  const offenders = [];
  if (!statSync(rootDir).isDirectory()) return offenders;
  for (const file of listAstroFiles(rootDir)) {
    const src = readFileSync(file, 'utf-8');
    let match;
    IMPORT_REGEX.lastIndex = 0;
    while ((match = IMPORT_REGEX.exec(src)) !== null) {
      const name = match[1];
      if (!patternBNames.includes(name)) continue;
      // Walk back to the start of the line containing this match to
      // skip type-only imports.
      const lineStart = src.lastIndexOf('\n', match.index) + 1;
      const lineEnd = src.indexOf('\n', match.index);
      const line = src.slice(
        lineStart,
        lineEnd === -1 ? src.length : lineEnd,
      );
      if (isTypeOnlyImport(line)) continue;
      offenders.push({
        file,
        importLine: match[0],
        script: name,
      });
    }
  }
  return offenders;
}

const scripts = patternBScriptNames();
const pageOffenders = scanDir(join(REPO_ROOT, 'src/pages'), scripts);
const componentDir = join(REPO_ROOT, 'src/components');
const componentOffenders = (() => {
  try {
    return scanDir(componentDir, scripts);
  } catch {
    return [];
  }
})();
const allOffenders = [...pageOffenders, ...componentOffenders];

if (allOffenders.length === 0) {
  console.log(
    `check-no-page-pattern-b: clean (${scripts.length} Pattern B script(s) audited).`,
  );
  process.exit(0);
}

const report = allOffenders
  .map(
    (o) =>
      `  - ${o.file.replace(`${REPO_ROOT}/`, '')} imports '${o.script}' (Pattern B)\n    → ${o.importLine}`,
  )
  .join('\n');

console.error(
  `${allOffenders.length} page-/component-level import(s) of a Pattern B script detected.\n` +
    `\n` +
    `Top-level src/scripts/*.ts files are loaded via standalone\n` +
    `<script src="/scripts/...">  tags layout-wide. Importing them from a page bundles\n` +
    `the module a SECOND time, which causes duplicate global event listeners and\n` +
    `silently breaks favourites/star toggles.\n` +
    `\n` +
    `See documentation/decisions/README.md AD20 for the full failure mode.\n` +
    `\n` +
    `Fix:\n` +
    `  (a) move the imported helper to src/scripts/bundled/<name>.ts (Pattern A) and\n` +
    `      update the page's import path, OR\n` +
    `  (b) reach the IIFE's API via a window.__* hook (see card-interactions.ts:\n` +
    `      window.__cardInteractions.init).\n` +
    `\n` +
    `Offenders:\n${report}`,
);
process.exit(1);
