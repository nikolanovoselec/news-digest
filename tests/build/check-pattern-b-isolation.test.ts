// CF-019 / CF-045 — AD20 dual-bundle idempotency: asserts that two
// artificial module evaluations of card-interactions against a SHARED
// stubbed `window` register exactly ONE star-delegation listener on
// `document.addEventListener`.
//
// Why this test exists:
//   On /history, `card-interactions.ts` is loaded TWICE by the build
//   system (Pattern B — see the module-level comment in the source
//   file):
//     a. As a standalone IIFE bundle shipped via <script src="...">.
//     b. As a page-bundled module statically imported by history.astro.
//   Each evaluation has its own module closure, so a `let bound = false`
//   closure flag cannot prevent duplicate listeners. Only a `window`-
//   scoped token shared between all evaluations solves this.
//
// This test runs in the node pool (NOT the workerd pool) so it can:
//   - Stub `window` and `document` without the Workers runtime
//     restricting DOM APIs.
//   - Re-evaluate the module's side-effecting IIFE twice in one test.
//
// Pool config: declared as `@vitest-environment node` via the inline
// docblock below. The project's vitest config routes all other tests
// through the workerd pool; node-pool tests need the explicit pragma.

// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Create a minimal stub environment that mirrors the browser APIs the
 * module actually calls. Returns { listeners } so the test can assert
 * on how many distinct listener functions were registered.
 */
function makeStubEnv() {
  const listeners: Array<EventListener> = [];

  const document = {
    addEventListener: vi.fn((_type: string, fn: EventListener) => {
      listeners.push(fn);
    }),
    querySelectorAll: vi.fn(() => ({ forEach: vi.fn() })),
  } as unknown as Document;

  // The module checks `typeof window === 'undefined'` and stores its
  // idempotency token on `window.__cardInteractionsBound`.
  const window = {
    __cardInteractionsBound: undefined as Record<string, true> | undefined,
  } as unknown as Window & typeof globalThis;

  return { document, window, listeners };
}

describe('card-interactions Pattern-B isolation (CF-019 / AD20)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('two module evaluations against a shared window register exactly ONE star-delegation listener', async () => {
    const env = makeStubEnv();

    // Inject the stubs into globalThis so the module's bare `window`
    // and `document` references resolve to our stubs.
    const origWindow = (globalThis as unknown as Record<string, unknown>)['window'];
    const origDocument = (globalThis as unknown as Record<string, unknown>)['document'];
    (globalThis as unknown as Record<string, unknown>)['window'] = env.window;
    (globalThis as unknown as Record<string, unknown>)['document'] = env.document;

    try {
      // First evaluation — simulates the standalone IIFE bundle loading.
      const mod1 = await import('../../src/scripts/card-interactions.ts');
      mod1.bindStarDelegation();

      // Second evaluation — simulates the history.astro page-bundled import.
      // Both evaluations share the same `env.window`, so the idempotency
      // token written by the first call is visible to the second.
      vi.resetModules();
      const mod2 = await import('../../src/scripts/card-interactions.ts');
      mod2.bindStarDelegation();

      // Only ONE click listener should have been registered, not two.
      // The listeners array collects everything passed to
      // document.addEventListener; filter to 'click' shape only.
      // Our stub doesn't track the event type, so we count total
      // registrations that came from bindStarDelegation (each call to
      // bindStarDelegation adds at most 1 listener when the flag is not set).
      const starListeners = env.listeners.filter(Boolean);
      expect(starListeners).toHaveLength(1);
    } finally {
      // Restore originals whether the test passed or threw.
      (globalThis as unknown as Record<string, unknown>)['window'] = origWindow;
      (globalThis as unknown as Record<string, unknown>)['document'] = origDocument;
    }
  });

  it('bindStarDelegation is a no-op on the second call when the flag is already set', async () => {
    const env = makeStubEnv();

    const origWindow = (globalThis as unknown as Record<string, unknown>)['window'];
    const origDocument = (globalThis as unknown as Record<string, unknown>)['document'];
    (globalThis as unknown as Record<string, unknown>)['window'] = env.window;
    (globalThis as unknown as Record<string, unknown>)['document'] = env.document;

    try {
      const mod = await import('../../src/scripts/card-interactions.ts');

      // First call registers the listener.
      mod.bindStarDelegation();
      const countAfterFirst = env.listeners.length;
      expect(countAfterFirst).toBe(1);

      // Second call must not register another listener.
      mod.bindStarDelegation();
      expect(env.listeners).toHaveLength(countAfterFirst);
    } finally {
      (globalThis as unknown as Record<string, unknown>)['window'] = origWindow;
      (globalThis as unknown as Record<string, unknown>)['document'] = origDocument;
    }
  });
});
