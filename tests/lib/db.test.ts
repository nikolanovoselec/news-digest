// Unit tests for src/lib/db.ts. The remaining helper after CF-045 is a
// one-liner over D1's native exec; the previous `batch` pass-through
// was deleted in PR3 and call sites now use db.batch() directly.

import { describe, it, expect, vi } from 'vitest';
import { applyForeignKeysPragma } from '../../src/lib/db';

describe('db.ts', () => {
  it('REQ-PIPE-002: applyForeignKeysPragma runs exactly one exec with PRAGMA foreign_keys=ON', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    const fakeDb = { exec } as unknown as D1Database;

    await applyForeignKeysPragma(fakeDb);

    expect(exec).toHaveBeenCalledTimes(1);
    const arg = exec.mock.calls[0]?.[0] as string;
    expect(arg).toMatch(/PRAGMA\s+foreign_keys\s*=\s*ON/i);
  });
});
