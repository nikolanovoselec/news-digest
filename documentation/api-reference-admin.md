# Admin / Operator API Reference

Operator-facing administrative endpoints. Every route below requires the three-layer admin gate: Cloudflare Access perimeter (when `CF_ACCESS_AUD` is set), a valid session cookie, and the session email matching `ADMIN_EMAIL`.

**Audience:** Operators and developers driving the production pipeline.

Extracted from [api-reference.md](api-reference.md) so the main reference stays under its line budget while the admin surface keeps room to breathe.

---

### POST /api/admin/force-refresh (also GET)

**Method:** POST (also GET — see method table below)
**Path:** /api/admin/force-refresh
**Auth:** Three-layer admin gate (CF Access when `CF_ACCESS_AUD` set + session + `ADMIN_EMAIL`). POST: Origin check. GET: `Sec-Fetch-Site` guard.
**Request:** none

Kicks the global-feed coordinator on demand — identical to the every-4-hours cron. Inserts a `scrape_runs` row, sends `SCRAPE_COORDINATOR`. A 120-second reuse window absorbs double-clicks: a new request that finds a `running` row younger than 120 s reuses it.

POST enforces Origin for browser-driven calls. GET enforces a `Sec-Fetch-Site` guard: `same-origin` and `none` (top-level navigation, including the post-SSO AD38 redirect chain) are allowed; `cross-site` and `cross-origin` receive `403 "Cross-site request denied"`. `curl` and scripted callers send no `Sec-Fetch-Site` header and are unaffected. Scripted callers that present `Authorization: Bearer <DEV_BYPASS_TOKEN>` bypass the Origin check on POST — Bearer requests carry no session cookie and are not a CSRF surface.

| Method | Caller | Success response |
|---|---|---|
| `POST` | Form submit (legacy; the Administration buttons on `/settings` use `GET` with `Accept: application/json`) | `303` → `/settings?force_refresh={ok\|reused}` |
| `GET` | Browser direct | `303` → `/settings?force_refresh={ok\|reused\|denied}` |
| `GET` | Scripted, **Full pipeline run**, or **Refresh feeds** orchestrator (`Accept: application/json`) | `200 { ok: true, scrape_run_id, reused }` |

**Rate limit:** Per-operator hourly bucket (`admin_force_refresh`). Exhausted → `429` surfaced to the settings surface with `Retry-After` (REQ-AUTH-001 AC 9g).

**Error responses:** `401 unauthorized` | `403 forbidden` | `403 "Cross-site request denied"` (GET cross-site initiator) | `429 rate_limit_exceeded` | `500 "Failed to dispatch coordinator"`.

**Implements:** [REQ-OPS-005](../sdd/observability.md#req-ops-005-admin-force-refresh-endpoint), [REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface) (phase 1), [REQ-PIPE-001](../sdd/generation.md#req-pipe-001-global-scrape-and-summarise-pipeline-on-a-fixed-cadence), [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9g

---

### POST /api/admin/embed-backfill

**Method:** POST (also GET — see method table below)
**Path:** /api/admin/embed-backfill
**Auth:** Admin session. Browser POST requires Origin matching `APP_URL`; `Authorization: Bearer <DEV_BYPASS_TOKEN>` bypasses Origin check.
**Request:** none (empty body); `?reembed=1` forces full corpus re-embed (POST only)
**Response:** `200 { ok, processed, failed, remaining, done }` | `401` | `403` | `405 "reembed requires POST"` | `500`

Resumable embedding backfill for articles whose `embedding_status` is `NULL` or `'failed'`. Each call processes up to 50 rows oldest-first by `published_at`, embeds them via the AI binding, upserts the vectors into Vectorize, and stamps the row `embedding_status='embedded'`. Operators loop the route until `done: true`.

| Method | Auth | Request body | Query params |
|---|---|---|---|
| `POST` | Admin session | empty | `?reembed=1` (optional) — flips every row to `embedding_status='failed'` before the loop runs so the entire corpus re-embeds against the current `buildEmbeddingInput` definition. Requires `POST`; `GET` with `?reembed=1` returns `405`. |
| `GET` | Admin session | empty | none — runs one batch without the reembed flag |

**Success (200):** `{ ok: true, processed: N, failed: M, remaining: K, done: boolean }` — `done` is `true` when `remaining` is 0 after the call. A row whose embed or upsert fails is stamped `'failed'` and counted under `failed`; the next call retries it.

**Auth:** Admin session required. Browser POST requires an `Origin` matching `APP_URL`; requests presenting `Authorization: Bearer <DEV_BYPASS_TOKEN>` bypass the Origin check (scripted curl path).

**Error responses:** `401 unauthorized` | `403 forbidden` | `403 forbidden_origin` (cross-origin browser POST without Bearer) | `405 "reembed requires POST"` (GET with `?reembed=1`) | `500 "Backfill failed"`.

**Implements:** [REQ-PIPE-014](../sdd/generation.md#req-pipe-014-same-story-operator-surfaces) AC 5 (for `?reembed=1`), [REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface) (phases 0 and 3)

---

### POST /api/admin/historical-dedup

**Method:** POST
**Path:** /api/admin/historical-dedup
**Auth:** Admin session. Browser POST requires Origin matching `APP_URL`; `Authorization: Bearer <DEV_BYPASS_TOKEN>` bypasses Origin check.
**Request:** empty body (kicker path) or `{ "cursor"?: { "pa": number, "id": string }, "batch"?: number }` (scripted sync path)
**Response:** `202 { ok, run_id, enqueued, started_at }` (kicker) | `200 { ok, scanned, merged, remaining, next_cursor, done, elapsed_ms }` (sync) | `401` | `403` | `500`

Cross-article same-story sweep. Walks the article pool oldest-first by `(published_at, id)`; for each article, queries Vectorize for top-K matches. Auto-merge-band matches (>= `DEDUP_COSINE_THRESHOLD`) fold into the current (older) article via `mergeAsAltSource` without an LLM call. Borderline-band matches (>= `DEDUP_RERANK_FLOOR`, < `DEDUP_COSINE_THRESHOLD`) go to a binary same-event judgment by the language model and merge only on a positive verdict. Each batch caps rerank calls to prevent budget exhaustion; the cap is logged when hit.

The default path (empty body) is **kicker-only**: it inserts a `dedup_runs` audit row, enqueues exactly one `dedup-sweep` queue message, and returns immediately with `{ ok, run_id, enqueued, started_at }`. The queue consumer (`src/queue/dedup-sweep-consumer.ts`) drives the per-batch loop server-side and re-enqueues continuation messages until the corpus tail is reached. The sweep keeps running even if the `/settings` browser tab is closed; clients poll [GET /api/admin/dedup-status](#get-apiadmindedup-status) with the returned `run_id` for live progress.

A scripted caller may opt into the legacy synchronous path by sending `{ "cursor"?, "batch"? }` in the body — that runs exactly ONE bounded batch and returns the per-batch JSON shape, used by tests and dev-bypass curl flows that drive iteration manually. Browser callers without `Accept: application/json` get a 303 redirect back to `/settings?dedup=...`.

| Method | Auth | Request body |
|---|---|---|
| `POST` | Admin session | empty (browser button) → enqueue-and-return; OR `{ "cursor"?: { "pa": number, "id": string }, "batch"?: number }` for scripted single-batch calls (composite cursor — `pa` is a `published_at` Unix-second lower bound, `id` is the ULID lower bound for equal-time tie-breaking; batch defaults to 25, cap 500) |

**Success (202, kicker path):** `{ ok: true, run_id: string, enqueued: true, started_at: number }`.

**Success (200, sync batch path):** `{ ok: true, scanned: N, merged: M, remaining: K, next_cursor: { pa: number, id: string } | null, done: boolean, elapsed_ms: T }`.

**Auth:** Admin session required. Browser POST requires an `Origin` matching `APP_URL`; requests presenting `Authorization: Bearer <DEV_BYPASS_TOKEN>` bypass the Origin check (scripted curl path).

**Error responses:** `401 unauthorized` | `403 forbidden` | `403 forbidden_origin` (cross-origin browser POST without Bearer) | `500 historical_dedup_kick_failed` | `500 historical_dedup_failed` (sync path only).

**Implements:** [REQ-PIPE-003](../sdd/generation.md#req-pipe-003-same-story-dedupe-core-matching-contract) AC 3, [REQ-PIPE-014](../sdd/generation.md#req-pipe-014-same-story-operator-surfaces) AC 1, AC 4, [REQ-PIPE-009](../sdd/generation.md#req-pipe-009-llm-re-rank-pass-for-borderline-same-story-candidates), [REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface) (phase 4)

---

### GET /api/admin/dedup-status

**Method:** GET
**Path:** /api/admin/dedup-status
**Auth:** Admin session required (same three-layer gate). No Origin check (read-only GET).
**Request:** `?run_id=<ULID>` (required — ULID from the kicker call)
**Response:** `200 { ok, run_id, status, scanned, merged, batch_count, remaining, last_cursor, done, failed, error, started_at, updated_at }` | `400` | `401` | `403` | `404` | `500`

Polling endpoint for the queue-driven historical-dedup sweep. Returns a snapshot of the named `dedup_runs` row so the `/settings` surface can paint live progress while the queue consumer chains across batches. The settings JS hits this every 5 seconds while a sweep is in flight; the queue consumer updates the underlying row after each batch.

**Query parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `run_id` | string | Yes | ULID returned by the kicker call to `POST /api/admin/historical-dedup`. |

**Success (200):** `{ ok: true, run_id: string, status: 'running'|'done'|'failed', scanned: N, merged: M, batch_count: B, remaining: K, last_cursor: { pa, id } | null, done: boolean, failed: boolean, error: string | null, started_at: number, updated_at: number }`.

**Error responses:** `400 missing_run_id` | `401 unauthorized` | `403 forbidden` | `404 run_not_found` | `500 dedup_status_select_failed` | `500 invalid_stored_status`.

**Implements:** [REQ-PIPE-014](../sdd/generation.md#req-pipe-014-same-story-operator-surfaces) AC 1, AC 2, [REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface)

---

### POST /api/admin/pipeline-run

**Method:** POST
**Path:** /api/admin/pipeline-run
**Auth:** Admin session required. Origin check applies: no `Origin` header passes (curl / dev-bypass); cross-origin `Origin` rejected with `403 forbidden_origin`.
**Request:** JSON optional `{ "mode": "full" | "wipe" }` (default `"full"`)
**Response:** `202 { ok, pipeline_run_id, mode, current_phase, started_at }` | `401` | `403` | `405` | `429` | `500`

Kicker for the backend-driven full pipeline run. Creates a `pipeline_runs` audit row and enqueues exactly one `pipeline-jobs` queue message; the consumer (`src/queue/pipeline-consumer.ts`) drives the seven phases server-side without depending on the operator's browser tab. Used by the **Full pipeline run** button on `/settings`.

**Request body (JSON, optional):**

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | `"full" \| "wipe"` | `"full"` | `"wipe"` invalidates every article's embedding before scraping; `"full"` keeps existing embeddings and starts at the scrape phase. |

**Rate limit:** Per-operator hourly bucket (`admin_pipeline_run`). Exhausted → `429` with `Retry-After` surfaced to the operator's settings surface (REQ-AUTH-001 AC 9g).

**Success (202):** `{ ok: true, pipeline_run_id: string, mode: 'full'|'wipe', current_phase: string, started_at: number }`.

**Error responses:** `401 unauthorized` | `403 forbidden_origin` (cross-origin browser POST) | `405 Method Not Allowed` (`mode=wipe` via GET on the browser variant) | `429 rate_limit_exceeded` | `500 pipeline_kick_failed`.

**Implements:** [REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface), [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 9g

---

### GET /api/admin/pipeline-run

**Method:** GET
**Path:** /api/admin/pipeline-run
**Auth:** Admin session required. No Origin check (top-level navigation — see [AD38](decisions/README.md#ad38-cf-access-protected-admin-endpoints-must-be-invoked-via-top-level-navigation-not-fetch)).
**Request:** `?mode=full|wipe` (default `full`; `wipe` via GET returns `405`)
**Response:** `303` → `/settings?pipeline=enqueued&pipeline_run_id=...` | `303` → `/settings?pipeline=denied` (auth failure) | `405` (`mode=wipe` via GET) | `500`

Browser-navigation variant of the pipeline kicker. Used by `settings.astro` via `window.location.assign()` because Cloudflare Access cannot be traversed by `fetch()` in CORS mode. On success the endpoint enqueues the pipeline job and responds with `303 See Other` to `/settings?pipeline=enqueued&pipeline_run_id=...`; the settings page reads those URL parameters on load to resume progress polling. On auth failure it redirects to `/settings?pipeline=denied`.

**Query parameters:**

| Parameter | Values | Default | Description |
|---|---|---|---|
| `mode` | `full` \| `wipe` | `full` | `wipe` invalidates all embeddings before scraping; `full` keeps them. `wipe` is rejected with `405 Method Not Allowed` (body: `Use POST for mode=wipe`, `Allow: POST`) on GET to block cross-origin GET vectors from triggering a corpus-wide re-embed ([REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8d). |

**Success (303):** redirects to `/settings?pipeline=enqueued&pipeline_run_id=<ULID>&mode=<mode>`.

**Error responses:** `303 -> /settings?pipeline=denied` (auth failure) | `405 Method Not Allowed` (`mode=wipe` via GET) | `500` (configuration error).

**Implements:** [REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface), [REQ-AUTH-001](../sdd/authentication.md#req-auth-001-sign-in-with-a-federated-identity-provider) AC 8d

---

### GET /api/admin/pipeline-status

**Method:** GET
**Path:** /api/admin/pipeline-status
**Auth:** Admin session required. No Origin check (read-only GET).
**Request:** `?id=<ULID>` (optional — when omitted returns most recent pipeline run)
**Response:** `200 { ok, pipeline_run_id, status, mode, current_phase, embed_processed, embed_remaining, error, started_at, updated_at, scrape, dedup, done, failed }` | `401` | `403` | `404` | `500`

Polling endpoint for the backend-driven full pipeline run. Returns the named `pipeline_runs` row plus nested snapshots of the `scrape_runs` and `dedup_runs` rows the pipeline kicked, so the settings surface can paint live progress without driving the orchestration. The settings JS hits this every 5 seconds while a run is in flight.

**Query parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | No | ULID of the pipeline run. When omitted, the most recent row is returned (so reopening `/settings` after closing the tab restores progress). |

**Success (200):** `{ ok: true, pipeline_run_id: string, status: 'running'|'done'|'failed', mode: 'full'|'wipe', current_phase: string, embed_processed: number, embed_remaining: number, error: string | null, started_at: number, updated_at: number, scrape: { id, status, articles_ingested, articles_deduped, finalize_recorded, started_at, finished_at } | null, dedup: { id, status, scanned, merged, remaining, started_at, updated_at } | null, done: boolean, failed: boolean }`.

**Error responses:** `401 unauthorized` | `403 forbidden` | `404 run_not_found` | `500 pipeline_status_select_failed` | `500 invalid_stored_status` | `500 invalid_stored_mode`.

**Implements:** [REQ-OPS-008](../sdd/observability.md#req-ops-008-unified-admin-pipeline-run-trigger-from-the-settings-surface)

---

### GET /api/admin/dedup-diag (REQ-PIPE-014 AC 4)

**Method:** GET
**Path:** /api/admin/dedup-diag
**Auth:** Admin session required (same three-layer gate). No Origin check (read-only GET).
**Request:** `?a=<article_id>&b=<article_id>` (both required; must differ)
**Response:** `200 { ok, a, b, cosine, same_etld1, adjusted_score, same_vendor_penalty, threshold, above_threshold }` | `400` | `401` | `403` | `404` | `500`

Returns the cosine similarity between two articles' stored Vectorize embeddings, the currently-effective same-story threshold, the same-vendor cosine penalty, and a flag for whether the two articles share the same registrable domain (eTLD+1). Intended for evaluating threshold changes against known true-positive and false-positive pairs before committing them to configuration.

**Query parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `a` | string | Yes | Article ID of the first article. |
| `b` | string | Yes | Article ID of the second article. Must differ from `a`. |

**Success (200):**

<!-- doc-allow-element: AD46 dedup-diag response shape — full JSON is the contract -->
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

`same_etld1` is `true` when both articles' `primary_source_url` values resolve to the same registrable domain via `src/lib/etld.ts:sameVendor` AND neither URL routes through a known aggregator-wrapper host (currently `news.google.com`). Aggregator-wrapper URLs carry no publisher identity at the URL level, so pairs where either article comes from an aggregator host return `same_etld1: false` and do not pay the same-publisher penalty regardless of eTLD+1 match. `threshold` is the value of `DEDUP_COSINE_THRESHOLD` in effect at request time. `same_vendor_penalty` is the value of `DEDUP_SAME_VENDOR_PENALTY`. `adjusted_score` is `cosine - same_vendor_penalty` when `same_etld1` is true, otherwise equals `cosine`; it is the value the dedup decision actually compares to the threshold. `above_threshold` is `adjusted_score >= threshold`.

**Error responses:**

| Outcome | Status | `error` field |
|---|---|---|
| Missing or empty `a` or `b` param | `400` | `missing_a_or_b` |
| `a` and `b` are the same ID | `400` | `identical_ids` |
| Either article not found in D1 | `404` | `article_not_found` |
| Either vector not found in Vectorize | `404` | `vector_not_found` |
| Vectorize lookup threw | `500` | `vectorize_lookup_failed` |
| No valid session | `401` | `unauthorized` |
| Valid session but not admin email | `403` | (plain text `Forbidden`) |

**Implements:** [REQ-PIPE-014](../sdd/generation.md#req-pipe-014-same-story-operator-surfaces) AC 4

---

## Related Documentation

- [api-reference.md](api-reference.md) — public + non-admin internal API surface
- [security.md](security.md) — admin auth model, rate limits, dev-route guard
- [decisions/README.md](decisions/README.md) — ADRs for admin-gate decisions (AD29, AD38, AD44)
