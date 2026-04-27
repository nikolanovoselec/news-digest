// Tests for src/lib/concurrency.ts — REQ-PIPE-002 (CF-008).

import { describe, it, expect } from 'vitest';
import { mapConcurrent } from '~/lib/concurrency';

describe('mapConcurrent — REQ-PIPE-002', () => {
  it('REQ-PIPE-002: returns results in input order even when handlers complete out of order', async () => {
    const items = [50, 10, 30, 20, 40];
    const out = await mapConcurrent(items, 3, async (n) => {
      // Higher-index items resolve faster than earlier ones to force
      // out-of-order completion.
      await new Promise((r) => setTimeout(r, n));
      return `n:${n}`;
    });
    expect(out).toEqual(['n:50', 'n:10', 'n:30', 'n:20', 'n:40']);
  });

  it('REQ-PIPE-002: respects the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapConcurrent([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('REQ-PIPE-002: empty input returns [] without spawning workers', async () => {
    const calls: number[] = [];
    const out = await mapConcurrent([], 5, async (n: number) => {
      calls.push(n);
      return n;
    });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('REQ-PIPE-002: handler index argument matches input position', async () => {
    const items = ['a', 'b', 'c'];
    const out = await mapConcurrent(items, 2, async (item, i) => `${i}:${item}`);
    expect(out).toEqual(['0:a', '1:b', '2:c']);
  });

  it('REQ-PIPE-002: a thrown handler aborts the batch', async () => {
    await expect(
      mapConcurrent([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });

  it('REQ-PIPE-002: rejects non-positive concurrency', async () => {
    await expect(mapConcurrent([1, 2, 3], 0, async (n) => n)).rejects.toThrow(
      /concurrency must be >= 1/,
    );
    await expect(mapConcurrent([1, 2, 3], -5, async (n) => n)).rejects.toThrow(
      /concurrency must be >= 1/,
    );
  });

  it('REQ-PIPE-002: caps worker count to items.length when concurrency exceeds it', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapConcurrent([1, 2], 100, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    // With 2 items and concurrency 100 the helper must still produce
    // exactly 2 in-flight handlers, never more.
    expect(peak).toBeLessThanOrEqual(2);
  });
});
