// Trivial test so CI has something to execute during Phase 0 scaffolding.
// Removed in Phase 1 when real foundation-lib tests arrive.
import { describe, it, expect } from 'vitest';

describe('scaffold', () => {
  it('CI pipeline is operational', () => {
    expect(true).toBe(true);
  });
});
