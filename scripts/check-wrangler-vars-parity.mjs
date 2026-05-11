// CF-016: fail CI when wrangler.toml's top-level [vars] block and
// [env.integration.vars] block drift apart in KEY set. Production and
// integration must expose the same env-var names so a missing key
// can't silently change behavior on one but not the other. Values
// are allowed to differ (and often do — e.g., feature flags).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tomlPath = resolve(here, '..', 'wrangler.toml');
const text = readFileSync(tomlPath, 'utf-8');

function parseSection(name) {
  // Match a section header on its own line, then read until the next
  // section header or EOF. Strip comments and blank lines.
  const re = new RegExp(`^\\[${name.replace(/\./g, '\\.')}\\]\\s*$`, 'm');
  const m = re.exec(text);
  if (m === null) return null;
  const start = m.index + m[0].length;
  const nextHeader = /^\[/m.exec(text.slice(start));
  const body =
    nextHeader === null ? text.slice(start) : text.slice(start, start + nextHeader.index);
  const keys = new Set();
  for (const line of body.split('\n')) {
    const trimmed = line.replace(/^\s+/, '');
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === '') continue;
    keys.add(key);
  }
  return keys;
}

const prod = parseSection('vars');
const integ = parseSection('env.integration.vars');

if (prod === null) {
  console.error('FAIL: wrangler.toml missing [vars] section');
  process.exit(1);
}
if (integ === null) {
  console.error('FAIL: wrangler.toml missing [env.integration.vars] section');
  process.exit(1);
}

const onlyInProd = [...prod].filter((k) => !integ.has(k));
const onlyInInteg = [...integ].filter((k) => !prod.has(k));

if (onlyInProd.length === 0 && onlyInInteg.length === 0) {
  console.log(`OK: wrangler.toml [vars] and [env.integration.vars] keys match (${prod.size} keys)`);
  process.exit(0);
}

console.error('FAIL: wrangler.toml [vars] and [env.integration.vars] keys diverge.');
if (onlyInProd.length > 0) {
  console.error('  Only in [vars]:                 ' + onlyInProd.sort().join(', '));
}
if (onlyInInteg.length > 0) {
  console.error('  Only in [env.integration.vars]: ' + onlyInInteg.sort().join(', '));
}
process.exit(1);
