// Tests for src/lib/email-data.ts — REQ-MAIL-001.
//
// `selectUnreadHeadlinesForUser` and `tagTallySinceMidnight` are pure
// D1 reads that drive the rich daily digest body. These tests exercise
// the SQL contract against a stub D1 — bound parameters, ORDER BY
// clauses, the NOT EXISTS exclusion, defensive empty-input behaviour,
// and the "since midnight" cutoff binding.

import { describe, it, expect, vi } from 'vitest';
import {
  selectUnreadHeadlinesForUser,
  tagTallySinceMidnight,
} from '~/lib/email-data';

interface SqlCall { sql: string; params: unknown[]; verb: 'all' | 'first'; }

interface DbStubOptions {
  /** Rows the next `.all()` call will resolve to (consumed FIFO). */
  nextAll?: unknown[][];
  /** Rows the next `.first()` call will resolve to (consumed FIFO). */
  nextFirst?: unknown[];
  /** When set, the next prepare() call rejects on any verb. */
  throwNext?: boolean;
}

/** Capturing D1 stub: records every prepare/bind/all|first triple in
 *  order so tests can assert on bound params + SQL. */
function makeDb(opts: DbStubOptions): { db: D1Database; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const allQueue = [...(opts.nextAll ?? [])];
  const firstQueue = [...(opts.nextFirst ?? [])];
  const prepare = vi.fn().mockImplementation((sql: string) => {
    const bound: unknown[] = [];
    const reject = opts.throwNext === true;
    return {
      bind: (...params: unknown[]) => {
        bound.push(...params);
        return {
          all: vi.fn().mockImplementation(async () => {
            calls.push({ sql, params: [...bound], verb: 'all' });
            if (reject) throw new Error('D1 stub: forced failure');
            return { success: true, results: allQueue.shift() ?? [] };
          }),
          first: vi.fn().mockImplementation(async () => {
            calls.push({ sql, params: [...bound], verb: 'first' });
            if (reject) throw new Error('D1 stub: forced failure');
            return firstQueue.shift() ?? null;
          }),
        };
      },
    };
  });
  return { db: { prepare } as unknown as D1Database, calls };
}

// ---------- selectUnreadHeadlinesForUser ----------

describe('selectUnreadHeadlinesForUser — REQ-MAIL-001', () => {
  it('REQ-MAIL-001: returns [] when userTags is empty', async () => {
    const { db, calls } = makeDb({});
    const result = await selectUnreadHeadlinesForUser(db, 'u1', [], 5);
    expect(result).toEqual([]);
    // Should not have hit D1 at all.
    expect(calls).toHaveLength(0);
  });

  it('REQ-MAIL-001: respects limit by binding it as the last positional param', async () => {
    const { db, calls } = makeDb({ nextAll: [[]] });
    await selectUnreadHeadlinesForUser(db, 'u1', ['cloudflare', 'mcp'], 5);
    expect(calls).toHaveLength(1);
    // ?1 = userId, ?2..?N = tags, last param = limit.
    expect(calls[0]!.params).toEqual(['u1', 'cloudflare', 'mcp', 5]);
    expect(calls[0]!.sql).toContain('LIMIT ?4');
  });

  it('REQ-MAIL-001: excludes articles in article_reads for the user via NOT EXISTS', async () => {
    const { db, calls } = makeDb({ nextAll: [[]] });
    await selectUnreadHeadlinesForUser(db, 'u1', ['kubernetes'], 3);
    const sql = calls[0]!.sql;
    expect(sql).toMatch(/NOT EXISTS/i);
    expect(sql).toMatch(/article_reads/);
    expect(sql).toMatch(/rd\.user_id\s*=\s*\?1/);
  });

  it('REQ-MAIL-001: orders by ingested_at DESC, published_at DESC', async () => {
    const { db, calls } = makeDb({ nextAll: [[]] });
    await selectUnreadHeadlinesForUser(db, 'u1', ['kubernetes'], 3);
    expect(calls[0]!.sql).toMatch(/ORDER BY a\.ingested_at DESC, a\.published_at DESC/);
  });

  it('REQ-MAIL-001: binds tag placeholders as ?2..?N', async () => {
    const { db, calls } = makeDb({ nextAll: [[]] });
    await selectUnreadHeadlinesForUser(db, 'u1', ['a', 'b', 'c'], 5);
    expect(calls[0]!.sql).toContain('tag IN (?2, ?3, ?4)');
  });

  it('REQ-MAIL-001: maps row shape to {id, title, source_name, slug, primary_source_url}', async () => {
    const { db } = makeDb({
      nextAll: [[
        {
          id: 'a-1',
          title: 'Cloudflare ships D1 GA',
          source_name: 'Cloudflare Blog',
          primary_source_url: 'https://blog.cloudflare.com/d1-ga',
        },
      ]],
    });
    const result = await selectUnreadHeadlinesForUser(db, 'u1', ['cloudflare'], 5);
    expect(result).toEqual([
      {
        id: 'a-1',
        title: 'Cloudflare ships D1 GA',
        source_name: 'Cloudflare Blog',
        slug: 'cloudflare-ships-d1-ga',
        primary_source_url: 'https://blog.cloudflare.com/d1-ga',
      },
    ]);
  });

  it('REQ-MAIL-001: returns [] on D1 error (defensive)', async () => {
    const { db } = makeDb({ throwNext: true });
    const result = await selectUnreadHeadlinesForUser(db, 'u1', ['cloudflare'], 5);
    expect(result).toEqual([]);
  });
});

// ---------- tagTallySinceMidnight ----------

describe('tagTallySinceMidnight — REQ-MAIL-001', () => {
  it('REQ-MAIL-001: returns empty when userTags is empty', async () => {
    const { db, calls } = makeDb({});
    const result = await tagTallySinceMidnight(db, [], 1700000000);
    expect(result).toEqual({ totalArticles: 0, tally: [] });
    expect(calls).toHaveLength(0);
  });

  it('REQ-MAIL-001: filters by sinceUnix cutoff bound at ?1', async () => {
    const { db, calls } = makeDb({ nextAll: [[]], nextFirst: [{ total: 0 }] });
    await tagTallySinceMidnight(db, ['mcp'], 1700000000);
    // Both queries (tally + total) should fire; both bind sinceUnix at ?1.
    for (const call of calls) {
      expect(call.params[0]).toBe(1700000000);
      expect(call.sql).toMatch(/ingested_at\s*>=\s*\?1/);
    }
  });

  it('REQ-MAIL-001: tally SQL groups by tag and orders DESC by count', async () => {
    const { db, calls } = makeDb({ nextAll: [[]], nextFirst: [{ total: 0 }] });
    await tagTallySinceMidnight(db, ['mcp', 'kubernetes'], 1700000000);
    const tallyCall = calls.find((c) => c.verb === 'all');
    expect(tallyCall).toBeDefined();
    expect(tallyCall!.sql).toMatch(/GROUP BY at\.tag/);
    expect(tallyCall!.sql).toMatch(/ORDER BY count DESC, tag ASC/);
  });

  it('REQ-MAIL-001: tally SQL does NOT join article_reads (tally is read-state-agnostic)', async () => {
    const { db, calls } = makeDb({ nextAll: [[]], nextFirst: [{ total: 0 }] });
    await tagTallySinceMidnight(db, ['mcp'], 1700000000);
    for (const call of calls) {
      expect(call.sql).not.toMatch(/article_reads/);
    }
  });

  it('REQ-MAIL-001: returns counts grouped by tag with stable ordering', async () => {
    const { db } = makeDb({
      nextAll: [[
        { tag: 'kubernetes', count: 4 },
        { tag: 'ai-agents', count: 3 },
        { tag: 'mcp', count: 2 },
      ]],
      nextFirst: [{ total: 8 }],
    });
    const result = await tagTallySinceMidnight(
      db, ['kubernetes', 'ai-agents', 'mcp'], 1700000000,
    );
    expect(result.tally).toEqual([
      { tag: 'kubernetes', count: 4 },
      { tag: 'ai-agents', count: 3 },
      { tag: 'mcp', count: 2 },
    ]);
  });

  it('REQ-MAIL-001: totalArticles counts DISTINCT articles', async () => {
    const { db, calls } = makeDb({
      nextAll: [[]],
      nextFirst: [{ total: 12 }],
    });
    const result = await tagTallySinceMidnight(db, ['mcp'], 1700000000);
    expect(result.totalArticles).toBe(12);
    const totalCall = calls.find((c) => c.verb === 'first');
    expect(totalCall!.sql).toMatch(/COUNT\(DISTINCT a\.id\)/);
  });

  it('REQ-MAIL-001: returns empty result on D1 error (defensive)', async () => {
    const { db } = makeDb({ throwNext: true });
    const result = await tagTallySinceMidnight(db, ['mcp'], 1700000000);
    expect(result).toEqual({ totalArticles: 0, tally: [] });
  });
});
