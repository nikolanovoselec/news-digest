// Helper for emitting safe JSON-LD into a `<script type="application/ld+json">`
// block via Astro's `set:html` directive. Two attack vectors are
// closed defensively:
//
// 1. `</script>` inside a string value would close the script tag
//    early and let any subsequent text run as HTML.
// 2. ` ` / ` ` (line / paragraph separator) terminate
//    JavaScript expressions in older parsers; they're valid inside a
//    JSON string but invalid inside a script body.
//
// Today every JSON-LD block in the codebase uses server-controlled
// constants only, so this function is preventive — it makes the path
// safe by default before someone interpolates a user-controlled string
// (article title, tag, etc.) into the graph.

const SCRIPT_CLOSE = /<\/(script)/gi;
const SEPARATORS = /[  ]/g;

export function safeJsonLd(graph: unknown): string {
  return JSON.stringify(graph)
    .replace(SCRIPT_CLOSE, '<\\/$1')
    .replace(SEPARATORS, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
