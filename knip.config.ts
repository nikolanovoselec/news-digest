import type { KnipConfig } from 'knip';

// Production entry points + test/config files Knip should treat as root.
// Phase-scaffold tolerances were removed once the corresponding code was
// imported by real entry points.

const config: KnipConfig = {
  entry: [
    'src/pages/**/*.{astro,ts}',
    'src/middleware/index.ts',
    'src/worker.ts',
    'src/scripts/**/*.ts', // imported from .astro <script> tags which knip can't trace
    'public/theme-init.js',
    'scripts/*.mjs', // build/CI helpers invoked from package.json scripts
    'tests/e2e/**/*.spec.ts', // Playwright suite — picked up by playwright.config.ts at runtime
    'playwright.config.ts'
  ],
  project: ['src/**/*.{ts,astro}', 'tests/e2e/**/*.ts'],
  ignoreDependencies: [
    'tailwindcss', // resolved transitively via @tailwindcss/vite plugin
    'cloudflare', // `cloudflare:test` virtual module shipped by @cloudflare/vitest-pool-workers
    '@playwright/test' // imported only from tests/e2e — Playwright config drives discovery
  ],
  ignoreExportsUsedInFile: true,
  ignore: []
};

export default config;
