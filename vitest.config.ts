import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';

// Read the D1 migration SQL at config-load time so integration tests
// (schema-0003.test.ts, cleanup.test.ts) can call applyD1Migrations
// with a real migrations array instead of the empty list.
const migrations = await readD1Migrations(
  fileURLToPath(new URL('./migrations', import.meta.url)),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.toml' },
      miniflare: {
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          DB_MIGRATIONS: migrations
        }
      }
    })
  ],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Suppress structured-log noise from src/lib/log.ts during tests.
    // Real failures still print via vitest's own reporter.
    silent: true,
    // Compact per-file output in CI — a dot per passing test, a full
    // stack for failing tests. The default reporter prints every
    // single test name + file which floods the GitHub Actions log
    // (800+ test lines on every push). dot mode keeps the summary
    // + failure diff but drops the per-test noise.
    reporters: process.env['CI'] === 'true' ? ['dot'] : ['default'],
    // Drop the per-task timing noise in CI — still shown in local runs.
    printConsoleTrace: false
  }
});
