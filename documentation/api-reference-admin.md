# Admin / Operator API Reference

Operator-facing administrative endpoints. Every route below sits behind the three-layer admin gate. The conventions block at the top centralises behaviours that recur across endpoints; per-endpoint sections name only what differs.

**Audience:** Operators and developers driving the production pipeline.

Extracted from [api-reference.md](api-reference.md) so the main reference stays under its line budget while the admin surface keeps room to breathe.

## Contents

- [Conventions](#conventions)
- [POST /api/admin/force-refresh](#post-apiadminforce-refresh)
- [GET /api/admin/force-refresh](#get-apiadminforce-refresh)
- [POST /api/admin/discovery/retry](#post-apiadmindiscoveryretry)
- [POST /api/admin/discovery/retry-bulk](#post-apiadmindiscoveryretry-bulk)
- [GET /api/admin/discovery/retry-bulk](#get-apiadmindiscoveryretry-bulk)
- [POST /api/admin/embed-backfill](#post-apiadminembed-backfill)
- [GET /api/admin/embed-backfill](#get-apiadminembed-backfill)
- [POST /api/admin/historical-dedup](#post-apiadminhistorical-dedup)
- [GET /api/admin/dedup-status](#get-apiadmindedup-status)
- [POST /api/admin/pipeline-run](#post-apiadminpipeline-run)
- [GET /api/admin/pipeline-run](#get-apiadminpipeline-run)
- [GET /api/admin/pipeline-status](#get-apiadminpipeline-status)
- [GET /api/admin/dedup-diag](#get-apiadmindedup-diag)
- [Related Documentation](#related-documentation)

---

## Conventions

### Three-layer admin gate

Every endpoint in this file authenticates the caller through three layers in order:

1. Cloudflare Access perimeter when `CF_ACCESS_AUD` is set (optional, deploy-time).
2. A valid session cookie minted by the OAuth flow.
3. The session email matching `ADMIN_EMAIL`.

Failure at any layer returns the layer's native deny response (Access challenge, `401 unauthorized`, or `403 forbidden`). In the per-endpoint sections below the canonical Authentication value `session + admin email` denotes this complete gate.

### Bearer / Origin bypass

Browser `POST` calls require an `Origin` header matching `APP_URL`. Scripted callers that present `Authorization: Bearer <DEV_BYPASS_TOKEN>` bypass the Origin check on `POST`, because Bearer requests carry no session cookie and are not a CSRF surface.

### Sec-Fetch-Site guard on admin GET callbacks

Admin `GET` endpoints used as post-SSO callback targets (AD38) enforce a `Sec-Fetch-Site` guard rather than an Origin check. `same-origin` and `none` (top-level navigation, including the post-SSO redirect chain) are allowed; `cross-site` and `cross-origin` receive `403 "Cross-site request denied"`. `curl` and scripted callers send no `Sec-Fetch-Site` header and are unaffected.

### Canonical vocabulary

- **Authentication:** `session + admin email` (with optional CF Access perimeter per the three-layer gate above).
- **Origin check:** `applies` | `exempt` | `n/a (read-only GET)`.

### Error envelope

All error responses are JSON with shape `{ ok: false, error: <slug> }` unless explicitly noted otherwise. Status codes follow standard HTTP semantics.

---

## Endpoints

### POST /api/admin/force-refresh

Kick the global-feed coordinator on demand: identical work to the every-4-hours cron. Used by scripted callers (curl with `Accept: application/json`) and by phase 1 of the **Refresh articles** orchestrator on `/settings`.

```
POST /api/admin/force-refresh
```

**Authentication:** session + admin email
**Origin check:** applies

**Request:** none.

**Response**

| Status | Outcome | Body |
|---|---|---|
| `303` | Success | Redirect to `/settings?force_refresh={ok\|reused}` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `403` | Origin mismatch or not admin | `{ error, code: "forbidden" }` or `{ error, code: "forbidden_origin" }` |
| `429` | Rate limited | `{ error, code: "rate_limit_exceeded" }` |
| `500` | Dispatch failed | `{ error: "Failed to dispatch coordinator" }` |

**Rate limit:** per-operator hourly bucket `admin_force_refresh`; exhausted returns `429` with `Retry-After`.

**Implements:** [REQ-OPS-005](../sdd/observability.md#req-ops-005-admin-force-refresh-endpoint), [REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface) (phase 1), [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9g

**Notes**

Inserts a `scrape_runs` row and sends `SCRAPE_COORDINATOR`. A 120-second reuse window absorbs double-clicks: a new request that finds a `running` row younger than 120s reuses it (`force_refresh=reused`).

---

### GET /api/admin/force-refresh

Browser-direct and scripted variant of the force-refresh kicker. Driven by phase 1 of the **Refresh articles** orchestrator on `/settings` and by scripted callers using `GET` with `Accept: application/json`.

```
GET /api/admin/force-refresh
```

**Authentication:** session + admin email
**Origin check:** n/a (read-only GET; see [Sec-Fetch-Site guard](#sec-fetch-site-guard-on-admin-get-callbacks))

**Request:** none.

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Scripted caller (`Accept: application/json`) | `{ ok: true, scrape_run_id, reused }` |
| `303` | Browser direct | Redirect to `/settings?force_refresh={ok\|reused\|denied}` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `403` | Not admin | `{ error, code: "forbidden" }` |
| `403` | Cross-site initiator | `{ error: "Cross-site request denied" }` |
| `429` | Rate limited | `{ error, code: "rate_limit_exceeded" }` |
| `500` | Dispatch failed | `{ error: "Failed to dispatch coordinator" }` |

**Rate limit:** per-operator hourly bucket `admin_force_refresh`; exhausted returns `429` with `Retry-After`.

**Implements:** [REQ-OPS-005](../sdd/observability.md#req-ops-005-admin-force-refresh-endpoint), [REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface) (phase 1), [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9g

---

### POST /api/admin/discovery/retry

Re-queues a single stuck tag for source discovery. Validates the tag against the user's `hashtags_json`, clears `sources:{tag}` and `discovery_failures:{tag}` from KV, and inserts a `pending_discoveries` row picked up by the 5-minute discovery cron. Used for one-off recovery of a tag that exhausted its retry budget.

```
POST /api/admin/discovery/retry
```

**Authentication:** session + admin email
**Origin check:** applies

**Request body** (JSON or form-encoded)

| Field | Type | Required | Description |
|---|---|---|---|
| `tag` | string | yes | Tag to re-queue |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | JSON path success | `{ ok: true }` |
| `303` | Form path success | Redirect to `/settings?rediscover=ok&tag=<tag>` |
| `400` | Missing tag | `{ error, code: "bad_request" }` |
| `400` | Tag not in user's `hashtags_json` | `{ error, code: "unknown_tag" }` |
| `401` | Not signed in | `{ error, code: "unauthorized" }` |
| `403` | Not admin, or Origin mismatch | `{ error, code: "forbidden" }` or `{ error, code: "forbidden_origin" }` |

**Implements:** [REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover)

**Notes**

The form-encoded path exists because native HTML `POST` form submissions work reliably across Samsung Browser and in-app webviews where JS-driven `fetch` requests are flaky. JSON callers preserve a programmatic contract for scripted recovery.

The `unknown_tag` check is not redundant with admin auth: it bounds the LLM blast radius so an admin can only retry tags they themselves saved, not arbitrary strings posted to the endpoint.

---

### POST /api/admin/discovery/retry-bulk

Re-queues every stuck tag for the signed-in admin in one D1 batch. Backs the **Discover missing sources** button on `/settings` when the in-app fetch path is used. A tag is "stuck" when its `sources:{tag}` KV entry parses to an explicitly empty `feeds` array; brand-new tags with no KV entry yet are not stuck (the cron has not run for them).

```
POST /api/admin/discovery/retry-bulk
```

**Authentication:** session + admin email
**Origin check:** applies

**Request:** none.

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Scripted caller (`Accept: application/json`) | `{ ok: true, count: N }` |
| `303` | Browser form submit | Redirect to `/settings?rediscover=ok&count=<N>` |
| `401` | Not signed in | `{ error, code: "unauthorized" }` |
| `403` | Not admin, or Origin mismatch | `{ error, code: "forbidden" }` or `{ error, code: "forbidden_origin" }` |
| `500` | D1 batch failed | `{ error, code: "internal_error" }` |

**Implements:** [REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover)

**Notes**

The D1 `INSERT OR IGNORE` for `pending_discoveries` rows commits BEFORE the KV `sources:{tag}` / `discovery_failures:{tag}` cleanup. Order is deliberate: if D1 throws the operator sees a 500 and retries cleanly (no partial KV state); if KV cleanup throws after the D1 commit, the next discovery cron pass overwrites the stale KV entry without operator intervention.

---

### GET /api/admin/discovery/retry-bulk

Browser-callback companion to `POST /api/admin/discovery/retry-bulk`. The settings form posts to the POST handler, but when `CF_ACCESS_AUD` is configured Cloudflare Access intercepts the POST, redirects through SSO, and returns the user as a `GET` to the original URL. This handler returns the same operator-visible outcome the POST path would have produced. Scripts with `Accept: application/json` also reach this handler when they prefer GET semantics.

```
GET /api/admin/discovery/retry-bulk
```

**Authentication:** session + admin email
**Origin check:** n/a (post-SSO browser callback target)

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Scripted caller (`Accept: application/json`) | `{ ok: true, count: N }` |
| `303` | Browser redirect | Redirect to `/settings?rediscover={ok\|denied\|error}` |
| `500` | D1 batch failed (JSON path) | `{ ok: false, error: <slug> }` |

**Implements:** [REQ-DISC-004](../sdd/discovery.md#req-disc-004-manual-re-discover)

**Notes**

This GET handler shares the [three-layer admin gate](#three-layer-admin-gate) with every other endpoint in this file (CF-001). Unlike `GET /api/admin/force-refresh`, it does not enforce the [Sec-Fetch-Site guard](#sec-fetch-site-guard-on-admin-get-callbacks): the Cloudflare Access perimeter and the admin-email match are the primary defenses, and an authenticated cross-site `GET` would only re-queue tags the signed-in admin already owns (the blast radius is the same as the POST path).

---

### POST /api/admin/embed-backfill

Resumable embedding backfill with optional full-corpus re-embed via `?reembed=1`.

```
POST /api/admin/embed-backfill
```

**Authentication:** session + admin email
**Origin check:** applies (see [Bearer / Origin bypass](#bearer--origin-bypass) for the scripted-curl exception)

**Query parameters**

| Parameter | Required | Description |
|---|---|---|
| `reembed=1` | No | Flips every row to `embedding_status='failed'` before the loop runs so the entire corpus re-embeds against the current `buildEmbeddingInput` definition. `POST` only. |

**Request:** empty body.

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | One batch processed | `{ ok: true, processed: N, failed: M, remaining: K, done: boolean }` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `403` | Not admin or cross-origin browser POST without Bearer | `{ error, code: "forbidden" }` or `{ error, code: "forbidden_origin" }` |
| `500` | Backfill threw | `{ error: "Backfill failed" }` |

**Implements:** [REQ-PIPE-014](../sdd/generation.md#req-pipe-014-same-story-operator-surfaces) AC 5 (for `?reembed=1`), [REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface) (phases 0 and 3)

**Notes**

Each call processes up to 50 rows oldest-first by `published_at`, embeds them via the AI binding, upserts the vectors into Vectorize, and stamps the row `embedding_status='embedded'`. A row whose embed or upsert fails is stamped `'failed'` and counted under `failed`; the next call retries it. Operators loop the route until `done: true`.

---

### GET /api/admin/embed-backfill

Runs one embedding-backfill batch without the `reembed` flag. Used when the operator needs to iterate the backfill from a browser bookmark or a script that does not want to set a `POST` body.

```
GET /api/admin/embed-backfill
```

**Authentication:** session + admin email
**Origin check:** n/a (read-only GET)

**Request:** none. `?reembed=1` is rejected.

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | One batch processed | `{ ok: true, processed: N, failed: M, remaining: K, done: boolean }` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `403` | Not admin | `{ error, code: "forbidden" }` |
| `405` | `?reembed=1` on GET | `{ error: "reembed requires POST" }` |
| `500` | Backfill threw | `{ error: "Backfill failed" }` |

**Implements:** [REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface) (phases 0 and 3)

---

### POST /api/admin/historical-dedup

Cross-article same-story sweep across the article pool. Two transports: the default kicker path (empty body) enqueues exactly one queue message and returns immediately; the legacy synchronous path runs one bounded batch in the request.

```
POST /api/admin/historical-dedup
```

**Authentication:** session + admin email
**Origin check:** applies (see [Bearer / Origin bypass](#bearer--origin-bypass) for the scripted-curl exception)

**Request body (JSON, optional)**

| Field | Type | Default | Description |
|---|---|---|---|
| `cursor` | `{ pa: number, id: string }` | none | Composite cursor for the synchronous batch path: `pa` is a `published_at` Unix-second lower bound, `id` is the ULID lower bound for equal-time tie-breaking. |
| `batch` | number | `25` (cap `500`) | Batch size for the synchronous path. |

Sending no body invokes the kicker path; sending any of the fields above invokes the synchronous batch path.

**Response**

| Status | Outcome | Body |
|---|---|---|
| `202` | Kicker accepted (empty body) | `{ ok: true, run_id: string, enqueued: true, started_at: number }` |
| `200` | Synchronous batch complete | `{ ok: true, scanned: N, merged: M, remaining: K, next_cursor: { pa, id } \| null, done: boolean, elapsed_ms: T }` |
| `303` | Browser without `Accept: application/json` | Redirect to `/settings?dedup=...` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `403` | Not admin or cross-origin browser POST without Bearer | `{ error, code: "forbidden" }` or `{ error, code: "forbidden_origin" }` |
| `500` | Kicker insert failed | `{ error: "historical_dedup_kick_failed" }` |
| `500` | Sync batch threw | `{ error: "historical_dedup_failed" }` |

**Implements:** [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-core-matching-contract) AC 3, [REQ-PIPE-014](../sdd/generation.md#req-pipe-014-same-story-operator-surfaces) AC 1 + AC 4, [REQ-PIPE-009](../sdd/generation.md#req-pipe-009-llm-re-rank-pass-for-borderline-same-story-candidates), [REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface) (phase 4)

**Notes**

The sweep walks oldest-first by `(published_at, id)`. For each article, Vectorize is queried for top-K matches. Auto-merge-band matches (`>= DEDUP_COSINE_THRESHOLD`) fold into the current (older) article via `mergeAsAltSource` without an LLM call. Borderline-band matches (`>= DEDUP_RERANK_FLOOR`, `< DEDUP_COSINE_THRESHOLD`) go to a binary same-event judgment by the language model and merge only on a positive verdict. Each batch caps rerank calls to prevent budget exhaustion; the cap is logged when hit.

The kicker path inserts a `dedup_runs` audit row, enqueues exactly one `dedup-sweep` queue message, and returns. The queue consumer (`src/queue/dedup-sweep-consumer.ts`) drives the per-batch loop server-side and re-enqueues continuation messages until the corpus tail is reached. The sweep keeps running even if the `/settings` browser tab is closed; clients poll [GET /api/admin/dedup-status](#get-apiadmindedup-status) with the returned `run_id` for live progress. The synchronous path exists for tests and dev-bypass curl flows that drive iteration manually.

---

### GET /api/admin/dedup-status

Polling endpoint for the queue-driven historical-dedup sweep. Returns a snapshot of the named `dedup_runs` row.

```
GET /api/admin/dedup-status
```

**Authentication:** session + admin email
**Origin check:** n/a (read-only GET)

**Query parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `run_id` | string | Yes | ULID returned by the kicker call to `POST /api/admin/historical-dedup`. |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Snapshot returned | `{ ok: true, run_id, status: 'running'\|'done'\|'failed', scanned, merged, batch_count, remaining, last_cursor: { pa, id } \| null, done, failed, error: string \| null, started_at, updated_at }` |
| `400` | Missing `run_id` | `{ error: "missing_run_id" }` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `403` | Not admin | `{ error, code: "forbidden" }` |
| `404` | Run not found | `{ error: "run_not_found" }` |
| `500` | Select failed | `{ error: "dedup_status_select_failed" }` |
| `500` | Stored status invalid | `{ error: "invalid_stored_status" }` |

**Implements:** [REQ-PIPE-014](../sdd/generation.md#req-pipe-014-same-story-operator-surfaces) AC 1 + AC 2, [REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface)

**Notes**

The `/settings` surface polls this every 5 seconds while a sweep is in flight; the queue consumer updates the underlying row after each batch.

---

### POST /api/admin/pipeline-run

Kicker for the backend-driven pipeline run. Used by the **Refresh articles** button on `/settings` and by scripted callers.

```
POST /api/admin/pipeline-run
```

**Authentication:** session + admin email
**Origin check:** applies

**Request body (JSON, optional)**

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | `"full"` \| `"wipe"` | `"full"` | `"wipe"` invalidates every article's embedding before scraping; `"full"` keeps existing embeddings and starts at the scrape phase. |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `202` | Run accepted | `{ ok: true, pipeline_run_id: string, mode: 'full'\|'wipe', current_phase: string, started_at: number }` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `403` | Cross-origin browser POST | `{ error, code: "forbidden_origin" }` |
| `405` | `mode=wipe` via GET | body `Use POST for mode=wipe`, header `Allow: POST` |
| `429` | Rate limited | `{ error, code: "rate_limit_exceeded" }` |
| `500` | Kick failed | `{ error: "pipeline_kick_failed" }` |

**Rate limit:** per-operator hourly bucket `admin_pipeline_run`; exhausted returns `429` with `Retry-After`.

**Implements:** [REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface), [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9g

**Notes**

Creates a `pipeline_runs` audit row and enqueues exactly one `pipeline-jobs` queue message; the consumer (`src/queue/pipeline-consumer.ts`) drives the seven phases server-side without depending on the operator's browser tab.

---

### GET /api/admin/pipeline-run

Browser-navigation variant of the pipeline kicker. Used by `settings.astro` via `window.location.assign()` because Cloudflare Access cannot be traversed by `fetch()` in CORS mode (see [AD38](decisions/README.md#ad38-cf-access-protected-admin-endpoints-must-be-invoked-via-top-level-navigation-not-fetch)).

```
GET /api/admin/pipeline-run
```

**Authentication:** session + admin email
**Origin check:** n/a (top-level navigation per AD38)

**Query parameters**

| Parameter | Values | Default | Description |
|---|---|---|---|
| `mode` | `full` \| `wipe` | `full` | `wipe` invalidates all embeddings before scraping; `full` keeps them. `wipe` via GET is rejected with `405` to block cross-origin GET vectors from triggering a corpus-wide re-embed. |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `303` | Success | Redirect to `/settings?pipeline=enqueued&pipeline_run_id=<ULID>&mode=<mode>` |
| `303` | Auth failure | Redirect to `/settings?pipeline=denied` |
| `405` | `mode=wipe` via GET | body `Use POST for mode=wipe`, header `Allow: POST` |
| `500` | Configuration error | plain text |

**Implements:** [REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface), [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8d

**Notes**

The settings page reads `pipeline_run_id` and `mode` from the URL on load to resume progress polling against [GET /api/admin/pipeline-status](#get-apiadminpipeline-status).

---

### GET /api/admin/pipeline-status

Polling endpoint for the backend-driven full pipeline run.

```
GET /api/admin/pipeline-status
```

**Authentication:** session + admin email
**Origin check:** n/a (read-only GET)

**Query parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | No | ULID of the pipeline run. When omitted, the most recent row is returned (so reopening `/settings` after closing the tab restores progress). |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Snapshot returned | `{ ok: true, pipeline_run_id, status: 'running'\|'done'\|'failed', mode: 'full'\|'wipe', current_phase, embed_processed, embed_remaining, error: string \| null, started_at, updated_at, scrape: { id, status, articles_ingested, articles_deduped, finalize_recorded, started_at, finished_at } \| null, dedup: { id, status, scanned, merged, remaining, started_at, updated_at } \| null, done, failed }` |
| `401` | No session | `{ error, code: "unauthorized" }` |
| `403` | Not admin | `{ error, code: "forbidden" }` |
| `404` | Run not found | `{ error: "run_not_found" }` |
| `500` | Select failed | `{ error: "pipeline_status_select_failed" }` |
| `500` | Stored status or mode invalid | `{ error: "invalid_stored_status" }` or `{ error: "invalid_stored_mode" }` |

**Implements:** [REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface)

**Notes**

Returns the named `pipeline_runs` row plus nested snapshots of the `scrape_runs` and `dedup_runs` rows the pipeline kicked, so the settings surface can paint live progress without driving the orchestration. The settings JS hits this every 5 seconds while a run is in flight.

---

### GET /api/admin/dedup-diag

Pair-similarity diagnostic: returns the cosine similarity between two articles' stored Vectorize embeddings, the same-story threshold, the same-vendor penalty, and a flag for whether the two articles share the same registrable domain (eTLD+1). Intended for evaluating threshold changes against known true-positive and false-positive pairs before committing them to configuration.

```
GET /api/admin/dedup-diag
```

**Authentication:** session + admin email
**Origin check:** n/a (read-only GET)

**Query parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `a` | string | Yes | Article ID of the first article. |
| `b` | string | Yes | Article ID of the second article. Must differ from `a`. |

**Response**

| Status | Outcome | Body |
|---|---|---|
| `200` | Diagnostic returned | See full JSON shape below. |
| `400` | Missing or empty `a` or `b` param | `{ error: "missing_a_or_b" }` |
| `400` | Identical IDs | `{ error: "identical_ids" }` |
| `401` | No session | `{ error: "unauthorized" }` |
| `403` | Not admin | plain text `Forbidden` |
| `404` | Article not found in D1 | `{ error: "article_not_found" }` |
| `404` | Vector not found in Vectorize | `{ error: "vector_not_found" }` |
| `500` | Vectorize lookup threw | `{ error: "vectorize_lookup_failed" }` |

**200 response body shape:**

<!-- doc-allow-element: AD46 dedup-diag response shape, full JSON is the contract -->
```json
{
  "ok": true,
  "a": {
    "id": "string",
    "title": "string",
    "primary_source_url": "string",
    "host": "string",
    "etld1": "string",
    "embedding_status": "embedded" | "failed" | null
  },
  "b": { ... },
  "cosine": 0.87,
  "same_etld1": true,
  "adjusted_score": 0.82,
  "same_vendor_penalty": 0.05,
  "threshold": 0.85,
  "above_threshold": false
}
```

**Implements:** [REQ-PIPE-014](../sdd/generation.md#req-pipe-014-same-story-operator-surfaces) AC 4

**Notes**

`same_etld1` is `true` when both articles' `primary_source_url` values resolve to the same registrable domain via `src/lib/etld.ts:sameVendor` AND neither URL routes through a known aggregator-wrapper host (currently `news.google.com`). Aggregator-wrapper URLs carry no publisher identity at the URL level, so pairs where either article comes from an aggregator host return `same_etld1: false` and do not pay the same-publisher penalty regardless of eTLD+1 match. `threshold` is the value of `DEDUP_COSINE_THRESHOLD` in effect at request time. `same_vendor_penalty` is the value of `DEDUP_SAME_VENDOR_PENALTY`. `adjusted_score` is `cosine - same_vendor_penalty` when `same_etld1` is true, otherwise equals `cosine`; it is the value the dedup decision actually compares to the threshold. `above_threshold` is `adjusted_score >= threshold`.

---

## Related Documentation

- [api-reference.md](api-reference.md) — public + non-admin internal API surface
- [security.md](security.md) — admin auth model, rate limits, dev-route guard
- [decisions/README.md](decisions/README.md) — ADRs for admin-gate decisions (AD29, AD38, AD44)
