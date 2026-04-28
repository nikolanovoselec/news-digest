// Implements REQ-DES-002, REQ-DES-003, REQ-HIST-001, REQ-PWA-003, REQ-SET-007, REQ-READ-002
//
// Layout-level client behaviour for every page. EXTERNAL module —
// the site's CSP is `script-src 'self'` and inlines page-level
// `<script>` blocks fall under the inline-CSP block list. Without
// this extraction the entire layout's interactivity (silent tz
// auto-correct, per-path scroll save/restore, view-transition
// scroll restore that keeps below-fold cards inside the new-page
// snapshot, vt-active flag for header opacity, saved-day pre-open
// on /history back-nav) was being dropped on the floor — every
// `<script>` block in Base.astro that lacked an `import` was
// inlined by Astro's hoist pipeline, then blocked by the runtime
// CSP. Importing this module from a `<script>` block in Base.astro
// forces Astro to bundle it as `<script type="module" src="...">`
// which CSP allows from the same origin.
//
// Behaviours bundled here:
//   1. syncBrowserTz — auto-write the browser's IANA timezone for
//      first-visit users so daily emails fire on local wall-clock
//      (REQ-SET-007 silent path).
//   2. saveScroll / restoreScroll — sessionStorage-keyed per-path
//      scroll restoration so back-from-article-detail returns the
//      reader to the same position they left.
//   3. preFilterIncomingDocument — apply ?tags= filter to
//      ev.newDocument before the View-Transition snapshot so the
//      filtered layout is captured (otherwise the snapshot is
//      taken on the unfiltered DOM and the filter applied client-
//      side after, breaking morph geometry and scroll restore).
//   4. preOpenHistoryDayInIncomingDocument — on /history back-nav,
//      open the saved day's <details> in ev.newDocument so the
//      `card-{slug}` element matching the article-page header is
//      present at snapshot time and the morph plays in reverse.
//   5. Sync scroll restore on astro:after-swap — View-Transition
//      snapshots only include in-viewport elements; without an
//      in-callback scroll restore the new-page snapshot is captured
//      at scrollY=0 and any below-fold source element drops out,
//      collapsing the morph to a default root cross-fade.
//   6. data-vt-active flag — toggled around the view-transition
//      window to force the sticky header opaque so the body cross-
//      fade ghost doesn't swim through the translucent backdrop.
//   7. bfcache pageshow restore — iOS Safari serves /history from
//      bfcache on external back-nav; astro:page-load doesn't fire,
//      so we pick up the saved scroll on `pageshow`.

interface BeforeSwapEvent extends Event {
  newDocument: Document;
  to: URL;
}

// ---- syncBrowserTz (REQ-SET-007) ---------------------------------

async function syncBrowserTz(): Promise<void> {
  const body = document.body;
  const stored = body.dataset['userTz'] ?? '';
  // Silent path only fires while stored tz is the seeded sentinel
  // (empty). Any non-empty stored value (set by an earlier silent
  // correction OR a deliberate manual save, including UTC) is
  // authoritative and never overwritten. Without this, a user who
  // genuinely lives in UTC and saves 'UTC' would have their choice
  // overwritten on the next page load by the browser-resolved zone
  // (or an Etc/UTC alias).
  if (stored !== '') return;
  let browser = '';
  try {
    browser = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return;
  }
  if (browser === '' || browser === stored) return;
  try {
    const res = await fetch('/api/auth/set-tz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ tz: browser }),
    });
    if (res.ok) {
      body.dataset['userTz'] = browser;
    }
  } catch {
    // Network hiccup — next page load will retry.
  }
}

if (document.documentElement.dataset['tzAutoBound'] !== '1') {
  document.documentElement.dataset['tzAutoBound'] = '1';
  void syncBrowserTz();
  document.addEventListener('astro:page-load', () => {
    void syncBrowserTz();
  });
}

// ---- scroll save / restore + view-transition handlers -----------

// Track the path of the page whose scroll position we are
// currently managing in a module-scoped variable, NOT in
// `window.location.pathname`. Astro's ClientRouter calls
// history.pushState BEFORE firing `astro:before-swap`, so by the
// time saveScroll runs, `window.location.pathname` has already
// flipped to the destination URL — without this we'd save /digest's
// scroll under the detail page's key, and on return reading
// `scroll:/digest` would find nothing. currentPath is updated only
// when restoreScroll completes so saveScroll always writes under
// the page the user is leaving.
let currentPath = window.location.pathname;
const KEY = (): string => `scroll:${currentPath}`;

function saveScroll(): void {
  try {
    sessionStorage.setItem(KEY(), String(window.scrollY));
  } catch {
    /* storage quota / disabled — nothing to do */
  }
}

// Retry-based restore: the naive "single rAF after page-load"
// race-loses against two mobile problems:
//   (a) image-heavy pages whose layout height isn't established
//       until lazy images have decoded — scrollTo(0, 1200) on a
//       page that's only 600px tall clamps to 600 and the real
//       target is lost forever;
//   (b) pages that shrink AFTER the initial restore when the
//       tag-strip filter's `applyFilter()` sets `display:none` on
//       non-matching cards, collapsing the grid's height — the
//       browser silently clamps scrollY and a simple "stop on
//       first match" tick loop terminates before the collapse.
// We tick every frame for 3 seconds AND observe document height
// changes via ResizeObserver, re-asserting scrollTo on every
// mutation. Stop on user wheel/touchmove so we never jump under
// their finger.
function restoreScroll(): void {
  // Advance currentPath to the page we're now on. Any future
  // saveScroll calls before the next navigation will correctly
  // key against this page, not the next destination.
  currentPath = window.location.pathname;
  try {
    const raw = sessionStorage.getItem(KEY());
    if (raw === null) return;
    const target = Number.parseInt(raw, 10);
    if (!Number.isFinite(target) || target < 0) return;
    if (target === 0) return;
    const started = performance.now();
    const DURATION_MS = 3000;
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    const teardown = (): void => {
      cancelled = true;
      if (ro !== null) {
        ro.disconnect();
        ro = null;
      }
    };
    window.addEventListener('wheel', teardown, { once: true, passive: true });
    window.addEventListener('touchmove', teardown, {
      once: true,
      passive: true,
    });
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        if (cancelled) return;
        window.scrollTo(0, target);
      });
      ro.observe(document.documentElement);
    }
    const tick = (): void => {
      if (cancelled) return;
      window.scrollTo(0, target);
      if (performance.now() - started > DURATION_MS) {
        teardown();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch {
    /* ditto */
  }
}

function preFilterIncomingDocument(e: Event): void {
  const ev = e as BeforeSwapEvent;
  const path = ev.to?.pathname ?? '';
  if (path !== '/digest' && path !== '/history') return;
  const raw = ev.to.searchParams.get('tags');
  if (raw === null || raw === '') return;
  const selected = new Set(
    raw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== ''),
  );
  if (selected.size === 0) return;
  const doc = ev.newDocument;
  if (doc === undefined) return;
  doc.querySelectorAll<HTMLElement>('[data-digest-card]').forEach((card) => {
    const cardTags = (card.dataset['tags'] ?? '')
      .split(',')
      .filter((t) => t !== '');
    const match = cardTags.some((t) => selected.has(t));
    if (!match) card.dataset['filterHide'] = '1';
  });
  doc.querySelectorAll<HTMLElement>('[data-tag-chip]').forEach((chip) => {
    const tag = chip.dataset['tag'];
    if (tag !== undefined && selected.has(tag)) {
      chip.classList.add('is-selected');
      chip.setAttribute('aria-pressed', 'true');
    }
  });
}

function preOpenHistoryDayInIncomingDocument(e: Event): void {
  const ev = e as BeforeSwapEvent;
  const path = ev.to?.pathname ?? '';
  if (path !== '/history') return;
  if (ev.to.searchParams.has('date')) return; // deeplink wins
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem('history:last-day-state');
  } catch {
    return;
  }
  if (raw === null || raw === '') return;
  let parsed: { date?: unknown } = {};
  try {
    parsed = JSON.parse(raw) as { date?: unknown };
  } catch {
    return;
  }
  const date = parsed.date;
  if (typeof date !== 'string' || date === '') return;
  const doc = ev.newDocument;
  if (doc === undefined) return;
  const day = doc.querySelector<HTMLElement>(
    `[data-history-day][data-date="${CSS.escape(date)}"]`,
  );
  if (day === null) return;
  const det = day.querySelector<HTMLDetailsElement>('.history__details');
  if (det === null) return;
  det.open = true;
}

// ---- single-named-group view-transition shaping --------------------
//
// `DigestCard` no longer emits a default `transition:name`. The browser
// captures every named element on the page as part of the view-
// transition pseudo tree, so /history (100+ cards across opened days)
// paid O(N) capture/bookkeeping cost on every navigation despite only
// ONE pair ever morphing (the clicked card ↔ article-detail header).
// /digest paid the same cost at smaller N. Stripping the default and
// promoting exactly one card per navigation reduces named groups to 1.
//
// Forward (overview → detail): on `astro:before-preparation` the
// sourceElement is the clicked anchor; we walk up to the surrounding
// `[data-digest-card]`, read its slug, and assign
// `view-transition-name: card-${slug}` on the link before the OLD
// snapshot is captured.
//
// Backward (detail → overview): on `astro:before-swap` we read the
// outgoing URL (`/digest/{id}/{slug}`) and locate the matching card in
// `event.newDocument`, skipping copies inside a hidden ancestor or a
// closed `<details>` (those aren't in layout, so a view-transition-
// name on them is silently dropped and the morph degrades to root
// cross-fade).
//
// Cleanup runs on `astro:after-swap`: remove `view-transition-name`
// from every card on the live DOM so the next navigation starts from
// the no-name baseline. Any remaining name would re-introduce the
// O(N) bookkeeping the moment a card with a leftover name happens to
// be in viewport on the next click.

const ARTICLE_DETAIL_PATH_RE = /^\/digest\/[^/]+\/([^/]+)\/?$/;

function findPromotableCard(
  scope: Document | HTMLElement,
  slug: string,
): HTMLAnchorElement | null {
  const cards = scope.querySelectorAll<HTMLElement>(
    `[data-digest-card][data-vt-slug="${CSS.escape(slug)}"]`,
  );
  for (const card of cards) {
    // Skip cards inside a hidden ancestor (e.g. /history's flat
    // search grid when no filter is active, or the day-list when
    // a filter is active — only one container is visible at a time).
    if (card.closest('[hidden]') !== null) continue;
    // Skip cards inside a closed <details>: not in layout, so a
    // view-transition-name has no bbox to capture and the morph
    // would degrade to a default cross-fade.
    const det = card.closest<HTMLDetailsElement>('details');
    if (det !== null && !det.open) continue;
    const link = card.querySelector<HTMLAnchorElement>('a.digest-card__link');
    if (link !== null) return link;
  }
  return null;
}

function clearAllVtNames(scope: Document | HTMLElement): void {
  scope
    .querySelectorAll<HTMLElement>('[data-digest-card] a.digest-card__link')
    .forEach((el) => {
      el.style.removeProperty('view-transition-name');
    });
}

function promoteSourceCardForOutgoingMorph(e: Event): void {
  interface BeforePreparationEvent extends Event {
    sourceElement?: HTMLElement | null;
    to?: URL;
  }
  const ev = e as BeforePreparationEvent;
  const to = ev.to;
  if (to === undefined) return;
  const match = ARTICLE_DETAIL_PATH_RE.exec(to.pathname);
  if (match === null) return;
  const src = ev.sourceElement;
  if (!(src instanceof HTMLElement)) return;
  const card = src.closest<HTMLElement>('[data-digest-card][data-vt-slug]');
  if (card === null) return;
  const slug = card.dataset['vtSlug'];
  if (typeof slug !== 'string' || slug === '') return;
  const link = card.querySelector<HTMLAnchorElement>('a.digest-card__link');
  if (link === null) return;
  // Belt-and-braces: clear any leftover name from a prior nav (after-
  // swap clears too, but if a previous teardown raced this is the
  // last-chance gate).
  clearAllVtNames(document);
  link.style.setProperty('view-transition-name', `card-${slug}`);
}

function promoteIncomingCardForReturnMorph(e: Event): void {
  interface BeforeSwapWithFrom extends BeforeSwapEvent {
    from?: URL;
  }
  const ev = e as BeforeSwapWithFrom;
  const from = ev.from;
  if (from === undefined) return;
  const match = ARTICLE_DETAIL_PATH_RE.exec(from.pathname);
  if (match === null) return;
  const slug = match[1];
  if (slug === undefined || slug === '') return;
  const doc = ev.newDocument;
  if (doc === undefined) return;
  const link = findPromotableCard(doc, slug);
  if (link === null) return;
  link.style.setProperty('view-transition-name', `card-${slug}`);
}

// ---- header brand link: /digest, or scroll-to-top if already there
//
// MUST be document capture-phase. Samsung Internet's WebView dispatches
// the native anchor handler BEFORE element-level listeners get the
// event — element-bound listeners miss the first 2-3 taps of the
// session entirely. Document capture phase fires before WebView's
// native dispatch, so we catch the tap on the very first try.
//
// `pointerup` is the fallback for the same WebViews that elide the
// synthesised `click` after touchstart+touchend. Both run in capture
// phase with stopPropagation; `window.scrollTo` is idempotent so a
// click+pointerup pair both firing is harmless. Modifier-clicks and
// non-primary buttons fall through (open-in-new-tab still works).
function shouldInterceptBrandTap(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const link = target.closest<HTMLAnchorElement>('a[data-brand-home]');
  if (link === null) return false;
  // Only intercept when the URL is EXACTLY /digest (no query string).
  // On /digest?tags=ai the brand's href="/digest" should resolve via
  // natural navigation so the tag filter clears — preserving the
  // "click the brand to reset" affordance.
  if (window.location.pathname !== '/digest') return false;
  if (window.location.search !== '') return false;
  return true;
}

function scrollTopRespectingMotion(): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
}

function bindBrandLinkScrollToTop(): void {
  const root = document.documentElement;
  if (root.dataset['brandLinkBound'] === '1') return;
  root.dataset['brandLinkBound'] = '1';

  document.addEventListener(
    'click',
    (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (e instanceof MouseEvent && e.button !== 0) return;
      if (!shouldInterceptBrandTap(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      scrollTopRespectingMotion();
    },
    true,
  );

  document.addEventListener(
    'pointerup',
    (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (e.button !== 0) return;
      if (!shouldInterceptBrandTap(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      scrollTopRespectingMotion();
    },
    true,
  );
}

bindBrandLinkScrollToTop();

if (document.documentElement.dataset['scrollRestoreBound'] !== '1') {
  document.documentElement.dataset['scrollRestoreBound'] = '1';
  // Override Astro ClientRouter's scroll-to-top so our per-path
  // sessionStorage restore wins.
  if ('scrollRestoration' in window.history) {
    window.history.scrollRestoration = 'manual';
  }
  document.addEventListener(
    'astro:before-preparation',
    promoteSourceCardForOutgoingMorph,
  );
  document.addEventListener('astro:before-swap', preFilterIncomingDocument);
  document.addEventListener(
    'astro:before-swap',
    preOpenHistoryDayInIncomingDocument,
  );
  document.addEventListener(
    'astro:before-swap',
    promoteIncomingCardForReturnMorph,
  );
  document.addEventListener('astro:before-swap', saveScroll);
  // Synchronous scroll restore inside the View-Transition update
  // callback. View-Transition snapshots include only elements
  // inside the viewport at capture time — without this, the browser
  // captures the new page at scrollY=0 and any source element below
  // the fold (e.g. a card deep inside an expanded /history day) is
  // dropped from the new snapshot, the morph pair fails, and the
  // navigation falls back to the default root cross-fade. The
  // `astro:page-load` rAF restore below still runs to handle lazy-
  // image and filter-driven layout reflow that happens after the
  // transition completes.
  document.addEventListener('astro:after-swap', () => {
    try {
      const raw = sessionStorage.getItem(
        `scroll:${window.location.pathname}`,
      );
      if (raw === null) return;
      const target = Number.parseInt(raw, 10);
      if (!Number.isFinite(target) || target <= 0) return;
      window.scrollTo(0, target);
    } catch {
      /* storage disabled — no-op */
    }
  });
  // Force the site header opaque during a view transition so the
  // body-root cross-fade ghost (old + new content overlapping at
  // 50% opacity mid-transition) does not "swim" through the
  // header's translucent backdrop-blur backplate. The snapshot of
  // the new header is captured AFTER astro:before-preparation
  // fires, so toggling the class then is in time.
  document.addEventListener('astro:before-preparation', () => {
    document.documentElement.dataset['vtActive'] = '1';
  });
  document.addEventListener('astro:after-swap', () => {
    delete document.documentElement.dataset['vtActive'];
  });
  // Wipe view-transition-name from the live DOM so the next
  // navigation captures zero named card-groups by default — the
  // promotion handlers above re-add a single name on the card the
  // user is actually morphing to/from.
  document.addEventListener('astro:after-swap', () => {
    clearAllVtNames(document);
  });
  window.addEventListener('pagehide', saveScroll);
  document.addEventListener('astro:page-load', restoreScroll);
  // bfcache restore on iOS Safari: `astro:page-load` does NOT fire
  // when the browser back-navigates from an external link and the
  // page is served from bfcache. `pageshow` with `persisted === true`
  // is the signal for that path — without it, Safari sees
  // `scrollRestoration = 'manual'` and leaves the scroll at 0.
  // restoreScroll is idempotent and safe to run again; it will read
  // the saved scrollY and tick.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) restoreScroll();
  });
  restoreScroll();
}
