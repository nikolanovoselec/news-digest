// Infrastructure utility — no REQ.
//
// CF-015: single helper that paginates `KV.list({ prefix: 'sources:' })`
// and returns the unique tag-suffix list. Replaces two near-identical
// KV.list loops that previously lived inline in
// `scrape-coordinator.ts` (`loadDiscoveredSources` and
// `purgeOrphanDiscoveredSources`). Both callers need the same prefix
// scan; this helper avoids the duplication and gives future callers
// (admin diagnostics, debug endpoints) a read-only view without
// accidentally coupling them to the mutation logic.

import { log } from '~/lib/log';

/**
 * Paginate `KV.list({ prefix: 'sources:' })` and return every unique
 * tag suffix (the part after `sources:`). Keys with an empty suffix are
 * silently dropped.
 *
 * @param kv   The KV namespace bound as `env.KV`.
 * @returns    `{ tags, partial }` — `tags` is the collected list;
 *             `partial: true` when one or more list pages failed and the
 *             result may be incomplete.
 */
export async function listDiscoveredTags(
  kv: KVNamespace,
): Promise<{ tags: string[]; partial: boolean }> {
  const tags: string[] = [];
  let partial = false;
  let cursor: string | undefined;

  do {
    let result: KVNamespaceListResult<unknown>;
    try {
      result = await kv.list({
        prefix: 'sources:',
        ...(cursor !== undefined ? { cursor } : {}),
      });
    } catch (err) {
      partial = true;
      log('warn', 'digest.generation', {
        status: 'discovered_tags_list_failed',
        detail: String(err).slice(0, 200),
      });
      break;
    }

    for (const key of result.keys) {
      const tag = key.name.startsWith('sources:')
        ? key.name.slice('sources:'.length)
        : '';
      if (tag !== '') tags.push(tag);
    }

    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor !== undefined);

  return { tags, partial };
}
