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
    // `imageService: 'compile'` runs sharp only during the build to
    // optimise prerendered images; the deployed Worker never touches
    // sharp, which isn't available in workerd. Silences the "sharp at
    // runtime" adapter warning.
    imageService: 'compile'
    // scheduled + queue handlers are merged into the built worker by
    // scripts/merge-worker-handlers.mjs, which runs after `astro build`
    // (see the `build` script in package.json). It bundles src/worker.ts
    // with esbuild and writes dist/_worker.js/_merged.mjs — which is
    // what wrangler deploys (see `main` in wrangler.toml). The adapter's
    // workerEntryPoint option produced an invalid merged worker, so we
    // compose the handlers ourselves instead.
  }),
  // Astro 5 Sessions are enabled by default on adapters that support
  // them (Cloudflare is one). We don't use `Astro.session` anywhere —
  // session state rides on the HMAC-signed __Host-news_digest_session
  // cookie (REQ-AUTH-002). Reusing our existing `KV` binding for
  // Astro's session driver silences the "Invalid binding `SESSION`"
  // advisory without wasting a KV namespace, and has no runtime cost
  // because nothing in the app reads or writes the session.
  session: {
    driver: 'cloudflare-kv-binding',
    options: { binding: 'KV' }
  },
  integrations: [
    AstroPWA({
      registerType: 'autoUpdate',
      manifest: false, // we ship our own /manifest.webmanifest
      workbox: {
        // Force-activate every new SW build immediately and take over
        // open clients on the next paint. Without this, a user whose
        // SW was installed before a deploy keeps serving stale HTML
        // whose `<script src=hash.js>` points at assets that no
        // longer exist — which surfaces as "the button does nothing"
        // because the handler's bundle never loads. The combination
        // below makes deploys visible on next navigation instead of
        // after the browser idle-timer happens to expire the SW.
        skipWaiting: true,
        clientsClaim: true,
        // Never cache the in-progress digest or failure page. Both
        // are status-dependent and must always reflect the current
        // server state, including the latest JS bundle for the
        // Try-again handler.
        navigateFallback: null,
        runtimeCaching: [
          {
            urlPattern: /^\/digest\/failed/,
            handler: 'NetworkOnly'
          },
          {
            urlPattern: /^\/digest\/.*/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'digest-cache-v2',
              networkTimeoutSeconds: 3
            }
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
