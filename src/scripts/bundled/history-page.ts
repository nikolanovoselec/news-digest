// Implements REQ-READ-007
//
// Client-side search for the history page.
//
// When the query is >= 3 characters, matching articles render as a
// flat grid at the top (same breakpoint math as .digest-page__grid
// on the dashboard) and the day-grouped list below hides. Typing
// below 3 characters (or clearing the query) restores the
// day-grouped view instantly.
//
// Matching cards are CLONED into the flat grid (cheaper than
// splicing the live DOM around; the scroll position stays put).
// Clones have their `data-bound` flags stripped so the shared
// tag-trigger init helper re-binds click handlers on each clone.
// Without that rebind, the # disclosure buttons would be visually
// present but dead to taps. (Star toggles use document-level
// delegation set up by the layout-wide IIFE - they don't need a
// per-card rebind.)
//
// Reaches the helper via `window.__cardInteractions.init(root)`,
// exposed by the layout-wide IIFE bundle (`/scripts/card-
// interactions.js`). Importing the module statically would cause
// Astro/Vite to bundle a SECOND copy of the auto-wire IIFE into
// this page's chunk, producing duplicate document-level listeners
// and breaking favourites - see ADR AD20.
//
// Lifecycle: rewire on every astro:page-load (View Transitions
// rebuild the DOM), and tear down on every astro:before-swap so
// the previous listener doesn't leak across navigations.
// REQ-READ-007 - shared FLIP cascade for tag-railing reorder.
import { flipChipToFront, flipChipToPosition, isFlipLocked } from '~/lib/tag-railing-flip';
import { normalizeHashtag } from '~/lib/hashtags';

const MIN_QUERY_LEN = 3;

function initHistorySearch(): () => void {
  const input = document.querySelector<HTMLInputElement>(
    '[data-history-search]',
  );
  const searchGrid = document.querySelector<HTMLElement>('[data-search-grid]');
  const searchEmpty = document.querySelector<HTMLElement>('[data-search-empty]');
  const list = document.querySelector<HTMLElement>('[data-history-list]');
  const strip = document.querySelector<HTMLElement>('[data-tag-strip]');
  if (searchGrid === null || searchEmpty === null) {
    return () => {};
  }

  type CardEntry = { el: HTMLElement; haystack: string; tags: Set<string> };
  const cards: CardEntry[] = [];
  const source = document.querySelectorAll<HTMLElement>(
    '[data-history-list] [data-digest-card]',
  );
  for (const card of Array.from(source)) {
    const title =
      card.querySelector('.digest-card__title')?.textContent ?? '';
    const excerpt =
      card.querySelector('.digest-card__one-liner')?.textContent ?? '';
    const rawTags = card.dataset['tags'] ?? '';
    const tagSet = new Set(rawTags === '' ? [] : rawTags.split(','));
    cards.push({ el: card, haystack: (title + ' ' + excerpt).toLowerCase(), tags: tagSet });
  }

  const readSelectedTags = (): string[] => {
    if (strip === null) return [];
    const out: string[] = [];
    strip.querySelectorAll<HTMLElement>('[data-tag-chip].is-selected').forEach((chip) => {
      const t = chip.dataset['tag'];
      if (t !== undefined && t !== '') out.push(t);
    });
    return out;
  };

  const syncUrl = (qRaw: string, tags: string[]): void => {
    const url = new URL(window.location.href);
    if (qRaw.length >= MIN_QUERY_LEN) {
      url.searchParams.set('q', qRaw);
    } else {
      url.searchParams.delete('q');
    }
    if (tags.length > 0) {
      url.searchParams.set('tags', tags.join(','));
    } else {
      url.searchParams.delete('tags');
    }
    const next = url.pathname + (url.search === '' ? '' : url.search);
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState({}, '', next);
    }
  };

  const apply = (): void => {
    const qRaw = input !== null ? input.value.trim() : '';
    const q = qRaw.toLowerCase();
    const searching = q.length >= MIN_QUERY_LEN;
    const selectedTags = readSelectedTags();
    const tagFiltering = selectedTags.length > 0;
    const selectedSet = new Set(selectedTags);
    syncUrl(qRaw, selectedTags);

    if (!searching && !tagFiltering) {
      searchGrid.replaceChildren();
      searchGrid.hidden = true;
      searchEmpty.hidden = true;
      if (list !== null) list.hidden = false;
      return;
    }

    if (list !== null) list.hidden = true;
    searchGrid.replaceChildren();
    let matches = 0;
    for (const { el, haystack, tags } of cards) {
      if (searching && !haystack.includes(q)) continue;
      if (tagFiltering) {
        let any = false;
        for (const t of tags) {
          if (selectedSet.has(t)) { any = true; break; }
        }
        if (!any) continue;
      }
      const clone = el.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll<HTMLElement>('[data-bound="1"]')
        .forEach((b) => {
          b.removeAttribute('data-bound');
        });
      searchGrid.appendChild(clone);
      matches++;
    }
    searchGrid.hidden = false;
    if (matches === 0) {
      const parts: string[] = [];
      if (searching) parts.push(`"${qRaw}"`);
      if (tagFiltering) parts.push(selectedTags.map((t) => `#${t}`).join(' '));
      searchEmpty.textContent = `No articles match ${parts.join(' + ')}.`;
      searchEmpty.hidden = false;
    } else {
      searchEmpty.hidden = true;
    }
    window.__cardInteractions?.init(searchGrid);
  };

  if (input !== null) {
    input.addEventListener('input', apply);
  }

  const stripWrap = document.querySelector<HTMLElement>('[data-tag-strip-wrap]');
  const stripClickHandler = (e: Event): void => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const probableStrip = target.closest<HTMLElement>('[data-tag-strip]');
    if (probableStrip !== null && isFlipLocked(probableStrip)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const removeHit = target.closest<HTMLElement>('[data-tag-remove]');
    if (removeHit !== null) {
      e.preventDefault();
      e.stopPropagation();
      const chip = removeHit.closest<HTMLElement>('[data-tag-chip]');
      const tag = chip?.dataset['tag'];
      if (tag !== undefined && tag !== '') {
        void removeTag(tag);
      }
      return;
    }
    const chip = target.closest<HTMLElement>('[data-tag-chip]');
    if (chip === null) return;
    const wasSelected = chip.classList.contains('is-selected');
    chip.classList.toggle('is-selected', !wasSelected);
    chip.setAttribute('aria-pressed', wasSelected ? 'false' : 'true');
    const thisStrip = chip.closest<HTMLElement>('[data-tag-strip]');
    if (thisStrip !== null) {
      if (!wasSelected) {
        void flipChipToFront(thisStrip, chip);
      } else {
        const chipCount = Number.parseInt(chip.dataset['count'] ?? '0', 10);
        const chipTag = chip.dataset['tag'] ?? '';
        let beforeNode: HTMLElement | null = null;
        const allChips = thisStrip.querySelectorAll<HTMLElement>('[data-tag-chip]');
        for (const other of allChips) {
          if (other === chip) continue;
          if (other.classList.contains('is-selected')) continue;
          const otherCount = Number.parseInt(other.dataset['count'] ?? '0', 10);
          const otherTag = other.dataset['tag'] ?? '';
          if (chipCount > otherCount) { beforeNode = other; break; }
          if (chipCount === otherCount && chipTag.localeCompare(otherTag) < 0) {
            beforeNode = other;
            break;
          }
        }
        void flipChipToPosition(thisStrip, chip, beforeNode);
      }
    }
    apply();
  };
  if (stripWrap !== null) {
    stripWrap.addEventListener('click', stripClickHandler);
  }

  const url = new URL(window.location.href);
  const urlQ = url.searchParams.get('q');
  const urlTags = url.searchParams.get('tags');
  let needsApply = false;
  if (input !== null && urlQ !== null && urlQ.length >= MIN_QUERY_LEN) {
    input.value = urlQ;
    needsApply = true;
  }
  if (urlTags !== null && urlTags !== '') {
    const set = new Set(urlTags.split(',').map((t) => t.trim()).filter(Boolean));
    if (strip !== null) {
      strip.querySelectorAll<HTMLElement>('[data-tag-chip]').forEach((chip) => {
        const tag = chip.dataset['tag'];
        if (tag !== undefined && set.has(tag)) {
          chip.classList.add('is-selected');
          chip.setAttribute('aria-pressed', 'true');
        }
      });
      const selected = Array.from(
        strip.querySelectorAll<HTMLElement>('[data-tag-chip].is-selected'),
      );
      for (let i = selected.length - 1; i >= 0; i -= 1) {
        strip.insertBefore(selected[i]!, strip.firstChild);
      }
    }
    needsApply = true;
  }
  const ssrAlreadyPopulated =
    searchGrid.children.length > 0 &&
    searchGrid.hidden === false &&
    (input === null || input.value.trim() === '');
  if (needsApply && !ssrAlreadyPopulated) apply();

  return () => {
    if (input !== null) {
      input.removeEventListener('input', apply);
    }
    if (stripWrap !== null) {
      stripWrap.removeEventListener('click', stripClickHandler);
    }
  };
}

function currentStripTags(): string[] {
  const strip = document.querySelector<HTMLElement>('[data-tag-strip]');
  if (strip === null) return [];
  return Array.from(strip.querySelectorAll<HTMLElement>('[data-tag-chip]'))
    .map((chip) => chip.dataset['tag'] ?? '')
    .filter((t) => t !== '');
}

async function saveTagsList(tags: string[]): Promise<boolean> {
  try {
    const res = await fetch('/api/tags', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function addTag(tag: string): Promise<void> {
  const next = currentStripTags();
  if (!next.includes(tag)) next.push(tag);
  if (await saveTagsList(next)) window.location.reload();
}

async function removeTag(tag: string): Promise<void> {
  const next = currentStripTags().filter((t) => t !== tag);
  if (await saveTagsList(next)) window.location.reload();
}

function initTagAdd(): void {
  const addButton = document.querySelector<HTMLButtonElement>('[data-tag-add]');
  const addInput = document.querySelector<HTMLInputElement>('[data-tag-add-input]');
  if (addButton === null || addInput === null) return;
  if (addButton.dataset['addBound'] === '1') return;
  addButton.dataset['addBound'] = '1';
  const reveal = (): void => {
    addButton.hidden = true;
    addInput.hidden = false;
    addInput.focus();
  };
  const cancel = (): void => {
    addInput.value = '';
    addInput.hidden = true;
    addButton.hidden = false;
  };
  const submit = (): void => {
    const raw = normalizeHashtag(addInput.value);
    if (raw === '') { cancel(); return; }
    void addTag(raw);
  };
  addButton.addEventListener('click', reveal);
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); return; }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
  });
  addInput.addEventListener('blur', () => {
    if (addInput.value.trim() === '') cancel();
    else submit();
  });
}

interface HistoryWin extends Window {
  __historySearchTeardown?: () => void;
}
const hwin = window as unknown as HistoryWin;

function reinit(): void {
  if (typeof hwin.__historySearchTeardown === 'function') {
    hwin.__historySearchTeardown();
  }
  hwin.__historySearchTeardown = initHistorySearch();
  initTagAdd();
  initDayStatePersistence();
}

function initDayStatePersistence(): void {
  const STORAGE_KEY = 'history:last-day-state';
  const list = document.querySelector<HTMLElement>('[data-history-list]');
  if (list === null) return;

  interface DayState {
    date: string;
    scrollY: number;
  }

  function read(): DayState | null {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw === null || raw === '') return null;
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>)['date'] === 'string' &&
        typeof (parsed as Record<string, unknown>)['scrollY'] === 'number'
      ) {
        return parsed as DayState;
      }
      return null;
    } catch {
      return null;
    }
  }

  function write(state: DayState): void {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Quota / private mode - silent fallback (no persistence).
    }
  }

  function clear(): void {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Same fallback.
    }
  }

  list.addEventListener('toggle', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (target === null || !(target instanceof HTMLDetailsElement)) return;
    if (!target.matches('.history__details')) return;
    const li = target.closest<HTMLElement>('[data-history-day]');
    if (li === null) return;
    const date = li.dataset['date'];
    if (typeof date !== 'string' || date === '') return;
    if (target.open) {
      write({ date, scrollY: window.scrollY });
    } else {
      const saved = read();
      if (saved !== null && saved.date === date) clear();
    }
  }, true /* capture so we get the first toggle */);

  list.addEventListener(
    'click',
    (ev) => {
      const a = (ev.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href^="/digest/"]');
      if (a === null || a === undefined) return;
      const li = a.closest<HTMLElement>('[data-history-day]');
      if (li === null) return;
      const date = li.dataset['date'];
      if (typeof date !== 'string' || date === '') return;
      write({ date, scrollY: window.scrollY });
    },
    true,
  );

  const params = new URLSearchParams(window.location.search);
  if (params.has('date')) return;

  const state = read();
  if (state === null) return;
  const day = list.querySelector<HTMLElement>(
    `[data-history-day][data-date="${CSS.escape(state.date)}"]`,
  );
  if (day === null) return;
  const det = day.querySelector<HTMLDetailsElement>('.history__details');
  if (det === null) return;
  det.open = true;
  requestAnimationFrame(() => {
    window.scrollTo({ top: state.scrollY, left: 0, behavior: 'auto' });
  });
}

if (document.documentElement.dataset['historySearchBound'] !== '1') {
  document.documentElement.dataset['historySearchBound'] = '1';
  document.addEventListener('astro:before-swap', () => {
    if (typeof hwin.__historySearchTeardown === 'function') {
      hwin.__historySearchTeardown();
      delete hwin.__historySearchTeardown;
    }
  });
  document.addEventListener('astro:page-load', reinit);
  reinit();
}
