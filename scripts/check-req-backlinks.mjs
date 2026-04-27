#!/usr/bin/env node
// CF-069: REQ backlink coverage gate.
//
// Scans source, test, and doc files for `REQ-[A-Z]+-\d+` references
// and verifies every distinct ID resolves to a header in `sdd/`.
// Fails (exit 1) on any orphan ID so the build cannot ship a code or
// doc reference that points at a non-existent requirement.
//
// Greenfield rule — no fancy parsing. We grep the substring `REQ-X-NNN`
// out of every tracked text file and check that the same substring
// appears as a header anchor in `sdd/`.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'tests', 'documentation', 'migrations'];
const SDD_DIR = 'sdd';

// File extensions worth scanning. Excludes binaries and lock files.
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.astro',
  '.md', '.sql', '.html', '.css', '.yml', '.yaml', '.json', '.toml',
]);

// Sub-paths to skip even under SCAN_DIRS.
const SKIP_PATHS = ['node_modules', '.git', 'dist', '.astro', 'build'];

const REQ_RE = /REQ-[A-Z]+-\d+/g;

function walkSync(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_PATHS.includes(entry)) continue;
    const p = join(dir, entry);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) {
      out.push(...walkSync(p));
    } else if (s.isFile()) {
      const ext = extname(p).toLowerCase();
      if (TEXT_EXT.has(ext) || ext === '') out.push(p);
    }
  }
  return out;
}

function findAllRefs() {
  const refs = new Map(); // id -> Set<file>
  for (const dir of SCAN_DIRS) {
    const abs = join(ROOT, dir);
    let files;
    try { files = walkSync(abs); } catch { continue; }
    for (const file of files) {
      let body;
      try { body = readFileSync(file, 'utf8'); } catch { continue; }
      const matches = body.match(REQ_RE);
      if (matches === null) continue;
      for (const id of matches) {
        if (!refs.has(id)) refs.set(id, new Set());
        refs.get(id).add(file.slice(ROOT.length + 1));
      }
    }
  }
  return refs;
}

function findSddIds() {
  // Only count IDs that appear in a markdown header line (`#`-prefixed)
  // — that's where the spec defines a requirement. IDs that appear
  // only in prose (e.g., the "Out of Scope" list in sdd/README.md, the
  // "Replaced By:" lines in deprecated REQs, or sdd/changes.md prose)
  // are NOT definitions and must not satisfy the backlink gate.
  // Without this, a stale reference to a retired REQ would silently
  // pass — defeating the gate's purpose.
  const ids = new Set();
  let files;
  try { files = walkSync(join(ROOT, SDD_DIR)); } catch { return ids; }
  for (const file of files) {
    if (extname(file).toLowerCase() !== '.md') continue;
    let body;
    try { body = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of body.split('\n')) {
      if (!/^#{1,6}\s/.test(line)) continue;
      const matches = line.match(REQ_RE);
      if (matches === null) continue;
      for (const id of matches) ids.add(id);
    }
  }
  return ids;
}

const refs = findAllRefs();
const sdd = findSddIds();

const orphans = [];
for (const [id, files] of refs) {
  if (!sdd.has(id)) orphans.push({ id, files: [...files].sort() });
}
orphans.sort((a, b) => a.id.localeCompare(b.id));

if (orphans.length === 0) {
  console.log(`req-backlinks: OK — ${refs.size} unique REQ ids, all resolve to sdd/`);
  process.exit(0);
}

console.error(`req-backlinks: FAIL — ${orphans.length} orphan REQ id(s) referenced outside sdd/:`);
for (const { id, files } of orphans) {
  console.error(`  ${id}`);
  for (const f of files) console.error(`    ${f}`);
}
process.exit(1);
