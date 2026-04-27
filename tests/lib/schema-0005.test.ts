// Integration test for migrations/0005_auth_links.sql — REQ-AUTH-007.
// CF-014: pin the cross-provider duplicate-email merge logic so a future
// schema change cannot silently break the collapse contract.
//
// The migration runs once at the top of `applyD1Migrations`. Since the
// test database is empty when the migration fires, the merge is a no-op
// at that point. To exercise the merge, the test seeds duplicate users
// + child rows AFTER all migrations are applied, then re-executes
// steps 2-7 of the 0005 SQL by hand. The DML is identical to what the
// migration would do at upgrade time on a populated production DB.
//
// Two cases:
//   1. Duplicate email pair, distinct created_at → MIN(created_at) wins,
//      child rows re-point, auth_links populated for both providers.
//   2. Duplicate email pair, identical created_at → MIN(id) wins
//      (tiebreak rule from the GROUP BY ... HAVING u.id = MIN(u.id)).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, applyD1Migrations } from '../fixtures/cloudflare-test';

function now(): number {
  return Math.floor(Date.now() / 1000);
}

interface UserRow {
  id: string;
  email: string;
  gh_login: string;
  created_at: number;
}

async function insertUser(db: D1Database, u: UserRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, email, gh_login, tz, digest_minute,
        email_enabled, refresh_window_start, refresh_count_24h,
        session_version, created_at)
       VALUES (?, ?, ?, 'UTC', 0, 1, 0, 0, 1, ?)`,
    )
    .bind(u.id, u.email, u.gh_login, u.created_at)
    .run();
}

async function insertArticle(db: D1Database, id: string, url: string): Promise<void> {
  const ts = now();
  await db
    .prepare(
      `INSERT INTO articles (id, canonical_url, primary_source_name,
        primary_source_url, title, details_json, tags_json,
        published_at, ingested_at, scrape_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'run-x')`,
    )
    .bind(id, url, 'Source', url, 'Title', '[]', '[]', ts, ts)
    .run();
}

/** Steps 2-7 of migrations/0005_auth_links.sql, executed as DML against
 *  the already-migrated schema. The migration's auth_links table and FK
 *  cascades are already in place at this point — this re-runs only the
 *  data-migration portion that depends on the users table being seeded. */
async function runMergeDml(db: D1Database): Promise<void> {
  await db.exec(
    'CREATE TABLE _merge_email_winners (email TEXT NOT NULL PRIMARY KEY, winner_id TEXT NOT NULL)',
  );
  await db.exec(
    "INSERT INTO _merge_email_winners (email, winner_id) " +
      'SELECT u.email, u.id ' +
      'FROM users u ' +
      'JOIN ( ' +
      '  SELECT email, MIN(created_at) AS winner_created_at ' +
      '  FROM users ' +
      "  WHERE id != '__system__' AND email IS NOT NULL AND email != '' " +
      '  GROUP BY email ' +
      '  HAVING COUNT(*) > 1 ' +
      ') g ON g.email = u.email ' +
      "WHERE u.id != '__system__' AND u.created_at = g.winner_created_at " +
      'GROUP BY u.email HAVING u.id = MIN(u.id)',
  );

  await db.exec(
    'CREATE TABLE _merge_user_merges (loser_id TEXT NOT NULL PRIMARY KEY, winner_id TEXT NOT NULL)',
  );
  await db.exec(
    'INSERT INTO _merge_user_merges (loser_id, winner_id) ' +
      'SELECT u.id, w.winner_id FROM users u ' +
      'JOIN _merge_email_winners w ON u.email = w.email ' +
      "WHERE u.id != '__system__' AND u.id != w.winner_id",
  );

  await db.exec(
    'INSERT OR IGNORE INTO article_stars (user_id, article_id, starred_at) ' +
      'SELECT m.winner_id, s.article_id, s.starred_at FROM article_stars s ' +
      'JOIN _merge_user_merges m ON s.user_id = m.loser_id',
  );
  await db.exec(
    'INSERT OR IGNORE INTO article_reads (user_id, article_id, read_at) ' +
      'SELECT m.winner_id, r.article_id, r.read_at FROM article_reads r ' +
      'JOIN _merge_user_merges m ON r.user_id = m.loser_id',
  );
  await db.exec(
    'INSERT OR IGNORE INTO pending_discoveries (user_id, tag, added_at) ' +
      'SELECT m.winner_id, p.tag, p.added_at FROM pending_discoveries p ' +
      'JOIN _merge_user_merges m ON p.user_id = m.loser_id',
  );

  await db.exec(
    'INSERT OR IGNORE INTO auth_links (provider, provider_sub, user_id, linked_at) ' +
      'SELECT ' +
      "CASE WHEN u.id LIKE '%:%' THEN substr(u.id, 1, instr(u.id, ':') - 1) ELSE 'github' END, " +
      "CASE WHEN u.id LIKE '%:%' THEN substr(u.id, instr(u.id, ':') + 1) ELSE u.id END, " +
      'm.winner_id, ' +
      "COALESCE(u.created_at, CAST(strftime('%s', 'now') AS INTEGER)) " +
      'FROM users u JOIN _merge_user_merges m ON u.id = m.loser_id',
  );

  await db.exec('DELETE FROM users WHERE id IN (SELECT loser_id FROM _merge_user_merges)');

  // Step 7: backfill auth_links for every surviving user (winners and
  // anyone untouched by the merge). Each users row contributes exactly
  // one alias derived from its current id.
  await db.exec(
    'INSERT OR IGNORE INTO auth_links (provider, provider_sub, user_id, linked_at) ' +
      'SELECT ' +
      "CASE WHEN id LIKE '%:%' THEN substr(id, 1, instr(id, ':') - 1) ELSE 'github' END, " +
      "CASE WHEN id LIKE '%:%' THEN substr(id, instr(id, ':') + 1) ELSE id END, " +
      'id, ' +
      "COALESCE(created_at, CAST(strftime('%s', 'now') AS INTEGER)) " +
      "FROM users WHERE id != '__system__'",
  );

  await db.exec('DROP TABLE _merge_user_merges');
  await db.exec('DROP TABLE _merge_email_winners');
}

describe('schema 0005 — REQ-AUTH-007 — duplicate-email collapse', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.DB_MIGRATIONS ?? []);
    await env.DB.exec('PRAGMA foreign_keys = ON');
  });

  beforeEach(async () => {
    // Scrub everything that might carry user_id refs; auth_links has
    // ON DELETE CASCADE so it follows users.
    await env.DB.exec('DELETE FROM article_stars');
    await env.DB.exec('DELETE FROM article_reads');
    await env.DB.exec('DELETE FROM pending_discoveries');
    await env.DB.exec('DELETE FROM auth_links');
    await env.DB.exec('DELETE FROM article_tags');
    await env.DB.exec('DELETE FROM article_sources');
    await env.DB.exec('DELETE FROM articles');
    await env.DB.exec("DELETE FROM users WHERE id != '__system__'");
  });

  it('REQ-AUTH-007 / CF-014: collapses duplicate-email pair and re-points child rows', async () => {
    // Two users sharing the same verified email, signed in via different
    // providers. The github user came first (lower created_at) → wins.
    const winnerId = '12345';
    const loserId = 'google:99999';
    await insertUser(env.DB, {
      id: winnerId,
      email: 'dup@example.com',
      gh_login: 'duplicate-user',
      created_at: 1_000,
    });
    await insertUser(env.DB, {
      id: loserId,
      email: 'dup@example.com',
      gh_login: 'duplicate-user',
      created_at: 2_000,
    });

    await insertArticle(env.DB, '01JAAAA0000000000000000A01', 'https://example.com/a1');
    await insertArticle(env.DB, '01JAAAA0000000000000000A02', 'https://example.com/a2');

    // Loser stars two articles, one of which the winner already starred.
    // INSERT OR IGNORE on the merge collapses the overlap.
    await env.DB
      .prepare('INSERT INTO article_stars (user_id, article_id, starred_at) VALUES (?, ?, ?)')
      .bind(winnerId, '01JAAAA0000000000000000A01', now())
      .run();
    await env.DB
      .prepare('INSERT INTO article_stars (user_id, article_id, starred_at) VALUES (?, ?, ?)')
      .bind(loserId, '01JAAAA0000000000000000A01', now())
      .run();
    await env.DB
      .prepare('INSERT INTO article_stars (user_id, article_id, starred_at) VALUES (?, ?, ?)')
      .bind(loserId, '01JAAAA0000000000000000A02', now())
      .run();

    // Loser has a pending discovery the winner doesn't.
    await env.DB
      .prepare('INSERT INTO pending_discoveries (user_id, tag, added_at) VALUES (?, ?, ?)')
      .bind(loserId, 'rust', now())
      .run();

    await runMergeDml(env.DB);

    // Loser is gone, winner survives.
    const survivors = await env.DB
      .prepare("SELECT id FROM users WHERE email = ? AND id != '__system__' ORDER BY id")
      .bind('dup@example.com')
      .all<{ id: string }>();
    expect(survivors.results.map((r) => r.id)).toEqual([winnerId]);

    // Loser's stars re-pointed to winner. Two distinct article_ids in
    // total (the duplicate row collapsed via INSERT OR IGNORE).
    const winnerStars = await env.DB
      .prepare('SELECT article_id FROM article_stars WHERE user_id = ? ORDER BY article_id')
      .bind(winnerId)
      .all<{ article_id: string }>();
    expect(winnerStars.results.map((r) => r.article_id)).toEqual([
      '01JAAAA0000000000000000A01',
      '01JAAAA0000000000000000A02',
    ]);

    // Loser's pending_discoveries also re-pointed.
    const winnerPending = await env.DB
      .prepare('SELECT tag FROM pending_discoveries WHERE user_id = ?')
      .bind(winnerId)
      .all<{ tag: string }>();
    expect(winnerPending.results.map((r) => r.tag)).toEqual(['rust']);

    // auth_links populated for both providers, both pointing at winner.
    const links = await env.DB
      .prepare('SELECT provider, provider_sub, user_id FROM auth_links WHERE user_id = ? ORDER BY provider')
      .bind(winnerId)
      .all<{ provider: string; provider_sub: string; user_id: string }>();
    expect(links.results).toEqual([
      { provider: 'github', provider_sub: '12345', user_id: '12345' },
      { provider: 'google', provider_sub: '99999', user_id: '12345' },
    ]);
  });

  it('REQ-AUTH-007 / CF-014: tiebreaks identical created_at via MIN(id)', async () => {
    // Both users created at the same instant. The `HAVING u.id = MIN(u.id)`
    // clause in the migration breaks the tie by lexicographic id order.
    // Numeric '12345' < 'google:99999' under SQLite's TEXT comparison,
    // so the github row wins.
    const sharedTs = 5_000;
    const winnerId = '12345';
    const loserId = 'google:99999';

    await insertUser(env.DB, {
      id: winnerId,
      email: 'tie@example.com',
      gh_login: 'tie-user',
      created_at: sharedTs,
    });
    await insertUser(env.DB, {
      id: loserId,
      email: 'tie@example.com',
      gh_login: 'tie-user',
      created_at: sharedTs,
    });

    await runMergeDml(env.DB);

    const survivors = await env.DB
      .prepare("SELECT id FROM users WHERE email = ? AND id != '__system__'")
      .bind('tie@example.com')
      .all<{ id: string }>();
    expect(survivors.results.map((r) => r.id)).toEqual([winnerId]);

    // auth_links carries both providers, both → winner.
    const links = await env.DB
      .prepare('SELECT provider, user_id FROM auth_links WHERE user_id = ? ORDER BY provider')
      .bind(winnerId)
      .all<{ provider: string; user_id: string }>();
    expect(links.results.map((r) => r.provider)).toEqual(['github', 'google']);
    expect(links.results.every((r) => r.user_id === winnerId)).toBe(true);
  });
});
