// Implements REQ-STAR-001, REQ-READ-002
//
// Article-detail page client behaviour. EXTERNAL module import — the
// site's CSP is `script-src 'self'`, which blocks every inline
// `<script>...</script>` block in the HTML. Inline-bundled scripts
// (Astro's default for tiny `<script>` blocks with no imports) count
// as inline per CSP. Pulling this code into a `~/scripts/...` module
// and importing it from the page's `<script>` block forces Astro to
// emit it as `<script type="module" src="/_astro/...js">` — same
// origin, CSP-compatible, and actually executes.
//
// Without this extraction the page-level `<script>` was silently
// blocked: bindBack() never ran, so the in-UI back arrow fell through
// to its `href="/digest"` fallback on every SPA-arriving visit,
// regardless of whether the back hijack's logic was correct.
//
// Two responsibilities:
//   1. Star-toggle button on the article header — POST/DELETE to
//      /api/articles/:id/star with optimistic aria-pressed flip.
//   2. Back-arrow hijack — return to the exact previous page when
//      the user arrived via in-app navigation. Falls through to the
//      plain href="/digest" only on a genuine direct-link visit so
//      the anchor stays a valid link with JS disabled.
//
// Two independent in-app signals — at least one must be present
// before we hijack the click:
//   - window.history.state.index > 0
//     Astro's ClientRouter pushState's `{ index, scrollX, scrollY }`
//     on every SPA navigation, starting at index 0 on first load.
//     index > 0 proves at least one same-realm SPA hop has happened
//     and the back stack contains the previous in-app page.
//   - document.referrer is on the same origin
//     Catches a hard HTTP navigation from another same-site page
//     (no SPA pushState yet, so history.state may still be index 0).
//
// document.referrer alone was insufficient: SPA navigations don't
// refresh document.referrer (the document was never re-fetched), so
// a user who hard-loaded /history and SPA-clicked a card landed on
// this page with referrer === '' — the prior heuristic then sent
// them to the static /digest fallback even though history.back()
// would have correctly returned to /history.

async function handleStarClick(button: HTMLButtonElement): Promise<void> {
  const articleId = button.dataset['articleId'];
  if (articleId === undefined || articleId === '') return;
  const wasPressed = button.getAttribute('aria-pressed') === 'true';
  const nextPressed = !wasPressed;
  button.setAttribute('aria-pressed', nextPressed ? 'true' : 'false');
  try {
    const res = await fetch(
      `/api/articles/${encodeURIComponent(articleId)}/star`,
      {
        method: nextPressed ? 'POST' : 'DELETE',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      },
    );
    if (!res.ok) {
      button.setAttribute('aria-pressed', wasPressed ? 'true' : 'false');
    }
  } catch {
    button.setAttribute('aria-pressed', wasPressed ? 'true' : 'false');
  }
}

function initStar(): void {
  if (document.documentElement.dataset['starDetailBound'] === '1') return;
  document.documentElement.dataset['starDetailBound'] = '1';
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>('[data-star-toggle]');
      if (button === null) return;
      e.preventDefault();
      e.stopPropagation();
      void handleStarClick(button);
    },
    true,
  );
}

function handleBackClick(this: HTMLAnchorElement, e: MouseEvent): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return;
  }
  const stateIndex = (window.history.state as { index?: unknown } | null)
    ?.index;
  const arrivedInAppViaSpa =
    typeof stateIndex === 'number' && stateIndex > 0;
  const sameOriginReferrer =
    document.referrer !== '' &&
    new URL(document.referrer).origin === window.location.origin;
  if (!arrivedInAppViaSpa && !sameOriginReferrer) {
    return; // genuine direct-link — fall through to href="/digest"
  }
  e.preventDefault();
  window.history.back();
}

function bindBack(): void {
  const link = document.querySelector<HTMLAnchorElement>(
    '[data-article-back]',
  );
  if (link === null) return;
  if (link.dataset['backBound'] === '1') return;
  link.dataset['backBound'] = '1';
  link.addEventListener('click', handleBackClick);
}

initStar();
bindBack();
document.addEventListener('astro:page-load', () => {
  initStar();
  bindBack();
});
