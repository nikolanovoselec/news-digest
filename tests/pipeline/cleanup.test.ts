// Tests for src/queue/cleanup.ts — REQ-PIPE-005.
//
// Integration-level: runs against a miniflare-backed D1 with the real
// migrations applied, so FK CASCADE behaviour is exercised end-to-end
// rather than mocked. Mirrors the setup pattern established by
// tests/lib/schema-0003.test.ts.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, applyD1Migrations } from '../fixtures/cloudflare-test';
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

    expect(result.articlesDeleted).toBe(5);
    expect(await countRows(env.DB, 'articles', '1 = 1')).toBe(0);
  });
});

// REQ-PIPE-007 — orphan-tag KV cache cleanup. Same daily cron, second
// pass: enumerate every `sources:{tag}` KV entry, delete the ones whose
// tag is no longer in any user's hashtags_json.

async function setUserHashtags(
  db: D1Database,
  userId: string,
  hashtags: string[] | null,
): Promise<void> {
  await db
    .prepare('UPDATE users SET hashtags_json = ?1 WHERE id = ?2')
    .bind(hashtags === null ? null : JSON.stringify(hashtags), userId)
    .run();
}

async function listKvKeys(prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page: KVNamespaceListResult<unknown> = await env.KV.list({
      prefix,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    for (const k of page.keys) out.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
  return out;
}

async function clearKvPrefix(prefix: string): Promise<void> {
  const keys = await listKvKeys(prefix);
  await Promise.all(keys.map((k) => env.KV.delete(k)));
}

async function seedSources(tag: string): Promise<void> {
  await env.KV.put(
    `sources:${tag}`,
    JSON.stringify({
      feeds: [{ name: `Feed-${tag}`, url: `https://example.com/${tag}/rss`, kind: 'rss' }],
      discovered_at: Date.now(),
    }),
  );
}

describe('cleanup cron — REQ-PIPE-007 orphan-tag sweep', () => {
  beforeEach(async () => {
    // Full reset between cases: child rows first to satisfy FK ordering,
    // then parents, then a single seeded user with no hashtags. Without
    // this, a user inserted by an earlier case (e.g. multi-user) would
    // own its tag for every subsequent case and break idempotency / null
    // / empty-registry assertions.
    await env.DB.exec('DELETE FROM article_reads');
    await env.DB.exec('DELETE FROM article_stars');
    await env.DB.exec('DELETE FROM article_tags');
    await env.DB.exec('DELETE FROM article_sources');
    await env.DB.exec('DELETE FROM articles');
    await env.DB.exec('DELETE FROM scrape_runs');
    await env.DB.exec('DELETE FROM users');
    await insertUser(env.DB, USER_ID);
    await clearKvPrefix('sources:');
    await clearKvPrefix('discovery_failures:');
  });

  it('REQ-PIPE-007: deletes the cache for a tag no user owns', async () => {
    await setUserHashtags(env.DB, USER_ID, ['ai', 'cloudflare']);
    await seedSources('ai');
    await seedSources('cloudflare');
    await seedSources('ikea'); // orphan — no user has it

    const result = await runCleanup(env);

    expect(result.orphanTagsDeleted).toBe(1);
    expect(await env.KV.get('sources:ikea')).toBeNull();
    expect(await env.KV.get('sources:ai')).not.toBeNull();
    expect(await env.KV.get('sources:cloudflare')).not.toBeNull();
  });

  it('REQ-PIPE-007: also deletes the discovery_failures sibling key', async () => {
    await setUserHashtags(env.DB, USER_ID, ['ai']);
    await seedSources('ikea');
    await env.KV.put('discovery_failures:ikea', '2');

    await runCleanup(env);

    expect(await env.KV.get('sources:ikea')).toBeNull();
    expect(await env.KV.get('discovery_failures:ikea')).toBeNull();
  });

  it('REQ-PIPE-007: tag owned by ANY user is preserved (multi-user case)', async () => {
    const SECOND_USER = 'cleanup-test-user-2';
    await insertUser(env.DB, SECOND_USER);
    await setUserHashtags(env.DB, USER_ID, ['cloudflare']);
    await setUserHashtags(env.DB, SECOND_USER, ['ikea']);
    await seedSources('cloudflare');
    await seedSources('ikea');

    const result = await runCleanup(env);

    expect(result.orphanTagsDeleted).toBe(0);
    expect(await env.KV.get('sources:cloudflare')).not.toBeNull();
    expect(await env.KV.get('sources:ikea')).not.toBeNull();
  });

  it('REQ-PIPE-007: normalises hashtag entries (leading #, mixed case)', async () => {
    // A legacy row stored as ["#AI", "Cloudflare"] still protects the
    // bare-lowercase `sources:ai` and `sources:cloudflare` entries.
    await setUserHashtags(env.DB, USER_ID, ['#AI', 'Cloudflare']);
    await seedSources('ai');
    await seedSources('cloudflare');
    await seedSources('orphan-tag');

    const result = await runCleanup(env);

    expect(result.orphanTagsDeleted).toBe(1);
    expect(await env.KV.get('sources:ai')).not.toBeNull();
    expect(await env.KV.get('sources:cloudflare')).not.toBeNull();
    expect(await env.KV.get('sources:orphan-tag')).toBeNull();
  });

  it('REQ-PIPE-007: idempotent — second immediate run deletes 0', async () => {
    await setUserHashtags(env.DB, USER_ID, ['ai']);
    await seedSources('ikea');

    const first = await runCleanup(env);
    const second = await runCleanup(env);

    expect(first.orphanTagsDeleted).toBe(1);
    expect(second.orphanTagsDeleted).toBe(0);
  });

  it('REQ-PIPE-007: a user with null hashtags_json contributes nothing (does not save tags)', async () => {
    // The __system__ sentinel row has hashtags_json = null. Tags
    // written by the system shouldn't get free protection.
    await setUserHashtags(env.DB, USER_ID, null);
    await seedSources('orphan');

    const result = await runCleanup(env);

    expect(result.orphanTagsDeleted).toBe(1);
    expect(await env.KV.get('sources:orphan')).toBeNull();
  });

  it('REQ-PIPE-007: empty registry is a no-op (no users, no caches)', async () => {
    await setUserHashtags(env.DB, USER_ID, null);
    // No seedSources calls.

    const result = await runCleanup(env);

    expect(result.orphanTagsDeleted).toBe(0);
  });

  it('REQ-PIPE-007: thrown error in the article-retention DB call does not block orphan sweep', async () => {
    // Real failure injection (AC 5): wrap env.DB so the article-retention
    // DELETE throws. The orphan sweep must still execute, delete the
    // orphan KV entry, and report it in the result.
    await setUserHashtags(env.DB, USER_ID, ['ai']);
    await seedSources('ikea');

    const wrappedEnv = wrapDbToThrowOn(env, (sql) =>
      sql.includes('DELETE FROM articles'),
    );

    const result = await runCleanup(wrappedEnv);

    expect(result.articlesDeleted).toBe(0); // pass failed, returns 0
    expect(result.orphanTagsDeleted).toBe(1); // pass succeeded
    expect(await env.KV.get('sources:ikea')).toBeNull();
  });

  it('REQ-PIPE-007: thrown error in the orphan-sweep DB call does not block article retention', async () => {
    // Inverse of the test above (AC 5 in both directions). Seed a stale
    // article and an orphan KV entry. Throw on the orphan-sweep SELECT
    // and verify the stale article was still deleted while the orphan
    // KV entry was preserved (sweep aborted before deletion).
    await setUserHashtags(env.DB, USER_ID, ['ai']);

    const staleId = '01JCLEAN000000000000000099';
    await insertArticle(env.DB, {
      id: staleId,
      canonicalUrl: 'https://example.com/stale-iso',
      publishedAt: daysAgo(10),
    });
    await seedSources('ikea');

    const wrappedEnv = wrapDbToThrowOn(env, (sql) =>
      sql.includes('SELECT hashtags_json'),
    );

    const result = await runCleanup(wrappedEnv);

    expect(result.articlesDeleted).toBe(1); // pass succeeded
    expect(result.orphanTagsDeleted).toBe(0); // pass failed
    expect(await articleExists(env.DB, staleId)).toBe(false);
    expect(await env.KV.get('sources:ikea')).not.toBeNull();
  });
});

/** Returns a Proxy-wrapped env whose DB.prepare throws synchronously when
 *  the provided predicate matches the SQL string. Used to simulate D1
 *  outage in one half of runCleanup so the other half's isolation can be
 *  verified end-to-end. */
function wrapDbToThrowOn(
  baseEnv: Env,
  predicate: (sql: string) => boolean,
): Env {
  const realDb = baseEnv.DB;
  const wrappedDb = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (predicate(sql)) {
            throw new Error('simulated D1 outage');
          }
          return Reflect.get(target, prop, receiver).call(target, sql);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ...baseEnv, DB: wrappedDb as D1Database };
}
