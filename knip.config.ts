import type { KnipConfig } from 'knip';

// Phase 0 scaffold: several planned deps and types are not yet consumed by
// code. They are ignored here and the ignores will be removed as phases add
// the corresponding imports.

const config: KnipConfig = {
  entry: [
    'astro.config.mjs',
    'vitest.config.ts',
    'src/env.d.ts',
    'src/pages/**/*.{astro,ts}',
    'src/worker.ts',
    'src/queue/digest-consumer.ts',
    'public/theme-init.js'
  ],
  project: ['src/**/*.{ts,astro}'],
  ignoreDependencies: [
    'fast-xml-parser', // consumed by src/lib/sources.ts in Phase 5
    'zod', // consumed by validation schemas added in Phase 2+
    '@vite-pwa/astro', // Astro integration, loaded via astro.config.mjs
    'tailwindcss', // resolved transitively via @tailwindcss/vite plugin
    '@astrojs/check' // used by `astro check` CLI
  ],
  ignoreExportsUsedInFile: true,
  ignore: ['**/*.test.ts', 'src/lib/types.ts']
};

export default config;
