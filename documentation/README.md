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
| [Decisions](decisions/README.md) | Architecture Decision Records | Developers |

---

## Glossary

The codebase historically used several names for the same concepts. The canonical names are:

| Canonical name | Aliases (do not use) | Definition |
|---|---|---|
| **article pool** | "global pool", "global article pool", "populated pool" | The set of summarised articles produced by the most recent global scrape; rendered identically to every user |
| **scrape run** | "scrape tick", "tick", "cron tick" | One end-to-end execution of the global-feed pipeline: coordinator → chunks → finalize |
| **chunk** | — | One LLM-summarisation message produced by the coordinator and processed by `scrape-chunk-consumer` |
| **finalize pass** | "dedup pass" | The cross-chunk semantic-dedup phase that runs after the last chunk completes (REQ-PIPE-008) |
| **update-in-progress indicator** | "in-flight progress display" | The `/digest` and `/settings` UI element that polls `GET /api/scrape-status` while a scrape run is active |

When writing or reviewing documentation, use only the canonical names. The aliases column exists so readers searching the codebase or older docs can resolve old names to the current term.

## Related

- [Product Specification](../sdd/README.md) — Requirements and design intent
- [Project README](../README.md) — Project overview and quickstart
