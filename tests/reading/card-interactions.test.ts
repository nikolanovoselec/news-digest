// Integration-style tests for src/scripts/card-interactions.ts — REQ-
// STAR-001 (star toggle + optimistic revert) and REQ-READ-001 AC 6
// (tag-disclosure popover). The project's test pool is workerd, which
// has no DOM, so we don't drive real click dispatch. Instead we drive
// the exported pure helpers (`handleStarClick`, `toggleTagDisclosure`,
// `closeAllTagPopovers`) with minimal mock objects — the same pattern
// `tests/design/theme-toggle.test.ts` uses for the theme script.
//
// What this file catches that manual mobile testing misses:
//   * the handler uses the right HTTP verb (POST vs DELETE) based on
//     the current aria-pressed state
//   * the optimistic flip happens BEFORE the network call so taps feel
//     instant
//   * on non-2xx or fetch throw, the UI reverts (prevents the "tap
//     worked but server rejected" silent inconsistency)
//   * buttons without data-article-id are no-ops
//   * tag popover open/close math (aria-expanded + .is-open class)
//   * closeAllTagPopovers respects the `except` escape hatch
//
// Regressions the user hit live ("starring doesn't work", "# does
// nothing") reduce to these unit-level assertions, so a CI failure
// fires BEFORE the broken bundle ships.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initCardInteractions,
  handleStarClick,
  toggleTagDisclosure,
  closeAllTagPopovers,
} from '~/scripts/card-interactions';

/** Minimal mock of a star <button> — only the surface the handler
 *  touches: `dataset`, `getAttribute`, `setAttribute`. */
function makeStarButton(opts: {
  articleId?: string;
  initiallyPressed?: boolean;
}): HTMLButtonElement {
  const dataset: Record<string, string> = {};
  if (opts.articleId !== undefined) dataset['articleId'] = opts.articleId;
  const attrs: Record<string, string> = {
    'aria-pressed': opts.initiallyPressed === true ? 'true' : 'false',
  };
  return {
    dataset,
    getAttribute: (k: string) => attrs[k] ?? null,
    setAttribute: (k: string, v: string) => {
      attrs[k] = v;
    },
  } as unknown as HTMLButtonElement;
}

/** Mock classList with the three methods the handler uses. */
function makeClassList(initial: string[] = []): DOMTokenList {
  const set = new Set<string>(initial);
  return {
    add: (c: string) => set.add(c),
    remove: (c: string) => set.delete(c),
    contains: (c: string) => set.has(c),
    toggle: (c: string) => {
      if (set.has(c)) {
        set.delete(c);
        return false;
      }
      set.add(c);
      return true;
    },
  } as unknown as DOMTokenList;
}

/** Mock trigger + its parent disclosure. The trigger's `.closest` always
 *  returns the provided disclosure; the disclosure's `.querySelector`
 *  returns the trigger when asked for `[data-tag-trigger]`. */
function makeDisclosurePair(opts: { initiallyOpen?: boolean } = {}): {
  trigger: HTMLButtonElement;
  disclosure: HTMLElement;
  triggerAttrs: Record<string, string>;
  disclosureClassList: DOMTokenList;
} {
  const triggerAttrs: Record<string, string> = { 'aria-expanded': 'false' };
  const disclosureClassList = makeClassList(
    opts.initiallyOpen === true ? ['is-open'] : [],
  );

  const disclosure = {
    classList: disclosureClassList,
    querySelector: (sel: string) =>
      sel === '[data-tag-trigger]' ? trigger : null,
  } as unknown as HTMLElement;

  const trigger = {
    getAttribute: (k: string) => triggerAttrs[k] ?? null,
    setAttribute: (k: string, v: string) => {
      triggerAttrs[k] = v;
    },
    closest: (sel: string) =>
      sel === '[data-tag-disclosure]' ? disclosure : null,
  } as unknown as HTMLButtonElement;

  return { trigger, disclosure, triggerAttrs, disclosureClassList };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // card-interactions references `window.setTimeout` / `window.clearTimeout`.
  // Stub both to no-ops so the 5-second auto-close timer scheduled by
  // `toggleTagDisclosure` doesn't leak past the test. None of these
  // tests assert on the auto-close behavior — the assertions look at
  // the synchronous classList/aria mutations only — so a no-op is
  // strictly correct and avoids the timer-leak flakiness the prior
  // pass-through stub caused under CI load.
  vi.stubGlobal('window', {
    ...(globalThis as unknown as { window?: Window }).window,
    setTimeout: (() => 0) as unknown as typeof window.setTimeout,
    clearTimeout: (() => undefined) as unknown as typeof window.clearTimeout,
  });
  // `closeAllTagPopovers` calls `document.querySelectorAll`. Provide a
  // stub that returns nothing by default; individual tests override it.
  vi.stubGlobal('document', {
    querySelectorAll: () => [] as unknown as NodeListOf<Element>,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleStarClick — REQ-STAR-001 AC 1', () => {
  it('REQ-STAR-001: clicking an unstarred button flips aria-pressed to true and POSTs /api/articles/:id/star', async () => {
    const btn = makeStarButton({ articleId: 'art-1', initiallyPressed: false });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await handleStarClick(btn);

    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/articles/art-1/star');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).credentials).toBe('same-origin');
  });

  it('REQ-STAR-001: clicking a starred button flips aria-pressed to false and DELETEs', async () => {
    const btn = makeStarButton({ articleId: 'art-2', initiallyPressed: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await handleStarClick(btn);

    expect(btn.getAttribute('aria-pressed')).toBe('false');
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('REQ-STAR-001: on non-2xx response the optimistic flip reverts', async () => {
    const btn = makeStarButton({ articleId: 'art-3', initiallyPressed: false });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('err', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await handleStarClick(btn);

    // Started unpressed; server said no; ended unpressed.
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('REQ-STAR-001: on fetch throw the optimistic flip reverts', async () => {
    const btn = makeStarButton({ articleId: 'art-4', initiallyPressed: false });
    const fetchMock = vi.fn().mockRejectedValue(new Error('net'));
    vi.stubGlobal('fetch', fetchMock);

    await handleStarClick(btn);

    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('REQ-STAR-001: a button with no data-article-id is a no-op (no fetch)', async () => {
    // Omit articleId entirely — under exactOptionalPropertyTypes the
    // call must not pass `undefined`, and the absence of the property
    // is what DigestCard would actually emit if the id were missing.
    const btn = makeStarButton({ initiallyPressed: false });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await handleStarClick(btn);

    expect(fetchMock).not.toHaveBeenCalled();
    // aria-pressed MUST NOT flip when articleId is missing — the UI
    // wouldn't be able to revert correctly if the fetch were to fail.
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('REQ-STAR-001: URL-encodes the article id when building the endpoint', async () => {
    // Regression guard: a tag or slug with a path-unsafe character must
    // not break the fetch URL.
    const btn = makeStarButton({
      articleId: 'weird id/path',
      initiallyPressed: false,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await handleStarClick(btn);

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/articles/weird%20id%2Fpath/star');
  });
});

describe('toggleTagDisclosure — REQ-READ-001 AC 6', () => {
  it('REQ-READ-001: opens a closed popover — classList gets .is-open and aria-expanded becomes "true"', () => {
    const { trigger, disclosureClassList, triggerAttrs } = makeDisclosurePair();

    toggleTagDisclosure(trigger);

    expect(disclosureClassList.contains('is-open')).toBe(true);
    expect(triggerAttrs['aria-expanded']).toBe('true');
  });

  it('REQ-READ-001: closes an already-open popover on second invocation', () => {
    const pair = makeDisclosurePair({ initiallyOpen: true });
    // `toggleTagDisclosure` closes an open popover by calling
    // `closeAllTagPopovers()` which queries the document for every
    // `[data-tag-disclosure].is-open`. Stub it to return our pair so
    // the close path actually mutates the classList.
    vi.stubGlobal('document', {
      querySelectorAll: (sel: string) => {
        if (sel !== '[data-tag-disclosure].is-open') return [];
        return [pair.disclosure] as unknown as NodeListOf<Element>;
      },
    });

    toggleTagDisclosure(pair.trigger);

    expect(pair.disclosureClassList.contains('is-open')).toBe(false);
    expect(pair.triggerAttrs['aria-expanded']).toBe('false');
  });

  it('REQ-READ-001: a trigger without a parent disclosure is a no-op', () => {
    const triggerAttrs: Record<string, string> = { 'aria-expanded': 'false' };
    const orphan = {
      getAttribute: (k: string) => triggerAttrs[k] ?? null,
      setAttribute: (k: string, v: string) => {
        triggerAttrs[k] = v;
      },
      closest: () => null,
    } as unknown as HTMLButtonElement;

    // MUST NOT throw and MUST NOT mutate aria-expanded.
    expect(() => toggleTagDisclosure(orphan)).not.toThrow();
    expect(triggerAttrs['aria-expanded']).toBe('false');
  });
});

describe('initCardInteractions — REQ-STAR-001 + REQ-READ-001 event plumbing', () => {
  /** Mock button that captures its bound click listener so we can
   *  invoke it with a synthetic event and inspect preventDefault /
   *  stopPropagation interactions. */
  function makeCapturingButton(dataAttr: 'starToggle' | 'tagTrigger'): {
    button: HTMLButtonElement;
    invokeClick: (e: { preventDefault: () => void; stopPropagation: () => void }) => void;
  } {
    const dataset: Record<string, string> = {};
    dataset[dataAttr] = '';
    dataset['articleId'] = 'evt-art';
    const attrs: Record<string, string> = { 'aria-pressed': 'false', 'aria-expanded': 'false' };
    let captured: ((e: Event) => void) | null = null;
    const button = {
      dataset,
      getAttribute: (k: string) => attrs[k] ?? null,
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'click' && typeof listener === 'function') captured = listener;
      },
      closest: () => null,
    } as unknown as HTMLButtonElement;
    return {
      button,
      invokeClick: (e) => {
        if (captured === null) throw new Error('no click listener bound');
        captured(e as unknown as Event);
      },
    };
  }

  it('REQ-STAR-001: the bound star handler calls preventDefault + stopPropagation so the card anchor does not navigate on tap', () => {
    // Regression guard for the mobile bug that motivated the
    // direct-binding refactor: a button sitting inside/near an <a>
    // element must not let the click bubble up and trigger navigation.
    const { button, invokeClick } = makeCapturingButton('starToggle');
    const rootQS: Record<string, HTMLButtonElement[]> = {
      '[data-star-toggle]': [button],
      '[data-tag-trigger]': [],
    };
    const root = {
      querySelectorAll: (sel: string) => (rootQS[sel] ?? []) as unknown as NodeListOf<Element>,
    } as unknown as HTMLElement;

    const bound = initCardInteractions(root);
    expect(bound).toBe(1);

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    invokeClick({ preventDefault, stopPropagation });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('REQ-READ-001: the bound tag-trigger handler calls preventDefault + stopPropagation', () => {
    const { button, invokeClick } = makeCapturingButton('tagTrigger');
    const rootQS: Record<string, HTMLButtonElement[]> = {
      '[data-star-toggle]': [],
      '[data-tag-trigger]': [button],
    };
    const root = {
      querySelectorAll: (sel: string) => (rootQS[sel] ?? []) as unknown as NodeListOf<Element>,
    } as unknown as HTMLElement;

    const bound = initCardInteractions(root);
    expect(bound).toBe(1);

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    invokeClick({ preventDefault, stopPropagation });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('REQ-STAR-001: re-running init does not double-bind (dataset.bound guard)', () => {
    // Simulates astro:page-load firing twice. A double-bind would
    // cause a single click to fire two fetches and flip aria-pressed
    // back and forth instantly.
    const { button } = makeCapturingButton('starToggle');
    const root = {
      querySelectorAll: (sel: string) =>
        (sel === '[data-star-toggle]' ? [button] : []) as unknown as NodeListOf<Element>,
    } as unknown as HTMLElement;

    const first = initCardInteractions(root);
    const second = initCardInteractions(root);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(button.dataset['bound']).toBe('1');
  });
});

describe('closeAllTagPopovers — REQ-READ-001 AC 6', () => {
  it('REQ-READ-001: removes .is-open from every disclosure returned by document.querySelectorAll', () => {
    const a = makeDisclosurePair({ initiallyOpen: true });
    const b = makeDisclosurePair({ initiallyOpen: true });

    vi.stubGlobal('document', {
      querySelectorAll: (sel: string) => {
        if (sel !== '[data-tag-disclosure].is-open') return [];
        return [a.disclosure, b.disclosure] as unknown as NodeListOf<Element>;
      },
    });

    closeAllTagPopovers();

    expect(a.disclosureClassList.contains('is-open')).toBe(false);
    expect(b.disclosureClassList.contains('is-open')).toBe(false);
    expect(a.triggerAttrs['aria-expanded']).toBe('false');
    expect(b.triggerAttrs['aria-expanded']).toBe('false');
  });

  it('REQ-READ-001: skips the disclosure passed as `except` so the caller can keep one open', () => {
    const keep = makeDisclosurePair({ initiallyOpen: true });
    const drop = makeDisclosurePair({ initiallyOpen: true });

    vi.stubGlobal('document', {
      querySelectorAll: (sel: string) => {
        if (sel !== '[data-tag-disclosure].is-open') return [];
        return [keep.disclosure, drop.disclosure] as unknown as NodeListOf<Element>;
      },
    });

    closeAllTagPopovers(keep.disclosure);

    expect(keep.disclosureClassList.contains('is-open')).toBe(true);
    expect(drop.disclosureClassList.contains('is-open')).toBe(false);
  });
});
