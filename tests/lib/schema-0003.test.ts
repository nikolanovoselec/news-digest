// Integration tests for migrations/0003_global_feed.sql — REQ-PIPE-004.
//
// Uses @cloudflare/vitest-pool-workers to run the migrations against a
// miniflare-backed D1 instance, then exercises the new schema:
//   - articles.canonical_url UNIQUE enforcement
//   - article_sources + article_tags bound to a parent article
//   - ON DELETE CASCADE across all child tables when an article is deleted
//   - scrape_runs status transition (running -> ready)
//   - users.last_emailed_local_date column exists and is nullable

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, applyD1Migrations } from '../fixtures/cloudflare-test';

const USER_ID = 'schema-0003-user';
const OTHER_USER_ID = 'schema-0003-other-user';

function now(): number {
  return Math.floor(Date.now() / 1000);
}

async function insertUser(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, email, gh_login, tz, digest_minute,
        email_enabled, refresh_window_start, refresh_count_24h,
        session_version, created_at)
       VALUES (?, ?, ?, ?, 0, 1, 0, 0, 1, ?)`,
    )
    .bind(id, `${id}@example.com`, id, 'UTC', now())
    .run();
}

async function insertArticle(
  db: D1Database,
  opts: { id: string; canonicalUrl: string; runId?: string },
): Promise<void> {
  const ts = now();
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
      JSON.stringify(['detail a', 'detail b']),
      JSON.stringify(['ai']),
      ts,
      ts,
      opts.runId ?? 'run-x',
    )
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

describe('schema 0003 — REQ-PIPE-004', () => {
  beforeAll(async () => {
    // Apply migrations against the miniflare D1. vitest-pool-workers
    // reads migrations_dir from wrangler.test.toml.
    await applyD1Migrations(env.DB, env.DB_MIGRATIONS ?? []);
    // Cascading foreign keys are off by default in SQLite; turn them on
    // per the project-wide convention.
    await env.DB.exec('PRAGMA foreign_keys = ON');
  });

  beforeEach(async () => {
    // Scrub any rows left by prior test cases so assertions are
    // order-independent.
    await env.DB.exec('DELETE FROM article_reads');
    await env.DB.exec('DELETE FROM article_stars');
    await env.DB.exec('DELETE FROM article_tags');
    await env.DB.exec('DELETE FROM article_sources');
    await env.DB.exec('DELETE FROM articles');
    await env.DB.exec('DELETE FROM scrape_runs');
    await env.DB.exec('DELETE FROM users');
    await insertUser(env.DB, USER_ID);
    await insertUser(env.DB, OTHER_USER_ID);
  });

  it('REQ-PIPE-004: inserts into articles with ULID + canonical_url UNIQUE enforced', async () => {
    await insertArticle(env.DB, {
      id: '01JAAAA0000000000000000001',
      canonicalUrl: 'https://example.com/a',
    });

    const row = await env.DB
      .prepare('SELECT id, canonical_url FROM articles WHERE id = ?')
      .bind('01JAAAA0000000000000000001')
      .first<{ id: string; canonical_url: string }>();
    expect(row).not.toBeNull();
    expect(row!.canonical_url).toBe('https://example.com/a');

    // Second insert with the same canonical_url must fail due to UNIQUE.
    await expect(
      insertArticle(env.DB, {
        id: '01JAAAA0000000000000000002',
        canonicalUrl: 'https://example.com/a',
      }),
    ).rejects.toThrow(/UNIQUE|constraint/i);
  });

  it('REQ-PIPE-004: inserts into article_sources + article_tags bound to a parent article', async () => {
    const articleId = '01JAAAA0000000000000000010';
    await insertArticle(env.DB, {
      id: articleId,
      canonicalUrl: 'https://example.com/sources-tags',
    });

    const ts = now();
    await env.DB
      .prepare(
        `INSERT INTO article_sources (article_id, source_name, source_url, published_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(articleId, 'Primary', 'https://example.com/src-1', ts)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO article_sources (article_id, source_name, source_url, published_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(articleId, 'Secondary', 'https://example.com/src-2', ts)
      .run();

    await env.DB
      .prepare('INSERT INTO article_tags (article_id, tag) VALUES (?, ?)')
      .bind(articleId, 'ai')
      .run();
    await env.DB
      .prepare('INSERT INTO article_tags (article_id, tag) VALUES (?, ?)')
      .bind(articleId, 'ml')
      .run();

    expect(await countRows(env.DB, 'article_sources', 'article_id = ?', articleId)).toBe(2);
    expect(await countRows(env.DB, 'article_tags', 'article_id = ?', articleId)).toBe(2);
  });

  it('REQ-PIPE-004: ON DELETE CASCADE removes article_sources, article_tags, article_stars, article_reads when article is deleted', async () => {
    const articleId = '01JAAAA0000000000000000020';
    await insertArticle(env.DB, {
      id: articleId,
      canonicalUrl: 'https://example.com/cascade',
    });

    const ts = now();
    await env.DB
      .prepare(
        `INSERT INTO article_sources (article_id, source_name, source_url, published_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(articleId, 'Primary', 'https://example.com/cascade-src', ts)
      .run();
    await env.DB
      .prepare('INSERT INTO article_tags (article_id, tag) VALUES (?, ?)')
      .bind(articleId, 'ai')
      .run();
    await env.DB
      .prepare(
        'INSERT INTO article_stars (user_id, article_id, starred_at) VALUES (?, ?, ?)',
      )
      .bind(USER_ID, articleId, ts)
      .run();
    await env.DB
      .prepare(
        'INSERT INTO article_reads (user_id, article_id, read_at) VALUES (?, ?, ?)',
      )
      .bind(USER_ID, articleId, ts)
      .run();

    // Sanity: rows exist before delete.
    expect(await countRows(env.DB, 'article_sources', 'article_id = ?', articleId)).toBe(1);
    expect(await countRows(env.DB, 'article_tags', 'article_id = ?', articleId)).toBe(1);
    expect(await countRows(env.DB, 'article_stars', 'article_id = ?', articleId)).toBe(1);
    expect(await countRows(env.DB, 'article_reads', 'article_id = ?', articleId)).toBe(1);

    await env.DB.prepare('DELETE FROM articles WHERE id = ?').bind(articleId).run();

    // After cascade, all child tables must be empty for this article.
    expect(await countRows(env.DB, 'article_sources', 'article_id = ?', articleId)).toBe(0);
    expect(await countRows(env.DB, 'article_tags', 'article_id = ?', articleId)).toBe(0);
    expect(await countRows(env.DB, 'article_stars', 'article_id = ?', articleId)).toBe(0);
    expect(await countRows(env.DB, 'article_reads', 'article_id = ?', articleId)).toBe(0);
  });

  it('REQ-PIPE-004: scrape_runs accepts status running → ready transition', async () => {
    const runId = '01JAAAA0000000000000000099';
    const started = now();
    await env.DB
      .prepare(
        `INSERT INTO scrape_runs (id, started_at, model_id, status)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(runId, started, '@cf/meta/llama-3.1-8b-instruct-fp8-fast', 'running')
      .run();

    const initial = await env.DB
      .prepare('SELECT status, articles_ingested FROM scrape_runs WHERE id = ?')
      .bind(runId)
      .first<{ status: string; articles_ingested: number }>();
    expect(initial?.status).toBe('running');
    // Defaults default to 0.
    expect(initial?.articles_ingested).toBe(0);

    const finished = started + 60;
    await env.DB
      .prepare(
        `UPDATE scrape_runs
            SET status = ?, finished_at = ?, articles_ingested = ?, chunk_count = ?
          WHERE id = ?`,
      )
      .bind('ready', finished, 12, 3, runId)
      .run();

    const after = await env.DB
      .prepare(
        `SELECT status, finished_at, articles_ingested, chunk_count
           FROM scrape_runs WHERE id = ?`,
      )
      .bind(runId)
      .first<{
        status: string;
        finished_at: number;
        articles_ingested: number;
        chunk_count: number;
      }>();
    expect(after?.status).toBe('ready');
    expect(after?.finished_at).toBe(finished);
    expect(after?.articles_ingested).toBe(12);
    expect(after?.chunk_count).toBe(3);
  });

  it('REQ-PIPE-004: users.last_emailed_local_date column exists and is nullable', async () => {
    const row = await env.DB
      .prepare('SELECT last_emailed_local_date FROM users WHERE id = ?')
      .bind(USER_ID)
      .first<{ last_emailed_local_date: string | null }>();
    expect(row).not.toBeNull();
    expect(row!.last_emailed_local_date).toBeNull();

    await env.DB
      .prepare('UPDATE users SET last_emailed_local_date = ? WHERE id = ?')
      .bind('2026-04-23', USER_ID)
      .run();

    const updated = await env.DB
      .prepare('SELECT last_emailed_local_date FROM users WHERE id = ?')
      .bind(USER_ID)
      .first<{ last_emailed_local_date: string | null }>();
    expect(updated!.last_emailed_local_date).toBe('2026-04-23');
  });
});
