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
    },
    // Use our src/worker.ts as the Module Worker entry so scheduled + queue
    // handlers are shipped alongside Astro's generated fetch handler.
    workerEntryPoint: {
      path: 'src/worker.ts',
      namedExports: ['scheduled', 'queue']
    }
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
