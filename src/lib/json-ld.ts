// Implements REQ-OPS-004
//
// Helper for emitting safe JSON-LD into a `<script type="application/ld+json">`
// block via Astro's `set:html` directive.
//
// Per-character escape of `<`, `>`, `&` to their `\uNNNN` JSON forms
// covers every HTML state-transition vector that could escape the
// `<script>` block: `</script>` (early-close), `<!--` (script-data
// escaped state), `<![CDATA[` / `]]>` (XML-mode CDATA), `<script` re-
// entry into double-escaped state. The conventional one-liner used by
// Rails / Django / Next.js — strictly safer than a regex against
// known patterns and adds ~3 bytes per occurrence in a JSON-LD block
// that's already tiny.
//
// U+2028 / U+2029 (line/paragraph separators) used to break JS source
// in older parsers, but ES2019 mandated that JSON.stringify escapes
// them. Modern engines (workerd, V8 ≥7.x, JSC, SpiderMonkey) all
// comply, so they no longer need a separate escape pass here.
//
// Today every JSON-LD block in the codebase uses server-controlled
// constants only, so this function is preventive — it makes the path
// safe by default before someone interpolates a user-controlled string
// (article title, tag, etc.) into the graph.

export function safeJsonLd(graph: unknown): string {
  return JSON.stringify(graph)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}
