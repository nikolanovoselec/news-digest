// Tests for src/queue/scrape-coordinator.ts#capChunks — REQ-PIPE-001
// (CF-012 + CF-073). Pins the per-tick chunk cap behaviour: drops the
// excess on a fresh slice, emits exactly one warning log, leaves the
// input array untouched.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { capChunks } from '~/queue/scrape-coordinator';

describe('capChunks — REQ-PIPE-001 (CF-012 + CF-073)', () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('REQ-PIPE-001: under the cap → returns input unchanged, no warning logged', () => {
    const input = Array.from({ length: 12 }, (_, i) => `chunk-${i}`);
    const out = capChunks(input, 40, 'run-under');
    expect(out).toBe(input);
    expect(out).toHaveLength(12);
    const cappedCall = consoleLog.mock.calls.find((args: unknown[]) =>
      typeof args[0] === 'string' && (args[0] as string).includes('coordinator_chunks_capped'),
    );
    expect(cappedCall).toBeUndefined();
  });

  it('REQ-PIPE-001: exactly at the cap → returns input unchanged, no warning logged', () => {
    const input = Array.from({ length: 40 }, (_, i) => `chunk-${i}`);
    const out = capChunks(input, 40, 'run-equal');
    expect(out).toBe(input);
    expect(out).toHaveLength(40);
    const cappedCall = consoleLog.mock.calls.find((args: unknown[]) =>
      typeof args[0] === 'string' && (args[0] as string).includes('coordinator_chunks_capped'),
    );
    expect(cappedCall).toBeUndefined();
  });

  it('REQ-PIPE-001: 41 chunks → returns exactly 40 + emits one coordinator_chunks_capped warning', () => {
    const input = Array.from({ length: 41 }, (_, i) => `chunk-${i}`);
    const out = capChunks(input, 40, 'run-over');
    expect(out).toHaveLength(40);
    // The dropped chunk is the last one ("chunk-40").
    expect(out[39]).toBe('chunk-39');
    // Input array is untouched (immutable contract).
    expect(input).toHaveLength(41);
    // Exactly one structured log line carries `coordinator_chunks_capped`.
    const cappedCalls = consoleLog.mock.calls.filter((args: unknown[]) =>
      typeof args[0] === 'string' && (args[0] as string).includes('coordinator_chunks_capped'),
    );
    expect(cappedCalls).toHaveLength(1);
    const payload = cappedCalls[0]?.[0] as string;
    expect(payload).toContain('"total_chunks":41');
    expect(payload).toContain('"kept_chunks":40');
    expect(payload).toContain('"dropped_chunks":1');
    expect(payload).toContain('"scrape_run_id":"run-over"');
  });

  it('REQ-PIPE-001: heavy overage drops every excess chunk in one slice', () => {
    const input = Array.from({ length: 200 }, (_, i) => i);
    const out = capChunks(input, 40, 'run-heavy');
    expect(out).toHaveLength(40);
    expect(out[39]).toBe(39);
    expect(input).toHaveLength(200);
  });
});
