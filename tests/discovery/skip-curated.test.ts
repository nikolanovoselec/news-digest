// REQ-DISC-001 AC 1 — discovery is short-circuited for tags covered by
// the curated registry. Two layers verified here:
//   (a) findTagsNeedingDiscovery filters curated tags BEFORE queueing.
//   (b) processPendingDiscoveries skip-and-deletes any pending row for a
//       curated tag (defence in depth — catches admin paths and pre-fix rows).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processPendingDiscoveries } from '~/lib/discovery';
import { findTagsNeedingDiscovery } from '~/pages/api/settings';

interface PutOptions {
  expirationTtl?: number;
  expiration?: number;
}

function makeKv(seed: Record<string, string> = {}): {
  kv: KVNamespace;
  store: Record<string, string>;
  gets: string[];
} {
  const store: Record<string, string> = { ...seed };
  const gets: string[] = [];
  const kv = {
    get: vi.fn().mockImplementation(async (key: string) => {
      gets.push(key);
      return store[key] ?? null;
    }),
    put: vi.fn().mockImplementation(async (key: string, value: string, _options?: PutOptions) => {
      store[key] = value;
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      delete store[key];
    }),
  } as unknown as KVNamespace;
  return { kv, store, gets };
}

function makeDb(pendingTags: string[]): {
  db: D1Database;
  runCalls: Array<{ sql: string; params: unknown[] }>;
} {
  const runCalls: Array<{ sql: string; params: unknown[] }> = [];
  const prepareSpy = vi.fn().mockImplementation((sql: string) => ({
    bind: (...params: unknown[]) => ({
      all: vi.fn().mockResolvedValue({
        results: pendingTags.map((t) => ({ tag: t })),
        success: true,
      }),
      run: vi.fn().mockImplementation(async () => {
        runCalls.push({ sql, params });
        return { success: true, meta: { changes: 1 } };
      }),
    }),
  }));
  const db = { prepare: prepareSpy } as unknown as D1Database;
  return { db, runCalls };
}

function makeEnv(db: D1Database, kv: KVNamespace, aiRun: ReturnType<typeof vi.fn>): Env {
  return {
    DB: db,
    KV: kv,
    AI: { run: aiRun } as unknown as Ai,
  } as unknown as Env;
}

describe('REQ-DISC-001 AC 1: curated-source short-circuit', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('findTagsNeedingDiscovery', () => {
    it('REQ-DISC-001 AC 1: excludes tags with a curated source even when no KV entry exists', async () => {
      const { kv, gets } = makeKv(); // empty KV — no sources:* entries
      // 'graymatter' and 'cloudflare' are both in CURATED_SOURCES;
      // 'fictional-newcomer-tag' is not. Without the gate, all three
      // would queue for discovery.
      const result = await findTagsNeedingDiscovery(kv, [
        'graymatter',
        'cloudflare',
        'fictional-newcomer-tag',
      ]);
      // Only the non-curated tag is returned for discovery queueing.
      expect(result).toEqual(['fictional-newcomer-tag']);
      // KV is not even consulted for curated tags — the in-memory
      // hasCuratedSource() check short-circuits before the network call.
      expect(gets).toEqual(['sources:fictional-newcomer-tag']);
    });

    it('REQ-DISC-001 AC 1: returns empty list when every input is curated', async () => {
      const { kv, gets } = makeKv();
      const result = await findTagsNeedingDiscovery(kv, ['graymatter', 'ai-agents']);
      expect(result).toEqual([]);
      expect(gets).toEqual([]);
    });
  });

  describe('processPendingDiscoveries', () => {
    it('REQ-DISC-001 AC 1: skip-deletes a pending row for a curated tag without calling the LLM', async () => {
      const aiRun = vi.fn().mockImplementation(async () => ({ response: '{"feeds":[]}' }));
      const { db, runCalls } = makeDb(['graymatter']); // curated tag pending
      const { kv } = makeKv();
      const env = makeEnv(db, kv, aiRun);

      const out = await processPendingDiscoveries(env);

      // Counted as processed (it has a working source via the registry).
      expect(out.processed).toEqual(['graymatter']);
      expect(out.failed).toEqual([]);
      // No LLM call fired — the gate short-circuits before discoverTag().
      expect(aiRun).not.toHaveBeenCalled();
      // The pending row was DELETEd so it does not loop forever.
      const deletes = runCalls.filter((c) => c.sql.startsWith('DELETE FROM pending_discoveries'));
      expect(deletes.length).toBeGreaterThanOrEqual(1);
      expect(deletes[0]?.params).toContain('graymatter');
    });
  });
});
