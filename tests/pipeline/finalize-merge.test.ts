// Tests for src/lib/finalize-merge.ts — REQ-PIPE-008.
//
// Pure helpers: pickWinner (earliest published_at, ascending-id tiebreaker)
// and buildMergeStatements (the 6-statement loser-into-winner merge).
// These tests pin the SQL statement order — load-bearing for the
// idempotency invariant in REQ-PIPE-008 AC 5 — and the winner-
// selection rule from AC 2.

import { describe, it, expect, vi } from 'vitest';
import {
  pickWinner,
  buildMergeStatements,
  type FinalizeRow,
} from '~/lib/finalize-merge';

function row(overrides: Partial<FinalizeRow>): FinalizeRow {
  return {
    id: 'a-1',
    title: 'Title',
    published_at: 1_700_000_000,
    ...overrides,
  };
}

interface CapturedStatement {
  sql: string;
  params: unknown[];
}

/** Minimal D1 stub that records every prepare()/bind() pair. */
function makeRecordingDb(): { db: D1Database; calls: CapturedStatement[] } {
  const calls: CapturedStatement[] = [];
  const prepare = vi.fn().mockImplementation((sql: string) => {
    return {
      bind: (...params: unknown[]) => {
        calls.push({ sql, params });
        return { sql, params } as unknown as D1PreparedStatement;
      },
    } as unknown as D1PreparedStatement;
  });
  return { db: { prepare } as unknown as D1Database, calls };
}

describe('pickWinner — REQ-PIPE-008', () => {
  it('REQ-PIPE-008: pickWinner returns the row with the earliest published_at', () => {
    const winner = pickWinner([
      row({ id: 'a-late', published_at: 1_700_000_500 }),
      row({ id: 'a-early', published_at: 1_700_000_100 }),
      row({ id: 'a-mid', published_at: 1_700_000_300 }),
    ]);
    expect(winner.id).toBe('a-early');
  });

  it('REQ-PIPE-008: pickWinner ties broken by ascending id (deterministic)', () => {
    // Two rows with identical published_at — the lexicographically
    // smaller id must win so retries converge on the same winner.
    const winner = pickWinner([
      row({ id: 'a-z', published_at: 1_700_000_000 }),
      row({ id: 'a-a', published_at: 1_700_000_000 }),
      row({ id: 'a-m', published_at: 1_700_000_000 }),
    ]);
    expect(winner.id).toBe('a-a');
  });

  it('REQ-PIPE-008: pickWinner of a singleton returns that singleton', () => {
    const winner = pickWinner([row({ id: 'only' })]);
    expect(winner.id).toBe('only');
  });

  it('REQ-PIPE-008: pickWinner throws on empty input', () => {
    expect(() => pickWinner([])).toThrow();
  });
});

describe('buildMergeStatements — REQ-PIPE-008', () => {
  it('REQ-PIPE-008: emits exactly six statements in the documented order', () => {
    const { db, calls } = makeRecordingDb();
    const stmts = buildMergeStatements(db, 'winner-1', 'loser-1');
    expect(stmts).toHaveLength(6);
    expect(calls).toHaveLength(6);
    // Order is load-bearing for idempotency: child rows are copied to
    // the winner BEFORE the loser DELETE; the DELETE is always last.
    expect(calls[0]!.sql).toMatch(/INSERT OR IGNORE INTO article_sources[\s\S]*FROM articles/);
    expect(calls[1]!.sql).toMatch(/INSERT OR IGNORE INTO article_sources[\s\S]*FROM article_sources/);
    expect(calls[2]!.sql).toMatch(/INSERT OR IGNORE INTO article_tags/);
    expect(calls[3]!.sql).toMatch(/INSERT OR IGNORE INTO article_stars/);
    expect(calls[4]!.sql).toMatch(/INSERT OR IGNORE INTO article_reads/);
    expect(calls[5]!.sql).toMatch(/DELETE FROM articles WHERE id = \?1/);
  });

  it('REQ-PIPE-008: stars are re-pointed BEFORE the DELETE that would cascade them', () => {
    // The whole point of the merge sequence: a starred article's user
    // signal must survive even though the row that the user starred
    // is about to be deleted.
    const { db, calls } = makeRecordingDb();
    buildMergeStatements(db, 'winner-1', 'loser-1');
    const starsIndex = calls.findIndex((c) => c.sql.includes('article_stars'));
    const deleteIndex = calls.findIndex((c) => c.sql.startsWith('DELETE FROM articles'));
    expect(starsIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(starsIndex).toBeLessThan(deleteIndex);
  });

  it('REQ-PIPE-008: reads are re-pointed BEFORE the DELETE that would cascade them', () => {
    const { db, calls } = makeRecordingDb();
    buildMergeStatements(db, 'winner-1', 'loser-1');
    const readsIndex = calls.findIndex((c) => c.sql.includes('article_reads'));
    const deleteIndex = calls.findIndex((c) => c.sql.startsWith('DELETE FROM articles'));
    expect(readsIndex).toBeGreaterThan(-1);
    expect(readsIndex).toBeLessThan(deleteIndex);
  });

  it('REQ-PIPE-008: every statement binds winnerId at ?1 and loserId at ?2', () => {
    // Documented bind order: ?1 = winner, ?2 = loser. The DELETE only
    // binds the loser at ?1 (it has no winner reference); guard that
    // explicitly so a future refactor doesn't accidentally swap the
    // bind position and turn a merge into a winner deletion.
    const { db, calls } = makeRecordingDb();
    buildMergeStatements(db, 'winner-x', 'loser-y');
    for (let i = 0; i < 5; i++) {
      expect(calls[i]!.params[0], `statement ${i} must bind winner at ?1`).toBe('winner-x');
      expect(calls[i]!.params[1], `statement ${i} must bind loser at ?2`).toBe('loser-y');
    }
    // DELETE statement: only ?1 = loser.
    expect(calls[5]!.params[0]).toBe('loser-y');
    expect(calls[5]!.params).toHaveLength(1);
  });

  it('REQ-PIPE-008: every INSERT uses OR IGNORE so a partial prior attempt does not error on retry', () => {
    const { db, calls } = makeRecordingDb();
    buildMergeStatements(db, 'winner-1', 'loser-1');
    for (let i = 0; i < 5; i++) {
      expect(calls[i]!.sql).toMatch(/INSERT OR IGNORE/);
    }
  });
});
