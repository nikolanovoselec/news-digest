# Deployment

**Audience:** Developers, Operators

Local development setup and production deployment steps.

---

## Prerequisites

- Node.js 20+ (local dev only; production runs on Cloudflare Workers)
- Cloudflare account with Workers Paid plan enabled
- GitHub OAuth App created (Settings → Developer Settings → OAuth Apps)
- Resend account with a verified sending domain
- `wrangler` CLI installed (`npm i -g wrangler` or use `npx wrangler`)

## Local Development

```bash
npm install
npx wrangler d1 migrations apply DB --local
npm run dev
```

The dev server runs at `http://localhost:4321`.

## Tests

```bash
npm test
```

Tests are organized so each test references a REQ ID — `spec-reviewer` reads test files to verify which Implemented REQs have automated coverage. Example:

```typescript
test('REQ-AUTH-003: rejects state-changing requests without matching Origin', () => {
  // ...
});
```

## Production Deployment

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

Or via GitHub Actions (`.github/workflows/deploy.yml`), which:
1. Runs tests.
2. Applies D1 migrations against the production database.
3. Pushes Worker secrets (Resend credentials, etc.) via `wrangler secret put`.
4. Deploys the Worker.
5. Smoke-tests `GET /` against the `*.workers.dev` URL parsed from wrangler deploy output (falls back to `APP_URL` secret if the parse fails). Accepts `200` or `303` as passing.

### Environment-specific configuration

| Environment | Branch | Notes |
|---|---|---|
| Development | any local | `wrangler d1 --local`; dev server at localhost:4321 |
| Production | `main` | CI deploys on push to main |

## Cloudflare Resources

| Resource | Type | Name | Purpose |
|---|---|---|---|
| `DB` | D1 database | `news-digest` | Primary store |
| `KV` | KV namespace | `news-digest-kv` | Caches |
| `DIGEST_JOBS` | Queue | `digest-jobs` | Scheduled + manual digest generation |
| `AI` | Workers AI | (account-level) | LLM inference |

## Resend domain verification

1. Log in to Resend dashboard.
2. Add the sending domain under "Domains".
3. Copy the DNS records (MX, TXT for SPF, DKIM CNAMEs, DMARC TXT) into your DNS provider.
4. Wait for verification (typically minutes to hours).
5. Update the `RESEND_FROM` Worker secret to use an address on the verified domain.
6. Until verified, Resend sends from a sandbox address — useful for local dev, not for users.

---

## Related Documentation

- [Configuration](configuration.md) — Env vars and secrets
- [Architecture](architecture.md) — System overview
