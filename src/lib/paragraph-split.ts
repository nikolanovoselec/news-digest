// Implements REQ-READ-002
//
// Normalize a string of LLM-produced prose into an array of paragraphs.
//
// The chunk consumer asks the model to separate paragraphs with a real
// newline. Most model responses obey. A non-trivial minority escape the
// separator as the two-character sequence `\n` (backslash + the letter
// n) — typically when the model double-encodes its own JSON. Both forms
// must collapse to the same array so the detail page always renders
// separate <p> elements. Also coerces a single-element array that
// contains embedded paragraph breaks into the multi-element form.

export function splitIntoParagraphs(raw: string): string[] {
  return raw
    .replace(/\\n/g, '\n')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}
