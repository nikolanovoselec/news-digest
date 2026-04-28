// Implements REQ-DES-002, REQ-DES-003, REQ-HIST-001, REQ-PWA-003, REQ-SET-007, REQ-READ-002
//
// Layout-level client behaviour. Served as a static file from /public so
// CSP `script-src 'self'` permits it (Astro 5 directRenderScript inlines
// `<script>import './module';</script>` blocks regardless of size, and
// every inline emit gets blocked by the CSP). The .ts source under
// src/scripts/page-effects.ts mirrors this file and is kept for tests
// that read it via `?raw` imports.

async function syncBrowserTz() {
  const body = document.body;
  const stored = body.dataset.userTz ?? '';
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
      body.dataset.userTz = browser;
    }
  } catch {
    /* network hiccup — next page load will retry */
  }
}

if (document.documentElement.dataset.tzAutoBound !== '1') {
  document.documentElement.dataset.tzAutoBound = '1';
  void syncBrowserTz();
  document.addEventListener('astro:page-load', () => {
    void syncBrowserTz();
  });
}

let currentPath = window.location.pathname;
const KEY = () => `scroll:${currentPath}`;

function saveScroll() {
  try {
    sessionStorage.setItem(KEY(), String(window.scrollY));
  } catch {
    /* storage quota / disabled */
  }
}

function restoreScroll() {
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
    let ro = null;
    const teardown = () => {
      cancelled = true;
      if (ro !== null) {
        ro.disconnect();
        ro = null;
      }
    };
    window.addEventListener('wheel', teardown, { once: true, passive: true });
    window.addEventListener('touchmove', teardown, { once: true, passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        if (cancelled) return;
        window.scrollTo(0, target);
      });
      ro.observe(document.documentElement);
    }
    const tick = () => {
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
    /* storage disabled */
  }
}

function preFilterIncomingDocument(e) {
  const ev = e;
  const path = ev.to?.pathname ?? '';
  if (path !== '/digest' && path !== '/history') return;
  const raw = ev.to.searchParams.get('tags');
  if (raw === null || raw === '') return;
  const selected = new Set(
    raw.split(',').map((t) => t.trim()).filter((t) => t !== ''),
  );
  if (selected.size === 0) return;
  const doc = ev.newDocument;
  if (doc === undefined) return;
  doc.querySelectorAll('[data-digest-card]').forEach((card) => {
    const cardTags = (card.dataset.tags ?? '').split(',').filter((t) => t !== '');
    const match = cardTags.some((t) => selected.has(t));
    if (!match) card.dataset.filterHide = '1';
  });
  doc.querySelectorAll('[data-tag-chip]').forEach((chip) => {
    const tag = chip.dataset.tag;
    if (tag !== undefined && selected.has(tag)) {
      chip.classList.add('is-selected');
      chip.setAttribute('aria-pressed', 'true');
    }
  });
}

function preOpenHistoryDayInIncomingDocument(e) {
  const ev = e;
  const path = ev.to?.pathname ?? '';
  if (path !== '/history') return;
  if (ev.to.searchParams.has('date')) return;
  let raw = null;
  try {
    raw = sessionStorage.getItem('history:last-day-state');
  } catch {
    return;
  }
  if (raw === null || raw === '') return;
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const date = parsed.date;
  if (typeof date !== 'string' || date === '') return;
  const doc = ev.newDocument;
  if (doc === undefined) return;
  const day = doc.querySelector(
    `[data-history-day][data-date="${CSS.escape(date)}"]`,
  );
  if (day === null) return;
  const det = day.querySelector('.history__details');
  if (det === null) return;
  det.open = true;
}

// Single-named-group view-transition shaping. DigestCard no longer
// emits a default transition:name — capturing every card on /digest
// and especially /history (100+ named elements across opened days)
// imposed O(N) snapshot/bookkeeping cost for a morph that only ever
// pairs one card with the article-detail header. Promote exactly one
// card per navigation, clear all on after-swap.
const ARTICLE_DETAIL_PATH_RE = /^\/digest\/[^/]+\/([^/]+)\/?$/;

function findPromotableCard(scope, slug) {
  const cards = scope.querySelectorAll(
    `[data-digest-card][data-vt-slug="${CSS.escape(slug)}"]`,
  );
  for (const card of cards) {
    if (card.closest('[hidden]') !== null) continue;
    const det = card.closest('details');
    if (det !== null && !det.open) continue;
    const link = card.querySelector('a.digest-card__link');
    if (link !== null) return link;
  }
  return null;
}

function clearAllVtNames(scope) {
  scope
    .querySelectorAll('[data-digest-card] a.digest-card__link')
    .forEach((el) => {
      el.style.removeProperty('view-transition-name');
    });
}

function promoteSourceCardForOutgoingMorph(e) {
  const ev = e;
  const to = ev.to;
  if (to === undefined) return;
  const match = ARTICLE_DETAIL_PATH_RE.exec(to.pathname);
  if (match === null) return;
  const src = ev.sourceElement;
  if (!(src instanceof HTMLElement)) return;
  const card = src.closest('[data-digest-card][data-vt-slug]');
  if (card === null) return;
  const slug = card.dataset.vtSlug;
  if (typeof slug !== 'string' || slug === '') return;
  const link = card.querySelector('a.digest-card__link');
  if (link === null) return;
  clearAllVtNames(document);
  link.style.setProperty('view-transition-name', `card-${slug}`);
}

function promoteIncomingCardForReturnMorph(e) {
  const ev = e;
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

// Header brand link: scroll-to-top when already on /digest, otherwise
// fall through to Astro ClientRouter's default navigation.
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
function shouldInterceptBrandTap(target) {
  if (!(target instanceof Element)) return false;
  const link = target.closest('a[data-brand-home]');
  if (link === null) return false;
  if (window.location.pathname !== '/digest') return false;
  if (window.location.search !== '') return false;
  return true;
}

function scrollTopRespectingMotion() {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
}

function bindBrandLinkScrollToTop() {
  const root = document.documentElement;
  if (root.dataset.brandLinkBound === '1') return;
  root.dataset.brandLinkBound = '1';

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

if (document.documentElement.dataset.scrollRestoreBound !== '1') {
  document.documentElement.dataset.scrollRestoreBound = '1';
  if ('scrollRestoration' in window.history) {
    window.history.scrollRestoration = 'manual';
  }
  document.addEventListener(
    'astro:before-preparation',
    promoteSourceCardForOutgoingMorph,
  );
  document.addEventListener('astro:before-swap', preFilterIncomingDocument);
  document.addEventListener('astro:before-swap', preOpenHistoryDayInIncomingDocument);
  document.addEventListener(
    'astro:before-swap',
    promoteIncomingCardForReturnMorph,
  );
  document.addEventListener('astro:before-swap', saveScroll);
  document.addEventListener('astro:after-swap', () => {
    try {
      const raw = sessionStorage.getItem(`scroll:${window.location.pathname}`);
      if (raw === null) return;
      const target = Number.parseInt(raw, 10);
      if (!Number.isFinite(target) || target <= 0) return;
      window.scrollTo(0, target);
    } catch {
      /* storage disabled */
    }
  });
  document.addEventListener('astro:before-preparation', () => {
    document.documentElement.dataset.vtActive = '1';
  });
  document.addEventListener('astro:after-swap', () => {
    delete document.documentElement.dataset.vtActive;
  });
  // Wipe view-transition-name from every card on the live DOM so the
  // next navigation starts from the no-name baseline. The promotion
  // handlers re-add a single name on the card actually morphing.
  document.addEventListener('astro:after-swap', () => {
    clearAllVtNames(document);
  });
  window.addEventListener('pagehide', saveScroll);
  document.addEventListener('astro:page-load', restoreScroll);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) restoreScroll();
  });
  restoreScroll();
}
