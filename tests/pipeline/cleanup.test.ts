// Tests for src/queue/cleanup.ts — REQ-PIPE-005.
//
// Integration-level: runs against a miniflare-backed D1 with the real
// migrations applied, so FK CASCADE behaviour is exercised end-to-end
// rather than mocked. Mirrors the setup pattern established by
// tests/lib/schema-0003.test.ts.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { runCleanup } from '~/queue/cleanup';

const USER_ID = 'cleanup-test-user';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function daysAgo(days: number): number {
  return nowSec() - days * 86400;
}

async function insertUser(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, email, gh_login, tz, digest_minute,
        email_enabled, refresh_window_start, refresh_count_24h,
        session_version, created_at)
       VALUES (?, ?, ?, ?, 0, 1, 0, 0, 1, ?)`,
    )
    .bind(id, `${id}@example.com`, id, 'UTC', nowSec())
    .run();
}

async function insertArticle(
  db: D1Database,
  opts: { id: string; canonicalUrl: string; publishedAt: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO articles (id, canonical_url, primary_source_name,
        primary_source_url, title, details_json, tags_json,
        published_at, ingested_at, scrape_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      opts.id,
      opts.canonicalUrl,
      'Example Source',
      opts.canonicalUrl,
      'An example title',
      JSON.stringify(['detail a']),
      JSON.stringify(['ai']),
      opts.publishedAt,
      opts.publishedAt,
      'run-cleanup',
    )
    .run();
}

async function insertStar(
  db: D1Database,
  userId: string,
  articleId: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO article_stars (user_id, article_id, starred_at) VALUES (?, ?, ?)',
    )
    .bind(userId, articleId, nowSec())
    .run();
}

async function countRows(
  db: D1Database,
  table: string,
  whereSql: string,
  ...binds: unknown[]
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${whereSql}`)
    .bind(...binds)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

async function articleExists(db: D1Database, id: string): Promise<boolean> {
  return (await countRows(db, 'articles', 'id = ?', id)) > 0;
}

describe('cleanup cron — REQ-PIPE-005', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.DB_MIGRATIONS ?? []);
    // FK cascades are required for AC 3. D1 enables them by default
    // but we mirror the schema-0003 suite to be explicit.
    await env.DB.exec('PRAGMA foreign_keys = ON');
  });

  beforeEach(async () => {
    // Scrub in child-first order to keep FK-less deletes valid even if
    // cascades were somehow off.
    await env.DB.exec('DELETE FROM article_reads');
    await env.DB.exec('DELETE FROM article_stars');
    await env.DB.exec('DELETE FROM article_tags');
    await env.DB.exec('DELETE FROM article_sources');
    await env.DB.exec('DELETE FROM articles');
    await env.DB.exec('DELETE FROM scrape_runs');
    await env.DB.exec('DELETE FROM users');
    await insertUser(env.DB, USER_ID);
  });

  it('REQ-PIPE-005: deletes articles older than 7 days when no user has starred them', async () => {
    const freshId = '01JCLEAN000000000000000001';
    const staleUnstarredId = '01JCLEAN000000000000000002';
    const staleStarredId = '01JCLEAN000000000000000003';

    await insertArticle(env.DB, {
      id: freshId,
      canonicalUrl: 'https://example.com/fresh',
      publishedAt: daysAgo(1),
    });
    await insertArticle(env.DB, {
      id: staleUnstarredId,
      canonicalUrl: 'https://example.com/stale-unstarred',
      publishedAt: daysAgo(8),
    });
    await insertArticle(env.DB, {
      id: staleStarredId,
      canonicalUrl: 'https://example.com/stale-starred',
      publishedAt: daysAgo(8),
    });
    await insertStar(env.DB, USER_ID, staleStarredId);

    await runCleanup(env);

    expect(await articleExists(env.DB, freshId)).toBe(true);
    expect(await articleExists(env.DB, staleUnstarredId)).toBe(false);
    expect(await articleExists(env.DB, staleStarredId)).toBe(true);
  });

  it('REQ-PIPE-005: preserves articles starred by any user regardless of age', async () => {
    const veryStaleStarredId = '01JCLEAN000000000000000010';

    await insertArticle(env.DB, {
      id: veryStaleStarredId,
      canonicalUrl: 'https://example.com/very-stale-starred',
      publishedAt: daysAgo(30),
    });
    await insertStar(env.DB, USER_ID, veryStaleStarredId);

    await runCleanup(env);

    expect(await articleExists(env.DB, veryStaleStarredId)).toBe(true);
  });

  it('REQ-PIPE-005: FK cascades remove article_sources, article_tags, article_reads when an article is deleted', async () => {
    const articleId = '01JCLEAN000000000000000020';
    const publishedAt = daysAgo(10);

    await insertArticle(env.DB, {
      id: articleId,
      canonicalUrl: 'https://example.com/cascade',
      publishedAt,
    });

    // Two article_sources rows.
    await env.DB
      .prepare(
        `INSERT INTO article_sources (article_id, source_name, source_url, published_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(articleId, 'SrcA', 'https://example.com/cascade-a', publishedAt)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO article_sources (article_id, source_name, source_url, published_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(articleId, 'SrcB', 'https://example.com/cascade-b', publishedAt)
      .run();

    // Three article_tags rows.
    for (const tag of ['ai', 'ml', 'news']) {
      await env.DB
        .prepare('INSERT INTO article_tags (article_id, tag) VALUES (?, ?)')
        .bind(articleId, tag)
        .run();
    }

    // One article_reads row.
    await env.DB
      .prepare(
        'INSERT INTO article_reads (user_id, article_id, read_at) VALUES (?, ?, ?)',
      )
      .bind(USER_ID, articleId, nowSec())
      .run();

    // Sanity: pre-cleanup counts.
    expect(await countRows(env.DB, 'article_sources', 'article_id = ?', articleId)).toBe(2);
    expect(await countRows(env.DB, 'article_tags', 'article_id = ?', articleId)).toBe(3);
    expect(await countRows(env.DB, 'article_reads', 'article_id = ?', articleId)).toBe(1);

    await runCleanup(env);

    // Article is gone.
    expect(await articleExists(env.DB, articleId)).toBe(false);
    // Every child table is empty for this article_id via CASCADE.
    expect(await countRows(env.DB, 'article_sources', 'article_id = ?', articleId)).toBe(0);
    expect(await countRows(env.DB, 'article_tags', 'article_id = ?', articleId)).toBe(0);
    expect(await countRows(env.DB, 'article_reads', 'article_id = ?', articleId)).toBe(0);
  });

  it('REQ-PIPE-005: returns the number of deleted rows', async () => {
    for (let i = 0; i < 5; i++) {
      await insertArticle(env.DB, {
        id: `01JCLEAN00000000000000003${i}`,
        canonicalUrl: `https://example.com/stale-${i}`,
        publishedAt: daysAgo(9),
      });
    }

    const result = await runCleanup(env);

    expect(result).toEqual({ deleted: 5 });
    expect(await countRows(env.DB, 'articles', '1 = 1')).toBe(0);
  });
});
