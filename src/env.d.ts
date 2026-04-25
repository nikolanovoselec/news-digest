/// <reference types="astro/client" />
/// <reference types="@astrojs/cloudflare" />

declare namespace App {
  interface Locals extends Runtime {
    user?: import('./lib/types').AuthenticatedUser;
  }
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

interface Env {
  // Bindings
  DB: D1Database;
  KV: KVNamespace;
  SCRAPE_COORDINATOR: Queue<import('./queue/scrape-coordinator').CoordinatorMessage>;
  SCRAPE_CHUNKS: Queue<import('./queue/scrape-chunk-consumer').ChunkJobMessage>;
  AI: Ai;
  ASSETS: Fetcher;

  // Secrets
  //
  // Per-provider OAuth credentials. Each pair is independently optional —
  // a deployment configures the providers it wants and the landing page
  // renders one button per configured provider, alphabetically. At least
  // one provider must be configured for the app to function (the deploy
  // workflow enforces this).
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;

  // Session-cookie HMAC key (REQ-AUTH-002) — required regardless of
  // which providers are enabled.
  OAUTH_JWT_SECRET: string;

  RESEND_API_KEY: string;
  RESEND_FROM: string;
  APP_URL: string;
}
