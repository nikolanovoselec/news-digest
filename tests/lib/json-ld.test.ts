// Tests for src/lib/json-ld.ts (REQ-OPS-004) — pin the per-character
// `<>&` → `\uNNNN` escape so a future regex narrowing doesn't silently
// regress the script-tag-break defence.

import { describe, it, expect } from 'vitest';
import { safeJsonLd } from '~/lib/json-ld';

describe('safeJsonLd', () => {
  it('REQ-OPS-004: simple values with no <>& produce byte-equivalent output', () => {
    const graph = { '@type': 'WebSite', name: 'News Digest' };
    expect(safeJsonLd(graph)).toBe(JSON.stringify(graph));
  });

  it('REQ-OPS-004: escapes < > & to \\u003c \\u003e \\u0026', () => {
    const out = safeJsonLd({ a: '<', b: '>', c: '&' });
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain('&');
    expect(out).toContain('\\u003c');
    expect(out).toContain('\\u003e');
    expect(out).toContain('\\u0026');
  });

  it('REQ-OPS-004: closes the </script> early-close vector', () => {
    const out = safeJsonLd({ description: 'foo </script> bar' });
    expect(out).not.toMatch(/<\/script>/);
  });

  it('REQ-OPS-004: closes the <!-- script-data-escaped vector', () => {
    const out = safeJsonLd({ description: 'foo <!-- bar' });
    expect(out).not.toContain('<!--');
  });

  it('REQ-OPS-004: closes the ]]> CDATA vector', () => {
    const out = safeJsonLd({ description: 'foo ]]> bar' });
    expect(out).not.toContain(']]>');
  });
});
