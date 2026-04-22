import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwind from '@astrojs/tailwind';
import { VitePWA } from '@vite-pwa/astro';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    platformProxy: {
      enabled: true
    }
  }),
  integrations: [
    tailwind(),
    VitePWA({
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
    resolve: {
      alias: {
        '~': '/src'
      }
    }
  }
});
