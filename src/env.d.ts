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
  SCRAPE_FINALIZE: Queue<import('./queue/scrape-finalize-consumer').FinalizeJobMessage>;
  AI: Ai;
  ASSETS: Fetcher;

  // Secrets
  //
  // Per-provider OAuth credentials. Each pair is independently optional —
  // a deployment configures the providers it wants and the landing page
  // renders one button per configured provider, alphabetically. At least
  // one provider must be configured for the app to function (the deploy
  // workflow enforces this).
  GH_OAUTH_CLIENT_ID: string;
  GH_OAUTH_CLIENT_SECRET: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;

  // Session-cookie HMAC key (REQ-AUTH-002) — required regardless of
  // which providers are enabled.
  OAUTH_JWT_SECRET: string;

  RESEND_API_KEY: string;
  RESEND_FROM: string;
  APP_URL: string;

  // Admin gate (REQ-AUTH-001 / CF-001) — operator email that, when matched
  // against the session user's email, unlocks `/api/admin/*`. Required for
  // production; dev environments may leave it unset (admin routes 401).
  ADMIN_EMAIL: string;

  // Cloudflare Access audience tag (REQ-AUTH-001 / CF-001) — when set,
  // admin routes verify the `aud` claim of the `Cf-Access-Jwt-Assertion`
  // header against this value. When unset, only the header presence is
  // required.
  CF_ACCESS_AUD?: string;

  // Optional dev bypass token (REQ-AUTH-001 / CF-064) — Bearer token gating
  // `/api/dev/login` for local + e2e flows. When unset, the dev login
  // endpoint returns 404.
  DEV_BYPASS_TOKEN?: string;
  DEV_BYPASS_USER_ID?: string;
}
