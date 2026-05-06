# news-digest — Documentation

**Audience:** Developers, Operators

This is the implementation documentation. The product specification (what the system does and why) lives at [`sdd/README.md`](../sdd/README.md). This folder describes how the system actually works.

---

## Index

| Document | Description | Audience |
|----------|-------------|----------|
| [Architecture](architecture.md) | System overview, components, data flow | Developers |
| [API Reference](api-reference.md) | All endpoints — public, internal, request/response formats | Developers |
| [Configuration](configuration.md) | Environment variables, secrets, Cloudflare bindings | Developers, Operators |
| [Deployment](deployment.md) | Dev setup, deployment steps, CI secrets | Developers, Operators |
| [Security](security.md) | CSP, HSTS, cookie policy, rate limiting | Developers, Operators |
| [Decisions](decisions/README.md) | Architecture Decision Records | Developers |

---

## Glossary

The codebase and the product spec (`sdd/`) use several names interchangeably for the same concepts. This table is a reading aid — both columns are valid in the wild, and the right column lists synonyms you'll hit while searching.

| Term used in this folder | Synonyms used elsewhere | Definition |
|---|---|---|
| **article pool** | "global pool", "global article pool", "shared article pool", "populated pool" | The set of summarised articles produced by the most recent global scrape; rendered identically to every user |
| **scrape run** | "scrape tick", "tick" (only in scrape-pipeline contexts) | One end-to-end execution of the global-feed pipeline: coordinator → chunks → finalize |
| **chunk** | — | One LLM-summarisation message produced by the coordinator and processed by `scrape-chunk-consumer` |
| **finalize pass** | "cross-chunk dedup pass", "dedup pass" | The same-story semantic-dedup phase that runs after the last chunk completes ([REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-across-the-entire-article-history)) |
| **update-in-progress indicator** | "in-flight progress display" | The `/digest` and `/settings` UI element that polls `GET /api/scrape-status` while a scrape run is active |

New prose written in this folder should prefer the left column for consistency. Note: "tick" by itself remains the natural term for cron firings (e.g., "the every-5-minute tick fires the email dispatcher"); use it as a synonym for "scrape run" only when context makes the pipeline-execution meaning unambiguous.

## Related Documentation

- [Product Specification](../sdd/README.md) — Requirements and design intent
- [Project README](../README.md) — Project overview and quickstart
