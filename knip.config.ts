import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    'src/pages/**/*.{astro,ts}',
    'src/worker.ts',
    'src/queue/digest-consumer.ts',
    'public/theme-init.js'
  ],
  project: ['src/**/*.{ts,astro}'],
  ignoreDependencies: ['@astrojs/cloudflare', 'tailwindcss'],
  ignore: ['**/*.test.ts']
};

export default config;
