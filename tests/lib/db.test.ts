// Tests for src/lib/db.ts — REQ-DATA-001 (D1 strong consistency wrapper).
// Uses the @cloudflare/vitest-pool-workers runtime — `env` is the miniflare
// binding object from wrangler.test.toml, exposing `DB: D1Database`.
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { applyForeignKeysPragma, batch } from '~/lib/db';

// Minimal schema that mirrors the FK relationship in migrations/0001_initial.sql
// (digests.user_id -> users.id ON DELETE CASCADE). Isolated per-test to avoid
// coupling to the migration file.
const SCHEMA = [
  'DROP TABLE IF EXISTS digests_fk_test',
  'DROP TABLE IF EXISTS users_fk_test',
  `CREATE TABLE users_fk_test (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE digests_fk_test (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users_fk_test(id) ON DELETE CASCADE,
     generated_at INTEGER NOT NULL
   )`,
];

beforeEach(async () => {
  const db = (env as unknown as { DB: D1Database }).DB;
  for (const sql of SCHEMA) {
    await db.exec(sql.replace(/\s+/g, ' ').trim());
  }
});

describe('db', () => {
  describe('applyForeignKeysPragma', () => {
    it('REQ-DATA-001: enables foreign key enforcement on the connection', async () => {
      const db = (env as unknown as { DB: D1Database }).DB;
      await applyForeignKeysPragma(db);

      // Verify via PRAGMA read-back: should be 1 (enabled).
      const { results } = await db.prepare('PRAGMA foreign_keys').all<{ foreign_keys: number }>();
      expect(results).toHaveLength(1);
      expect(results[0]!.foreign_keys).toBe(1);
    });

    it('REQ-DATA-001: enforces FK constraints after pragma is applied', async () => {
      const db = (env as unknown as { DB: D1Database }).DB;
      await applyForeignKeysPragma(db);

      // Inserting a child row with no matching parent must fail.
      let threw = false;
      try {
        await db
          .prepare('INSERT INTO digests_fk_test (id, user_id, generated_at) VALUES (?, ?, ?)')
          .bind('d1', 'ghost-user', 1)
          .run();
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });

  describe('batch', () => {
    it('REQ-DATA-001: commits two related INSERTs atomically', async () => {
      const db = (env as unknown as { DB: D1Database }).DB;
      await applyForeignKeysPragma(db);

      const userStmt = db
        .prepare('INSERT INTO users_fk_test (id, email, created_at) VALUES (?, ?, ?)')
        .bind('u1', 'alice@example.com', 100);
      const digestStmt = db
        .prepare('INSERT INTO digests_fk_test (id, user_id, generated_at) VALUES (?, ?, ?)')
        .bind('d1', 'u1', 200);

      const results = await batch(db, [userStmt, digestStmt]);
      expect(results).toHaveLength(2);
      expect(results[0]!.success).toBe(true);
      expect(results[1]!.success).toBe(true);

      const { results: users } = await db.prepare('SELECT id FROM users_fk_test').all();
      const { results: digests } = await db.prepare('SELECT id, user_id FROM digests_fk_test').all();
      expect(users).toHaveLength(1);
      expect(digests).toHaveLength(1);
    });

    it('REQ-DATA-001: rolls back the whole batch when any statement fails', async () => {
      const db = (env as unknown as { DB: D1Database }).DB;
      await applyForeignKeysPragma(db);

      const goodInsert = db
        .prepare('INSERT INTO users_fk_test (id, email, created_at) VALUES (?, ?, ?)')
        .bind('u1', 'alice@example.com', 100);
      // References a non-existent parent — FK violation aborts the batch.
      const badInsert = db
        .prepare('INSERT INTO digests_fk_test (id, user_id, generated_at) VALUES (?, ?, ?)')
        .bind('d1', 'ghost-user', 200);

      let threw = false;
      try {
        await batch(db, [goodInsert, badInsert]);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      // The good insert must NOT have persisted — the batch is atomic.
      const { results: users } = await db.prepare('SELECT id FROM users_fk_test').all();
      expect(users).toHaveLength(0);
    });
  });
});
