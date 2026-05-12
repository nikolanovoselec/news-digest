// Implements REQ-READ-001
// Implements REQ-READ-007
//
// Three responsibilities:
//   1. Tick the "Next update in Xm" (or "Xh Ym") countdown every 10s from
//      the server-rendered next_scrape_at; refetch /api/digest/today
//      when the countdown hits zero and re-render the header+grid.
//   2. Toggle the offline banner based on navigator.onLine.
//   3. Wire the tag-strip filter (add / remove / toggle-select);
//      reorder selected chip to slot 0 via the shared FLIP cascade
//      (REQ-READ-007) so the motion confirms the tap and the chip
//      never "disappears" mid-flight.

import { flipChipToFront, flipChipToPosition, isFlipLocked } from '~/lib/tag-railing-flip';
import { normalizeHashtag } from '~/lib/hashtags';

let countdownHandle: number | null = null;

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return '0m';
  const totalMinutes = Math.ceil(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${m}m`;
}

async function refetchAndReplace(opts?: { reload?: boolean }): Promise<void> {
  try {
    const res = await fetch('/api/digest/today', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const body = (await res.json()) as {
      last_scrape_run: { started_at: number } | null;
      next_scrape_at: number;
      articles: unknown[];
    };
    const el = document.querySelector<HTMLElement>('[data-countdown]');
    if (el !== null) {
      el.dataset['nextAt'] = String(body.next_scrape_at);
    }
    if (opts?.reload === true) {
      window.location.reload();
    }
  } catch {
    /* ignore -- the next tick retries */
  }
}

function tickCountdown(): void {
  const el = document.querySelector<HTMLElement>('[data-countdown]');
  const textEl = document.querySelector<HTMLElement>('[data-countdown-text]');
  const headerEl = document.querySelector<HTMLElement>('[data-countdown-header]');
  if (el === null || textEl === null) return;
  if (el.dataset['running'] === '1') return;
  const raw = el.dataset['nextAt'];
  if (raw === undefined || raw === '') return;
  const nextAt = Number.parseInt(raw, 10);
  if (Number.isNaN(nextAt)) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const remaining = nextAt - nowSec;
  if (remaining <= 0) {
    textEl.textContent = '0m';
    el.dataset['nextAt'] = String(nowSec + 60);
    void refetchAndReplace();
    return;
  }
  textEl.textContent = formatCountdown(remaining);
  if (headerEl !== null) headerEl.textContent = 'Next update in ';
}

async function pollScrapeStatus(): Promise<void> {
  try {
    const res = await fetch('/api/scrape-status', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const body = (await res.json()) as {
      running: boolean;
      chunks_remaining?: number | null;
      chunks_total?: number | null;
    };
    const el = document.querySelector<HTMLElement>('[data-countdown]');
    const textEl = document.querySelector<HTMLElement>('[data-countdown-text]');
    const headerEl = document.querySelector<HTMLElement>('[data-countdown-header]');
    if (el === null || textEl === null || headerEl === null) return;
    if (body.running) {
      el.dataset['running'] = '1';
      headerEl.textContent = 'Update ';
      textEl.textContent = 'in progress…';
    } else if (el.dataset['running'] === '1') {
      delete el.dataset['running'];
      void refetchAndReplace({ reload: true });
      tickCountdown();
    }
  } catch {
    /* poll silently; the next tick retries */
  }
}

function wireCountdown(): void {
  if (countdownHandle !== null) return;
  const el = document.querySelector<HTMLElement>('[data-countdown]');
  if (el === null) return;
  tickCountdown();
  void pollScrapeStatus();
  countdownHandle = window.setInterval(() => {
    tickCountdown();
    void pollScrapeStatus();
  }, 10_000);
}

function wireOfflineBanner(): void {
  const banner = document.querySelector<HTMLElement>('[data-offline-banner]');
  if (banner === null) return;
  const update = (): void => {
    banner.hidden = window.navigator.onLine;
  };
  update();
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
}

function teardown(): void {
  if (countdownHandle !== null) {
    window.clearInterval(countdownHandle);
    countdownHandle = null;
  }
}

function init(): void {
  if (document.querySelector('[data-digest-page]') === null) return;
  wireCountdown();
  wireOfflineBanner();
  wireTagStrip();
}

function tagStripTags(strip: HTMLElement): string[] {
  return Array.from(
    strip.querySelectorAll<HTMLElement>('[data-tag-chip]'),
  ).map((el) => el.dataset['tag'] ?? '').filter((t) => t !== '');
}

async function saveTags(tags: string[]): Promise<boolean> {
  try {
    const res = await fetch('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ tags }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function renderTagChip(strip: HTMLElement, tag: string): HTMLElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'tag-chip';
  chip.dataset['tagChip'] = '';
  chip.dataset['tag'] = tag;
  chip.dataset['count'] = '0';
  chip.setAttribute('aria-pressed', 'false');
  chip.setAttribute(
    'aria-label',
    `${tag} - 0 articles today. Click to filter, click again to deselect.`,
  );
  const label = document.createElement('span');
  label.className = 'tag-chip__label';
  const hash = document.createElement('span');
  hash.className = 'tag-chip__hash';
  hash.setAttribute('aria-hidden', 'true');
  hash.textContent = '#';
  label.appendChild(hash);
  label.appendChild(document.createTextNode(tag));
  chip.appendChild(label);

  const slot = document.createElement('span');
  slot.className = 'tag-chip__slot';
  slot.setAttribute('aria-hidden', 'true');
  const count = document.createElement('span');
  count.className = 'tag-chip__count';
  count.textContent = '';
  slot.appendChild(count);
  const remove = document.createElement('span');
  remove.className = 'tag-chip__remove';
  remove.dataset['tagRemove'] = '';
  remove.setAttribute('role', 'button');
  remove.setAttribute('tabindex', '-1');
  remove.setAttribute('aria-label', `Remove ${tag} from your hashtags`);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    'M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z',
  );
  svg.appendChild(path);
  remove.appendChild(svg);
  slot.appendChild(remove);
  chip.appendChild(slot);

  strip.appendChild(chip);
  return chip;
}

function showTagError(strip: HTMLElement, message: string): void {
  let region = strip.querySelector<HTMLElement>('[data-tag-error]');
  if (region === null) {
    region = document.createElement('span');
    region.className = 'tag-strip__error';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.dataset['tagError'] = '';
    strip.appendChild(region);
  }
  region.textContent = message;
  const clearId = window.setTimeout(() => {
    if (region !== null && region.textContent === message) {
      region.textContent = '';
    }
  }, 3000);
  region.dataset['clearTimeout'] = String(clearId);
}

function wireTagStrip(): void {
  const strip = document.querySelector<HTMLElement>('[data-tag-strip]');
  if (strip === null || strip.dataset['bound'] === '1') return;
  strip.dataset['bound'] = '1';

  const wrap = strip.closest<HTMLElement>('[data-tag-strip-wrap]') ?? document;
  const addButton = wrap.querySelector<HTMLButtonElement>('[data-tag-add]');
  const input = wrap.querySelector<HTMLInputElement>('[data-tag-add-input]');
  if (addButton === null || input === null) return;

  const reveal = (): void => {
    addButton.hidden = true;
    input.hidden = false;
    input.focus();
  };
  const hide = (): void => {
    input.value = '';
    input.hidden = true;
    addButton.hidden = false;
  };
  // Keep in sync with MAX_HASHTAGS on the server (src/pages/api/settings.ts).
  const MAX_TAGS = 25;
  const commit = async (): Promise<void> => {
    const tag = normalizeHashtag(input.value);
    if (tag.length < 2 || tag.length > 32) {
      hide();
      return;
    }
    const existing = tagStripTags(strip);
    if (existing.includes(tag)) {
      hide();
      return;
    }
    if (existing.length >= MAX_TAGS) {
      showTagError(strip, `Max ${MAX_TAGS} tags. Remove one first.`);
      hide();
      return;
    }
    const chip = renderTagChip(strip, tag);
    hide();
    const ok = await saveTags([...existing, tag]);
    if (!ok) {
      chip.remove();
      showTagError(strip, 'Could not save. Please try again.');
    }
  };

  addButton.addEventListener('click', reveal);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (!input.hidden && document.activeElement !== input) hide();
    }, 150);
  });

  const syncUrlTags = (selected: string[]): void => {
    const url = new URL(window.location.href);
    if (selected.length > 0) {
      url.searchParams.set('tags', selected.join(','));
    } else {
      url.searchParams.delete('tags');
    }
    const next = url.pathname + (url.search === '' ? '' : url.search);
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState({}, '', next);
    }
  };

  const applyFilter = (): void => {
    const selectedList: string[] = [];
    strip
      .querySelectorAll<HTMLElement>('[data-tag-chip].is-selected')
      .forEach((el) => {
        const t = el.dataset['tag'];
        if (t !== undefined && t !== '') selectedList.push(t);
      });
    const selected = new Set(selectedList);
    syncUrlTags(selectedList);
    const cards = document.querySelectorAll<HTMLElement>('[data-digest-card]');
    let visible = 0;
    cards.forEach((card) => {
      if (selected.size === 0) {
        delete card.dataset['filterHide'];
        visible++;
        return;
      }
      const raw = card.dataset['tags'] ?? '';
      const cardTags = raw === '' ? [] : raw.split(',');
      const match = cardTags.some((t) => selected.has(t));
      if (match) {
        delete card.dataset['filterHide'];
        visible++;
      } else {
        card.dataset['filterHide'] = '1';
      }
    });
    const noMatch = document.querySelector<HTMLElement>('[data-tag-nomatch]');
    if (noMatch !== null) {
      noMatch.hidden = !(selected.size > 0 && visible === 0);
    }
  };

  const hydrateFromUrl = (): void => {
    const raw = new URL(window.location.href).searchParams.get('tags');
    if (raw === null || raw === '') return;
    const tokens = new Set(
      raw.split(',').map((t) => t.trim()).filter((t) => t !== ''),
    );
    strip.querySelectorAll<HTMLElement>('[data-tag-chip]').forEach((chip) => {
      const tag = chip.dataset['tag'];
      if (tag !== undefined && tokens.has(tag)) {
        chip.classList.add('is-selected');
        chip.setAttribute('aria-pressed', 'true');
      }
    });
  };
  const pinSelectedToFront = (): void => {
    const selected = Array.from(
      strip.querySelectorAll<HTMLElement>('[data-tag-chip].is-selected'),
    );
    for (let i = selected.length - 1; i >= 0; i -= 1) {
      strip.insertBefore(selected[i]!, strip.firstChild);
    }
  };

  hydrateFromUrl();
  pinSelectedToFront();
  applyFilter();

  strip.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (target === null) return;
    if (isFlipLocked(strip)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const removeHit = target.closest<HTMLElement>('[data-tag-remove]');
    if (removeHit !== null) {
      e.preventDefault();
      e.stopPropagation();
      const chip = removeHit.closest<HTMLElement>('[data-tag-chip]');
      if (chip === null) return;
      const tag = chip.dataset['tag'] ?? '';
      if (tag === '') return;
      if (tagStripTags(strip).length <= 1) {
        showTagError(strip, 'At least one tag is required.');
        return;
      }
      chip.remove();
      applyFilter();
      const remaining = tagStripTags(strip);
      void (async () => {
        const ok = await saveTags(remaining);
        if (!ok) {
          renderTagChip(strip, tag);
          applyFilter();
          showTagError(strip, 'Could not save. Please try again.');
        }
      })();
      return;
    }
    const chip = target.closest<HTMLElement>('[data-tag-chip]');
    if (chip === null) return;
    e.preventDefault();
    const tag = chip.dataset['tag'] ?? '';
    if (tag === '') return;
    const nowSelected = chip.classList.toggle('is-selected');
    chip.setAttribute('aria-pressed', nowSelected ? 'true' : 'false');
    if (nowSelected) {
      void flipChipToFront(strip, chip);
    } else {
      const chipCount = Number.parseInt(chip.dataset['count'] ?? '0', 10);
      const chipTag = chip.dataset['tag'] ?? '';
      let beforeNode: HTMLElement | null = null;
      const allChips = strip.querySelectorAll<HTMLElement>('[data-tag-chip]');
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
      void flipChipToPosition(strip, chip, beforeNode);
    }
    applyFilter();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
document.addEventListener('astro:page-load', init);
document.addEventListener('astro:before-swap', teardown);
