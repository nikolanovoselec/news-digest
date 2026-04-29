// Per-digest endpoint retired in the global-feed pipeline. The digests
// table was dropped in migration 0003; the article schema no longer
// carries a digest_id column. Stale clients hitting this path get 410
// Gone, matching the sibling /api/digest/refresh tombstone.
export async function GET(): Promise<Response> {
  return new Response(null, { status: 410 });
}
export async function POST(): Promise<Response> {
  return new Response(null, { status: 410 });
}
