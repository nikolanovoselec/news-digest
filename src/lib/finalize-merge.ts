// Implements REQ-PIPE-003
// Implements REQ-PIPE-008
//
// Pure helpers for cross-chunk + cross-tick semantic dedup: winner
// selection (REQ-PIPE-008 AC 2 — earliest published_at wins, with id
// tiebreak for determinism), the six-statement loser-into-winner merge
// (AC 3 — re-points user state before deleting the loser row, so a
// starred article never quietly disappears), and the existing-wins
// `mergeAsAltSource` variant used by REQ-PIPE-003's semantic-dedup
// path (the new article merges into the older existing article
// regardless of `published_at`, because the existing article is the
// canonical record users may already have starred / read).
//
// All functions are pure: they take row data + a D1Database for
// `prepare()` only and return arrays of bound prepared statements
// the consumer hands to batchExec. No D1 reads happen here — the
// finalize consumer owns the read query and passes the rows in.

/** Minimal article shape for winner-picking + statement-building.
 *  `source_name` was previously carried here but neither `pickWinner`
 *  nor the merge SQL reads it — the merge statements pull source data
 *  from D1 (`articles.primary_source_name`, `article_sources.source_name`)
 *  directly. Dropped 2026-05-03 alongside the finalize-prompt rewrite
 *  that stopped using source name as a dedup signal. */
export interface FinalizeRow {
  id: string;
  title: string;
  published_at: number;
}

/**
 * Pick the winner of a dedup group: earliest `published_at` wins,
 * ascending `id` breaks ties. The id tiebreaker matters because two
 * publishers reposting the exact same press release minute can produce
 * identical published_at values; without a stable tiebreaker the merge
 * would be non-deterministic across retries.
 */
export function pickWinner(rows: ReadonlyArray<FinalizeRow>): FinalizeRow {
  if (rows.length === 0) {
    throw new Error('pickWinner: rows must be non-empty');
  }
  let best = rows[0] as FinalizeRow;
  for (let i = 1; i < rows.length; i++) {
    const candidate = rows[i] as FinalizeRow;
    if (candidate.published_at < best.published_at) {
      best = candidate;
      continue;
    }
    if (candidate.published_at === best.published_at && candidate.id < best.id) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Build the six-statement loser-into-winner merge in the documented
 * order. Each statement is bind-parameterised on `winnerId` and
 * `loserId`; the order is load-bearing for AC 3 (re-point stars and
 * reads BEFORE deleting the loser, so the cascade DELETE never wipes
 * out a user's star that hasn't been re-attached to the winner yet).
 *
 * Each statement is idempotent on retry:
 *   - The `INSERT ... SELECT ... WHERE article_id = ?loserId` clauses
 *     return zero rows once the loser has been deleted, so a redelivery
 *     after a successful prior pass inserts nothing.
 *   - `INSERT OR IGNORE` collapses any rows a partial prior attempt
 *     already inserted on the winner side.
 *   - `DELETE FROM articles WHERE id = ?loserId` is a no-op once the
 *     row is gone.
 */
export function buildMergeStatements(
  db: D1Database,
  winnerId: string,
  loserId: string,
): D1PreparedStatement[] {
  return [
    // (a) loser's primary source becomes a winner alt-source row.
    db
      .prepare(
        `INSERT OR IGNORE INTO article_sources (article_id, source_name, source_url, published_at)
           SELECT ?1, primary_source_name, primary_source_url, published_at
             FROM articles WHERE id = ?2`,
      )
      .bind(winnerId, loserId),

    // (b) re-point loser's existing alt sources to the winner.
    db
      .prepare(
        `INSERT OR IGNORE INTO article_sources (article_id, source_name, source_url, published_at)
           SELECT ?1, source_name, source_url, published_at
             FROM article_sources WHERE article_id = ?2`,
      )
      .bind(winnerId, loserId),

    // (c) tag union — loser's tags merge into the winner's set.
    db
      .prepare(
        `INSERT OR IGNORE INTO article_tags (article_id, tag)
           SELECT ?1, tag FROM article_tags WHERE article_id = ?2`,
      )
      .bind(winnerId, loserId),

    // (d) re-point user state — preserves stars across the merge.
    db
      .prepare(
        `INSERT OR IGNORE INTO article_stars (user_id, article_id, starred_at)
           SELECT user_id, ?1, starred_at FROM article_stars WHERE article_id = ?2`,
      )
      .bind(winnerId, loserId),

    // (e) re-point user state — preserves read marks across the merge.
    db
      .prepare(
        `INSERT OR IGNORE INTO article_reads (user_id, article_id, read_at)
           SELECT user_id, ?1, read_at FROM article_reads WHERE article_id = ?2`,
      )
      .bind(winnerId, loserId),

    // (f) finally drop the loser; CASCADE clears its now-redundant
    //     child rows in article_sources/article_tags/article_stars/
    //     article_reads. By this point the winner has copies of every
    //     row that mattered, so the cascade is purely cleanup.
    db.prepare(`DELETE FROM articles WHERE id = ?1`).bind(loserId),
  ];
}

/**
 * Merge a newly-arrived article into an existing one as an alt-source.
 * Used by REQ-PIPE-003's semantic-dedup path in the finalize-consumer
 * and the admin historical-dedup sweep. Both callers pre-select an
 * older `existingId` and a strictly-newer `loserId` (equal-published_at
 * pairs are deferred — neither caller merges them) so the policy in
 * the single sentence is "older wins; equal-time pairs are not merged
 * at all". The function itself is policy-agnostic — it just pipes the
 * two ids straight into `buildMergeStatements` — and the caller is
 * responsible for picking the older id.
 *
 * Why this caller-side rule: the older article has had time to accrue
 * user state (stars, reads, shared URLs, email links). Folding the
 * newer arrival in as an alt-source preserves that state by construction;
 * any callers that flip the rule to "newer wins" must therefore re-point
 * stars and reads forwards rather than just re-using this helper.
 *
 * Statement order matches `buildMergeStatements` so the same
 * idempotency-on-retry guarantees hold (every INSERT...SELECT filters
 * on `WHERE article_id = ?newId`; the DELETE on `id = ?newId` is a
 * no-op once the row is gone).
 */
export function mergeAsAltSource(
  db: D1Database,
  existingId: string,
  newId: string,
): D1PreparedStatement[] {
  // The 6-statement sequence is identical to buildMergeStatements with
  // existingId as the winner and newId as the loser. We delegate so
  // any future refinement (e.g. additional child tables) is captured
  // in one place.
  return buildMergeStatements(db, existingId, newId);
}
