// Tests for src/lib/json-ld.ts (REQ-OPS-004) — pin the </script>
// early-close defence so a future regex narrowing doesn't silently
// regress it.
//
// U+2028 / U+2029 escaping: per ES2019 spec, JSON.stringify must
// escape those code points. We deliberately do NOT pin that behaviour
// here — the workerd runtime that vitest-pool-workers exposes returns
// them un-escaped on the current pinned version, and the ES2019
// guarantee is the one we rely on (with the </script> guard providing
// the actual XSS defence). Pinning a runtime bug as a regression guard
// would just be brittle.

import { describe, it, expect } from 'vitest';
import { safeJsonLd } from '~/lib/json-ld';

describe('safeJsonLd', () => {
  it('REQ-OPS-004: byte-equivalent to JSON.stringify for simple values', () => {
    const graph = { '@type': 'WebSite', name: 'News Digest' };
    expect(safeJsonLd(graph)).toBe(JSON.stringify(graph));
  });

  it('REQ-OPS-004: escapes lowercase </script> sequences', () => {
    const out = safeJsonLd({ description: 'foo </script> bar' });
    expect(out).not.toMatch(/<\/script>/);
    expect(out).toMatch(/<\\\/script>/);
  });

  it('REQ-OPS-004: escapes uppercase </SCRIPT> sequences (case-insensitive)', () => {
    const out = safeJsonLd({ description: 'foo </SCRIPT> bar' });
    expect(out).not.toMatch(/<\/SCRIPT>/);
    expect(out).toMatch(/<\\\/SCRIPT>/);
  });
});
