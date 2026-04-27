// Implements REQ-MAIL-001
// Implements REQ-READ-001
// Implements REQ-SET-002
//
// Shared parser for any column that stores `string[]` as a JSON
// array. Returns `[]` when the column is null, empty, malformed JSON,
// not an array, or non-string entries. Defensive by design — every
// caller would otherwise duplicate the same try/catch + Array.isArray
// + filter shape (CF-004 found seven byte-identical copies).

export function parseJsonStringArray(input: string | null | undefined): string[] {
  if (input === null || input === undefined || input === '') return [];
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}
