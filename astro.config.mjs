import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';
import AstroPWA from '@vite-pwa/astro';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    platformProxy: {
      enabled: true
    }
    // scheduled + queue handlers are merged into the built worker by
    // scripts/merge-worker-handlers.mjs, which runs after `astro build`
    // (see the `build` script in package.json). It bundles src/worker.ts
    // with esbuild and writes dist/_worker.js/_merged.mjs — which is
    // what wrangler deploys (see `main` in wrangler.toml). The adapter's
    // workerEntryPoint option produced an invalid merged worker, so we
    // compose the handlers ourselves instead.
  }),
  integrations: [
    AstroPWA({
      registerType: 'autoUpdate',
      manifest: false, // we ship our own /manifest.webmanifest
      workbox: {
        runtimeCaching: [
          {
            urlPattern: /^\/digest\/.*/,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'digest-cache-v1' }
          },
          {
            urlPattern: /^\/api\/.*/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache-v1',
              networkTimeoutSeconds: 3
            }
          }
        ]
      }
    })
  ],
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '~': '/src'
      }
    }
  }
});
