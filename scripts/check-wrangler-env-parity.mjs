#!/usr/bin/env node
// Implements CF-005 + CF-020 + CF-007 sub-(e).
//
// Parses wrangler.toml and asserts:
//   1. Every queue consumer's `max_retries` literal matches
//      MAX_QUEUE_ATTEMPTS in src/lib/queue-handler.ts (CF-005).
//   2. The set of binding names declared at top-level matches the set
//      under `[env.integration.*]` (CF-020). New bindings added to
//      production must propagate to integration; integration must not
//      declare bindings absent from production. Resource ids/queue
//      names are excluded — they're expected to differ by design.
//
// Wired into .github/workflows/test.yml as a separate step before the
// vitest job, so a binding-shape drift fails CI before queue-handler
// retries silently regress.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

const WRANGLER_TOML = resolve(ROOT, 'wrangler.toml');
const QUEUE_HANDLER_TS = resolve(ROOT, 'src/lib/queue-handler.ts');

/**
 * Extract MAX_QUEUE_ATTEMPTS from queue-handler.ts via plain regex.
 * Avoids loading TS or pulling in a parser; the constant is a single
 * literal at module top-level.
 */
async function readMaxQueueAttempts() {
  const src = await readFile(QUEUE_HANDLER_TS, 'utf-8');
  // Strip line comments and JSDoc-style continuation lines BEFORE the
  // regex match. A naive `/MAX_QUEUE_ATTEMPTS\s*=\s*(\d+)/` returns the
  // first numeric mention, which could land on a JSDoc reference like
  // `// previously MAX_QUEUE_ATTEMPTS = 5 before lowering to 3` and
  // silently fail-open on a parity drift.
  const codeOnly = src
    .split('\n')
    .map((l) => {
      const trimmed = l.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return '';
      return l;
    })
    .join('\n');
  // Anchor to start-of-line + multiline flag so the match must be the
  // actual `const MAX_QUEUE_ATTEMPTS = N;` declaration, not a phrase
  // appearing later in a string or template literal.
  const m = codeOnly.match(/^\s*(?:export\s+)?const\s+MAX_QUEUE_ATTEMPTS\s*=\s*(\d+)\s*;?\s*$/m);
  if (!m) {
    throw new Error(
      `MAX_QUEUE_ATTEMPTS declaration not found in ${QUEUE_HANDLER_TS}. ` +
        `Expected exactly one line of the form 'const MAX_QUEUE_ATTEMPTS = <N>;'. ` +
        `If you renamed it or moved it into another module, update scripts/check-wrangler-env-parity.mjs.`,
    );
  }
  return Number.parseInt(m[1], 10);
}

/**
 * Tokenise wrangler.toml into a sequence of section-headers and
 * key=value pairs. We don't need a full TOML parser — just enough to
 * walk `[[queues.consumers]]` blocks and binding declarations.
 */
async function parseWrangler() {
  const src = await readFile(WRANGLER_TOML, 'utf-8');
  const lines = src.split(/\r?\n/);
  const sections = []; // { header, body: string[] }
  let current = { header: '__root__', body: [] };
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[[') && line.endsWith(']]')) {
      sections.push(current);
      current = { header: line.slice(2, -2), body: [], double: true };
    } else if (line.startsWith('[') && line.endsWith(']')) {
      sections.push(current);
      current = { header: line.slice(1, -1), body: [], double: false };
    } else {
      current.body.push(line);
    }
  }
  sections.push(current);
  return sections;
}

/**
 * Pull `key = value` from a section body, returning the bare value
 * (string or numeric).
 */
function bodyValue(body, key) {
  for (const line of body) {
    const m = line.match(new RegExp(`^${key}\\s*=\\s*(.+)$`));
    if (m) {
      const raw = m[1].trim().replace(/^"|"$/g, '');
      const asNum = Number(raw);
      return Number.isFinite(asNum) && raw !== '' ? asNum : raw;
    }
  }
  return undefined;
}

/**
 * Collect all queue-consumer max_retries values per env scope.
 * Returns a list of { env, queue, value }.
 */
function collectMaxRetries(sections) {
  const out = [];
  for (const s of sections) {
    if (!s.double) continue;
    if (s.header === 'queues.consumers') {
      out.push({
        env: 'production',
        queue: bodyValue(s.body, 'queue'),
        value: bodyValue(s.body, 'max_retries'),
      });
    } else if (s.header === 'env.integration.queues.consumers') {
      out.push({
        env: 'integration',
        queue: bodyValue(s.body, 'queue'),
        value: bodyValue(s.body, 'max_retries'),
      });
    }
  }
  return out;
}

/**
 * Collect binding shape (name + type) per env scope.
 * Type is the section header noun: d1_databases / kv_namespaces /
 * queues.producers / queues.consumers / ai.
 */
function collectBindings(sections) {
  const prod = new Set();
  const integ = new Set();
  for (const s of sections) {
    let env = null;
    let kind = null;
    if (s.double && s.header === 'd1_databases') {
      env = 'production';
      kind = 'd1_databases';
    } else if (s.double && s.header === 'kv_namespaces') {
      env = 'production';
      kind = 'kv_namespaces';
    } else if (s.double && s.header === 'queues.producers') {
      env = 'production';
      kind = 'queues.producers';
    } else if (s.double && s.header === 'queues.consumers') {
      env = 'production';
      kind = 'queues.consumers';
    } else if (!s.double && s.header === 'ai') {
      env = 'production';
      kind = 'ai';
    } else if (s.double && s.header === 'env.integration.d1_databases') {
      env = 'integration';
      kind = 'd1_databases';
    } else if (s.double && s.header === 'env.integration.kv_namespaces') {
      env = 'integration';
      kind = 'kv_namespaces';
    } else if (s.double && s.header === 'env.integration.queues.producers') {
      env = 'integration';
      kind = 'queues.producers';
    } else if (s.double && s.header === 'env.integration.queues.consumers') {
      env = 'integration';
      kind = 'queues.consumers';
    } else if (!s.double && s.header === 'env.integration.ai') {
      env = 'integration';
      kind = 'ai';
    }
    if (env === null) continue;
    // Use binding for d1/kv/producers, queue for consumers, kind alone for ai.
    let key;
    if (kind === 'queues.consumers') {
      const q = bodyValue(s.body, 'queue');
      key = `${kind}:${q}`;
    } else if (kind === 'ai') {
      key = `ai:${bodyValue(s.body, 'binding') ?? 'AI'}`;
    } else {
      const b = bodyValue(s.body, 'binding');
      key = `${kind}:${b}`;
    }
    if (env === 'production') prod.add(key);
    else integ.add(key);
  }
  return { prod, integ };
}

/**
 * Strip the `-integration` suffix from queue names so the parity diff
 * compares production `scrape-coordinator` against integration
 * `scrape-coordinator-integration` symmetrically.
 */
function normalizeKeys(set) {
  return new Set(
    Array.from(set).map((k) => k.replace(/-integration\b/g, '')),
  );
}

async function main() {
  const errors = [];
  const max = await readMaxQueueAttempts();
  const sections = await parseWrangler();

  // Check 1: max_retries parity.
  for (const r of collectMaxRetries(sections)) {
    if (typeof r.value !== 'number') {
      errors.push(
        `wrangler.toml [env=${r.env}] queue=${r.queue}: missing max_retries`,
      );
      continue;
    }
    if (r.value !== max) {
      errors.push(
        `wrangler.toml [env=${r.env}] queue=${r.queue}: max_retries=${r.value} ` +
          `but src/lib/queue-handler.ts MAX_QUEUE_ATTEMPTS=${max} (mirror drift)`,
      );
    }
  }

  // Check 2: binding-shape parity (excluding ids and queue suffix).
  const { prod, integ } = collectBindings(sections);
  const prodNorm = normalizeKeys(prod);
  const integNorm = normalizeKeys(integ);
  const prodOnly = [...prodNorm].filter((k) => !integNorm.has(k));
  const integOnly = [...integNorm].filter((k) => !prodNorm.has(k));
  for (const k of prodOnly) {
    errors.push(
      `wrangler.toml binding-shape drift: '${k}' declared at top-level but ` +
        `missing under [env.integration.*]. Add the integration mirror.`,
    );
  }
  for (const k of integOnly) {
    errors.push(
      `wrangler.toml binding-shape drift: '${k}' declared under ` +
        `[env.integration.*] but missing at top-level. Production must ` +
        `declare every binding integration uses.`,
    );
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e}`);
    process.exit(1);
  }
  console.log(
    `wrangler-env parity OK — max_retries=${max} mirrored across ` +
      `${prodNorm.size} bindings.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
