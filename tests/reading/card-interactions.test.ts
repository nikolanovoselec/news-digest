// Integration tests for src/scripts/card-interactions.ts — REQ-STAR-001
// + the tag-disclosure popover behaviour of REQ-READ-001.
//
// These tests drive the actual click handler through a jsdom DOM so
// regressions like "the star doesn't toggle" or "the # does nothing"
// fail the suite BEFORE they ship, instead of only surfacing in
// manual mobile testing. The handler is direct-binding (one
// addEventListener per button), not document-level capture, so the
// test mirrors what the browser does: build the DOM, call the init,
// dispatch real `click` events via `.click()`, assert aria-pressed
// flipped, assert the fetch call was made with the right verb.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  initCardInteractions,
  handleStarClick,
  toggleTagDisclosure,
  closeAllTagPopovers,
} from '~/scripts/card-interactions';

/** Build the DOM that DigestCard.astro actually renders. The exact
 *  attribute names + class structure matter — the handlers key off
 *  `[data-star-toggle]`, `[data-tag-trigger]`, `[data-tag-disclosure]`. */
function makeCardDom(opts: {
  articleId: string;
  starred?: boolean;
  tags?: string[];
}): HTMLElement {
  const article = document.createElement('article');
  article.className = 'digest-card';
  article.dataset['digestCard'] = '';
  article.dataset['articleId'] = opts.articleId;
  article.dataset['starred'] = opts.starred ? 'true' : 'false';

  // Anchor wraps title only — star + # are siblings.
  const link = document.createElement('a');
  link.className = 'digest-card__link';
  link.href = `/digest/${opts.articleId}/slug`;
  const title = document.createElement('h2');
  title.className = 'digest-card__title';
  title.textContent = `Title ${opts.articleId}`;
  link.appendChild(title);
  article.appendChild(link);

  const footer = document.createElement('footer');
  footer.className = 'digest-card__footer';

  const starBtn = document.createElement('button');
  starBtn.type = 'button';
  starBtn.className = 'digest-card__star';
  starBtn.dataset['starToggle'] = '';
  starBtn.dataset['articleId'] = opts.articleId;
  starBtn.setAttribute('aria-pressed', opts.starred ? 'true' : 'false');
  starBtn.setAttribute(
    'aria-label',
    opts.starred ? `Unstar ${opts.articleId}` : `Star ${opts.articleId}`,
  );
  footer.appendChild(starBtn);

  const tags = opts.tags ?? [];
  if (tags.length > 0) {
    const disclosure = document.createElement('div');
    disclosure.className = 'digest-card__tag-disclosure';
    disclosure.dataset['tagDisclosure'] = '';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'digest-card__tag-trigger';
    trigger.dataset['tagTrigger'] = '';
    trigger.setAttribute('aria-expanded', 'false');
    trigger.textContent = tags.length > 1 ? `#${tags.length}` : '#';
    const popover = document.createElement('div');
    popover.className = 'digest-card__tag-popover';
    for (const t of tags) {
      const chip = document.createElement('span');
      chip.className = 'digest-card__tag-chip';
      chip.textContent = `#${t}`;
      popover.appendChild(chip);
    }
    disclosure.appendChild(trigger);
    disclosure.appendChild(popover);
    footer.appendChild(disclosure);
  }

  article.appendChild(footer);
  document.body.appendChild(article);
  return article;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-card-outside-click-bound');
  // Reset any global fetch mock from a prior test.
  vi.restoreAllMocks();
});

describe('initCardInteractions — REQ-STAR-001 AC 1', () => {
  it('REQ-STAR-001: clicking an unstarred button flips aria-pressed to true and POSTs /api/articles/:id/star', async () => {
    makeCardDom({ articleId: 'art-1', starred: false, tags: [] });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const bound = initCardInteractions();
    expect(bound).toBeGreaterThan(0);

    const btn = document.querySelector<HTMLButtonElement>('[data-star-toggle]')!;
    btn.click();
    // await microtasks so the fetch and the .then settle
    await Promise.resolve();
    await Promise.resolve();

    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/articles/art-1/star');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).credentials).toBe('same-origin');
  });

  it('REQ-STAR-001: clicking a starred button flips aria-pressed to false and DELETEs', async () => {
    makeCardDom({ articleId: 'art-2', starred: true, tags: [] });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    initCardInteractions();
    const btn = document.querySelector<HTMLButtonElement>('[data-star-toggle]')!;
    btn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(btn.getAttribute('aria-pressed')).toBe('false');
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('REQ-STAR-001: on non-2xx response the optimistic flip reverts', async () => {
    makeCardDom({ articleId: 'art-3', starred: false, tags: [] });
    const fetchMock = vi.fn().mockResolvedValue(new Response('err', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    initCardInteractions();
    const btn = document.querySelector<HTMLButtonElement>('[data-star-toggle]')!;
    btn.click();
    // Optimistic flip is synchronous.
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    // After the fetch resolves with non-2xx, the revert happens.
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('REQ-STAR-001: on fetch throw the optimistic flip reverts', async () => {
    makeCardDom({ articleId: 'art-4', starred: false, tags: [] });
    const fetchMock = vi.fn().mockRejectedValue(new Error('net'));
    vi.stubGlobal('fetch', fetchMock);

    initCardInteractions();
    const btn = document.querySelector<HTMLButtonElement>('[data-star-toggle]')!;
    btn.click();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('REQ-STAR-001: a button with no data-article-id is a no-op (no fetch)', async () => {
    const card = makeCardDom({ articleId: 'art-5', starred: false, tags: [] });
    const btn = card.querySelector<HTMLButtonElement>('[data-star-toggle]')!;
    btn.removeAttribute('data-article-id');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    initCardInteractions();
    btn.click();
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('REQ-STAR-001: handleStarClick is directly callable without going through click', async () => {
    // Export-level contract test — lets callers outside the click
    // handler (e.g. a keyboard-shortcut binder) invoke the same
    // toggle logic.
    const card = makeCardDom({ articleId: 'direct', starred: false, tags: [] });
    const btn = card.querySelector<HTMLButtonElement>('[data-star-toggle]')!;
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await handleStarClick(btn);

    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/articles/direct/star',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('tag-disclosure popover — REQ-READ-001 AC 6', () => {
  it('clicking # flips aria-expanded and opens the popover', () => {
    makeCardDom({ articleId: 'art-pop', starred: false, tags: ['ai', 'cloudflare', 'rust'] });
    initCardInteractions();

    const trigger = document.querySelector<HTMLButtonElement>('[data-tag-trigger]')!;
    const disclosure = document.querySelector<HTMLElement>('[data-tag-disclosure]')!;

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(disclosure.classList.contains('is-open')).toBe(false);

    trigger.click();

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(disclosure.classList.contains('is-open')).toBe(true);
  });

  it('clicking # twice closes the popover', () => {
    makeCardDom({ articleId: 'art-pop2', starred: false, tags: ['ai', 'rust'] });
    initCardInteractions();

    const trigger = document.querySelector<HTMLButtonElement>('[data-tag-trigger]')!;
    const disclosure = document.querySelector<HTMLElement>('[data-tag-disclosure]')!;

    trigger.click();
    expect(disclosure.classList.contains('is-open')).toBe(true);

    trigger.click();
    expect(disclosure.classList.contains('is-open')).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('clicking OUTSIDE the disclosure closes every open popover', () => {
    makeCardDom({ articleId: 'art-pop3', starred: false, tags: ['ai'] });
    initCardInteractions();
    const trigger = document.querySelector<HTMLButtonElement>('[data-tag-trigger]')!;
    const disclosure = document.querySelector<HTMLElement>('[data-tag-disclosure]')!;

    trigger.click();
    expect(disclosure.classList.contains('is-open')).toBe(true);

    // Click on something completely unrelated.
    const anywhere = document.createElement('div');
    document.body.appendChild(anywhere);
    anywhere.click();

    expect(disclosure.classList.contains('is-open')).toBe(false);
  });

  it('exports toggleTagDisclosure + closeAllTagPopovers for direct use', () => {
    makeCardDom({ articleId: 'art-direct', starred: false, tags: ['ai', 'rust'] });
    const trigger = document.querySelector<HTMLButtonElement>('[data-tag-trigger]')!;
    const disclosure = document.querySelector<HTMLElement>('[data-tag-disclosure]')!;

    toggleTagDisclosure(trigger);
    expect(disclosure.classList.contains('is-open')).toBe(true);

    closeAllTagPopovers();
    expect(disclosure.classList.contains('is-open')).toBe(false);
  });
});

describe('re-entrancy — REQ-STAR-001 and REQ-READ-001', () => {
  it('running init twice does NOT double-bind handlers (one fetch per click)', async () => {
    makeCardDom({ articleId: 'art-rebound', starred: false, tags: [] });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    initCardInteractions();
    initCardInteractions();  // astro:page-load simulation

    const btn = document.querySelector<HTMLButtonElement>('[data-star-toggle]')!;
    btn.click();
    await new Promise((r) => setTimeout(r, 0));

    // If re-init double-bound the handler, fetch would fire twice and
    // the second would DELETE the star we just POSTed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('adding a new card to the DOM after init picks up the handler on next init()', async () => {
    // Simulates Astro ViewTransition: a new set of cards lands in
    // the DOM; init() is called again and binds the new buttons.
    makeCardDom({ articleId: 'art-first', starred: false, tags: [] });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    initCardInteractions();
    makeCardDom({ articleId: 'art-second', starred: false, tags: [] });
    initCardInteractions();

    const secondBtn = document.querySelectorAll<HTMLButtonElement>(
      '[data-star-toggle]',
    )[1]!;
    secondBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/articles/art-second/star');
  });
});
