// Helper for emitting safe JSON-LD into a `<script type="application/ld+json">`
// block via Astro's `set:html` directive.
//
// Closes the `</script>` early-close vector: a future caller-supplied
// string containing the literal sequence `</script>` would otherwise
// terminate the script tag and let subsequent text run as HTML. We
// rewrite `</` to `<\/` defensively — JSON.stringify does not do this
// itself.
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

const SCRIPT_CLOSE = /<\/(script)/gi;

export function safeJsonLd(graph: unknown): string {
  return JSON.stringify(graph).replace(SCRIPT_CLOSE, '<\\/$1');
}
