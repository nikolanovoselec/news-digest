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
  /** Legacy per-user digest queue. Wire-level binding is removed from
   * wrangler.toml in Gate B of the global-feed rework; the type is kept
   * alive here so the legacy `src/queue/digest-consumer.ts` and the
   * soon-to-be-410'd refresh endpoint still typecheck until Wave 3
   * retires them. */
  DIGEST_JOBS: Queue<DigestJobMessage>;
  AI: Ai;
  ASSETS: Fetcher;

  // Secrets
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET: string;
  OAUTH_JWT_SECRET: string;
  RESEND_API_KEY: string;
  RESEND_FROM: string;
  APP_URL: string;
}

interface DigestJobMessage {
  trigger: 'scheduled' | 'manual';
  user_id: string;
  local_date: string;
  digest_id?: string;
}
