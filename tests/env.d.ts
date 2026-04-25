/// <reference types="@cloudflare/vitest-pool-workers" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

// The `env` binding exported by `cloudflare:test` is typed as
// `Cloudflare.Env`. We augment that namespace with the project's
// bindings (kept in sync with src/env.d.ts) so tests using
// `env.DB` / `env.KV` typecheck correctly.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    KV: KVNamespace;
    SCRAPE_COORDINATOR: Queue<import('../src/queue/scrape-coordinator').CoordinatorMessage>;
    SCRAPE_CHUNKS: Queue<import('../src/queue/scrape-chunk-consumer').ChunkJobMessage>;
    AI: Ai;
    ASSETS: Fetcher;
    GITHUB_OAUTH_CLIENT_ID: string;
    GITHUB_OAUTH_CLIENT_SECRET: string;
    GOOGLE_OAUTH_CLIENT_ID: string;
    GOOGLE_OAUTH_CLIENT_SECRET: string;
    OAUTH_JWT_SECRET: string;
    RESEND_API_KEY: string;
    RESEND_FROM: string;
    APP_URL: string;

    // Test-only: migrations list injected by @cloudflare/vitest-pool-workers
    // when `[[d1_databases]].migrations_dir` is set in wrangler.test.toml.
    DB_MIGRATIONS?: import('cloudflare:test').D1Migration[];
  }
}

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

