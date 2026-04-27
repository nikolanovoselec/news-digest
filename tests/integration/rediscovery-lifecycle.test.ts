// End-to-end integration test for the discovered-feed rediscovery
// lifecycle — REQ-DISC-003 + REQ-DISC-006 (CF-075).
//
// Walks the full chain that turns a flaky discovered feed into a
// system-owned re-discovery row:
//
//   1. `recordFetchResult(env, url, false)` is called repeatedly as the
//      coordinator's per-source fetch fails. Health counter increments
//      live in KV (`source_health:{url}`).
//   2. The 30th consecutive failure (CONSECUTIVE_FETCH_FAILURE_LIMIT)
//      flips the result to `evicted: true`. The coordinator collects
//      this in a `FeedEviction[]` payload.
//   3. `applyEvictions` rewrites `sources:{tag}` in KV (URL removed),
//      clears the per-URL health counter, and — when the surviving
//      feed list is empty — INSERTs a `pending_discoveries` row owned
//      by `__system__` so the next discovery cron tick repopulates the
//      tag.
//   4. Curated feeds (those without a `discoveredTag`) never participate
//      because `applyEvictions` is only called with discovered evictions
//      upstream — pinned here by asserting that calling applyEvictions
//      with no evictions is a clean no-op.
//
// Uses the @cloudflare/vitest-pool-workers harness so D1 + KV are real
// miniflare bindings (matching the schema-0005 test pattern).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, applyD1Migrations } from '../fixtures/cloudflare-test';
import {
  CONSECUTIVE_FETCH_FAILURE_LIMIT,
  recordFetchResult,
} from '~/lib/feed-health';
import { applyEvictions } from '~/queue/scrape-coordinator';
import { SYSTEM_USER_ID } from '~/lib/system-user';

const TAG = 'test-rediscovery';
const FEED_URL = 'https://flaky-rss.example.com/feed.xml';
const OTHER_FEED_URL = 'https://stable-rss.example.com/feed.xml';
const SCRAPE_RUN_ID = '01JREDISCOVERYRUN0000000001';

async function seedSourcesEntry(
  feeds: Array<{ url: string; name: string }>,
): Promise<void> {
  await env.KV.put(
    `sources:${TAG}`,
    JSON.stringify({
      feeds: feeds.map((f) => ({ url: f.url, name: f.name })),
      discovered_at: Date.now(),
    }),
  );
}

async function readSourcesEntry(): Promise<unknown> {
  const raw = await env.KV.get(`sources:${TAG}`, 'text');
  if (raw === null) return null;
  return JSON.parse(raw);
}

async function getHealthCount(url: string): Promise<number | null> {
  const raw = await env.KV.get(`source_health:${url}`, 'text');
  return raw === null ? null : Number(raw);
}

async function countPendingDiscoveries(
  userId: string,
  tag: string,
): Promise<number> {
  const row = await env.DB
    .prepare(
      'SELECT COUNT(*) AS c FROM pending_discoveries WHERE user_id = ? AND tag = ?',
    )
    .bind(userId, tag)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

describe('rediscovery lifecycle — REQ-DISC-003 / REQ-DISC-006 (CF-075)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.DB_MIGRATIONS ?? []);
    await env.DB.exec('PRAGMA foreign_keys = ON');
  });

  beforeEach(async () => {
    // Clear the bits this test mutates. Other test files restore wider
    // state; we touch only the rediscovery surface.
    await env.KV.delete(`sources:${TAG}`);
    await env.KV.delete(`source_health:${FEED_URL}`);
    await env.KV.delete(`source_health:${OTHER_FEED_URL}`);
    await env.DB
      .prepare(
        'DELETE FROM pending_discoveries WHERE user_id = ? AND tag = ?',
      )
      .bind(SYSTEM_USER_ID, TAG)
      .run();
  });

  it('REQ-DISC-003 / CF-075: 30th consecutive failure flips evicted=true; earlier failures do not', async () => {
    // Walk the counter from 1 → 29 — each step is below the threshold.
    for (let i = 1; i < CONSECUTIVE_FETCH_FAILURE_LIMIT; i += 1) {
      const result = await recordFetchResult(env, FEED_URL, false);
      expect(result.evicted).toBe(false);
      expect(result.count).toBe(i);
    }
    // 30th failure → eviction signal. The coordinator collects this in
    // its FeedEviction[] payload and passes it to applyEvictions.
    const final = await recordFetchResult(env, FEED_URL, false);
    expect(final.evicted).toBe(true);
    expect(final.count).toBe(CONSECUTIVE_FETCH_FAILURE_LIMIT);
    expect(await getHealthCount(FEED_URL)).toBe(CONSECUTIVE_FETCH_FAILURE_LIMIT);
  });

  it('REQ-DISC-003 / REQ-DISC-006 / CF-075: full lifecycle — eviction → KV mutation → system requeue', async () => {
    // Step 1: tag has only the flaky feed in its KV entry. After eviction
    // the surviving feed list is empty, which triggers the system-owned
    // re-discovery requeue. Health counter pre-seeded at the threshold so
    // applyEvictions sees a real eviction signal arriving from upstream.
    await seedSourcesEntry([{ url: FEED_URL, name: 'Flaky RSS' }]);
    await env.KV.put(
      `source_health:${FEED_URL}`,
      String(CONSECUTIVE_FETCH_FAILURE_LIMIT),
    );

    // Sanity: nothing in pending_discoveries for the system user yet.
    expect(await countPendingDiscoveries(SYSTEM_USER_ID, TAG)).toBe(0);

    // Step 2: feed-health crossing the threshold produced this eviction.
    await applyEvictions(
      env,
      [
        {
          tag: TAG,
          url: FEED_URL,
          failureCount: CONSECUTIVE_FETCH_FAILURE_LIMIT,
        },
      ],
      SCRAPE_RUN_ID,
    );

    // Step 3a: KV `sources:{tag}` rewritten with surviving feeds (none).
    const after = (await readSourcesEntry()) as {
      feeds: Array<{ url: string }>;
      discovered_at: number;
    } | null;
    expect(after).not.toBeNull();
    expect(after!.feeds).toEqual([]);

    // Step 3b: per-URL health counter cleared so a re-discovered URL at
    // the same address starts fresh.
    expect(await getHealthCount(FEED_URL)).toBeNull();

    // Step 3c: system-owned re-discovery row written to D1. This is the
    // signal the discovery cron uses to repopulate the tag on its next
    // tick (REQ-DISC-006: `__system__` rows are visible to the cron's
    // GROUP BY tag query but excluded from per-user-scoped reads).
    expect(await countPendingDiscoveries(SYSTEM_USER_ID, TAG)).toBe(1);
    const sysRow = await env.DB
      .prepare(
        'SELECT user_id, tag, added_at FROM pending_discoveries WHERE user_id = ? AND tag = ?',
      )
      .bind(SYSTEM_USER_ID, TAG)
      .first<{ user_id: string; tag: string; added_at: number }>();
    expect(sysRow?.user_id).toBe(SYSTEM_USER_ID);
    expect(sysRow?.tag).toBe(TAG);
    expect(typeof sysRow?.added_at).toBe('number');
  });

  it('REQ-DISC-003 / CF-075: surviving feeds remain → no system requeue, only KV cleanup', async () => {
    // Tag has TWO discovered feeds; only one is evicted. The surviving
    // feed list is non-empty, so applyEvictions must NOT enqueue a
    // re-discovery — the tag still has a live feed.
    await seedSourcesEntry([
      { url: FEED_URL, name: 'Flaky RSS' },
      { url: OTHER_FEED_URL, name: 'Stable RSS' },
    ]);
    await env.KV.put(
      `source_health:${FEED_URL}`,
      String(CONSECUTIVE_FETCH_FAILURE_LIMIT),
    );

    await applyEvictions(
      env,
      [
        {
          tag: TAG,
          url: FEED_URL,
          failureCount: CONSECUTIVE_FETCH_FAILURE_LIMIT,
        },
      ],
      SCRAPE_RUN_ID,
    );

    // Surviving feeds list contains exactly the stable URL.
    const after = (await readSourcesEntry()) as {
      feeds: Array<{ url: string; name: string }>;
    } | null;
    expect(after).not.toBeNull();
    expect(after!.feeds.map((f) => f.url)).toEqual([OTHER_FEED_URL]);

    // Evicted URL's health counter cleared; the surviving URL's is
    // untouched (we never wrote one in this test, so it's null).
    expect(await getHealthCount(FEED_URL)).toBeNull();

    // No system requeue — the tag still has a live feed.
    expect(await countPendingDiscoveries(SYSTEM_USER_ID, TAG)).toBe(0);
  });

  it('REQ-DISC-003 / CF-075: empty evictions list is a no-op', async () => {
    // Curated-only ticks (no discovered feeds) yield empty eviction
    // arrays. applyEvictions must handle that path without touching KV
    // or D1.
    await seedSourcesEntry([{ url: FEED_URL, name: 'Flaky RSS' }]);

    await applyEvictions(env, [], SCRAPE_RUN_ID);

    const after = (await readSourcesEntry()) as {
      feeds: Array<{ url: string }>;
    } | null;
    expect(after?.feeds.map((f) => f.url)).toEqual([FEED_URL]);
    expect(await countPendingDiscoveries(SYSTEM_USER_ID, TAG)).toBe(0);
  });

  it('REQ-DISC-003 / CF-075: idempotent re-trigger — second eviction with same tag-URL pair does not double-insert', async () => {
    // Defense against at-least-once retry on the coordinator queue:
    // applyEvictions uses INSERT OR IGNORE on pending_discoveries, so
    // a second invocation with the same payload must not produce a
    // duplicate __system__ row.
    await seedSourcesEntry([{ url: FEED_URL, name: 'Flaky RSS' }]);

    await applyEvictions(
      env,
      [
        {
          tag: TAG,
          url: FEED_URL,
          failureCount: CONSECUTIVE_FETCH_FAILURE_LIMIT,
        },
      ],
      SCRAPE_RUN_ID,
    );
    expect(await countPendingDiscoveries(SYSTEM_USER_ID, TAG)).toBe(1);

    // Re-run the eviction (simulates a coordinator queue redelivery).
    // Re-seed the same KV state because the first call emptied feeds.
    await seedSourcesEntry([{ url: FEED_URL, name: 'Flaky RSS' }]);
    await applyEvictions(
      env,
      [
        {
          tag: TAG,
          url: FEED_URL,
          failureCount: CONSECUTIVE_FETCH_FAILURE_LIMIT,
        },
      ],
      SCRAPE_RUN_ID,
    );

    // Still one row, not two — INSERT OR IGNORE protected the table.
    expect(await countPendingDiscoveries(SYSTEM_USER_ID, TAG)).toBe(1);
  });
});
