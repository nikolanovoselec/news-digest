// Implements REQ-SET-006
//
// Helper for Astro pages that must be gated on settings completeness.
// A user whose `users.hashtags_json IS NULL` or `users.digest_hour IS NULL`
// must not reach the reading surface - they are bounced to
// `/settings?first_run=1` instead. Symmetrically, a fully-configured user
// who visits `/settings?first_run=1` is redirected to `/settings` (edit
// mode) because the first-run framing only applies to incomplete settings.
//
// This function is intentionally pure and operates on Astro's
// `APIContext` so it can be called from any page's frontmatter before any
// content is rendered. It never throws - callers decide what to do with
// the returned Response (typically `return response` at the top of the
// `---` block).
//
// The helper assumes `context.locals.user` has already been populated by
// the authenticated layout or route - if there is no user on locals, the
// helper returns `null` (no redirect) because authentication is a
// prerequisite gate that other code is responsible for enforcing.

import type { APIContext } from 'astro';

/**
 * Path served by the `/settings` Astro page, without query string.
 * Kept as a module-level constant so the redirect target and the
 * gate's allow-path stay in sync at compile time.
 */
const SETTINGS_PATH = '/settings';

/**
 * Query string tacked onto the redirect target when a user is being
 * pushed through first-run onboarding.
 */
const FIRST_RUN_QUERY = '?first_run=1';

/**
 * Settings-complete check - returns a redirect Response when the
 * authenticated user has not finished onboarding, otherwise returns
 * `null` and the caller continues rendering.
 *
 * Behaviour (REQ-SET-006 AC 1, AC 2):
 *  - `hashtags_json IS NULL` OR `digest_hour IS NULL` and the path is
 *    NOT already `/settings` → 303 to `/settings?first_run=1`.
 *  - Settings ARE complete and the path IS `/settings?first_run=1` →
 *    303 to `/settings` (strip the first_run query).
 *  - Otherwise → `null` (no redirect; caller proceeds).
 *
 * The helper reads from `context.locals.user`, so routes that opt into
 * it must first ensure the session has been loaded. Pages without a
 * user on locals return `null` without redirecting - authentication is
 * a separate concern that the page's own frontmatter handles.
 */
// CF-031: helper accepts a narrowed slice of APIContext so SSR
// frontmatter callers (settings.astro, starred.astro, digest.astro,
// digest/[id]/[slug].astro) can pass `{ request, locals }` directly
// - no `as unknown as APIContext` cast needed. Real API-route
// callers can still pass their full APIContext (structural
// subtyping).
export function requireSettingsComplete(
  context: Pick<APIContext, 'request' | 'locals'>,
): Response | null {
  const user = context.locals.user;
  if (user === undefined) {
    // No authenticated user on locals - this helper is a no-op in that
    // case. Callers that need auth enforcement must handle it before
    // invoking this function.
    return null;
  }

  const url = new URL(context.request.url);
  const pathname = url.pathname;
  const isFirstRun = url.searchParams.get('first_run') === '1';

  // Hashtags moved out of /settings into the /digest tag strip, so
  // completion hinges on `digest_hour` alone. A user can have no tags
  // yet and still reach /digest; the empty tag strip prompts them to
  // add their first one there.
  const settingsIncomplete = user.digest_hour === null;

  // AC 1 - incomplete onboarding pins the user to /settings?first_run=1.
  // Skip the redirect when the user is already on /settings so they can
  // actually fill the form.
  if (settingsIncomplete && pathname !== SETTINGS_PATH) {
    return redirect(`${SETTINGS_PATH}${FIRST_RUN_QUERY}`);
  }

  // AC 2 - a fully-configured user visiting the first-run URL is
  // nudged to the steady-state edit view.
  if (!settingsIncomplete && pathname === SETTINGS_PATH && isFirstRun) {
    return redirect(SETTINGS_PATH);
  }

  return null;
}

/**
 * 303 See Other redirect. Using 303 (not 302) so POST submissions that
 * reach this helper's pages are always followed with GET, matching how
 * the rest of the app redirects.
 */
function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location },
  });
}
