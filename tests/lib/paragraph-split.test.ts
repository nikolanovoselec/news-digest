import { describe, it, expect } from 'vitest';

import { splitIntoParagraphs } from '../../src/lib/paragraph-split';

describe('splitIntoParagraphs — REQ-READ-002', () => {
  it('REQ-READ-002: splits real-newline separated prose into paragraphs', () => {
    expect(splitIntoParagraphs('para1.\npara2.\npara3.')).toEqual([
      'para1.',
      'para2.',
      'para3.',
    ]);
  });

  it('REQ-READ-002: collapses runs of real newlines into a single break', () => {
    expect(splitIntoParagraphs('para1.\n\n\npara2.')).toEqual([
      'para1.',
      'para2.',
    ]);
  });

  it('REQ-READ-002: coerces literal backslash-n escape into a paragraph break', () => {
    // This is the bug the user reported — some LLM outputs double-encode
    // their own JSON so the `\n` arrives as two literal characters
    // (backslash + n) rather than a real newline. Must still split.
    const rawWithLiteral = 'para1.\\npara2.\\npara3.';
    expect(splitIntoParagraphs(rawWithLiteral)).toEqual([
      'para1.',
      'para2.',
      'para3.',
    ]);
  });

  it('REQ-READ-002: handles a mix of real and literal separators', () => {
    const mixed = 'para1.\\npara2.\npara3.';
    expect(splitIntoParagraphs(mixed)).toEqual([
      'para1.',
      'para2.',
      'para3.',
    ]);
  });

  it('REQ-READ-002: trims whitespace and drops empty segments', () => {
    expect(splitIntoParagraphs('  a  \n\n   \n b ')).toEqual(['a', 'b']);
  });

  it('REQ-READ-002: returns empty array for an empty string', () => {
    expect(splitIntoParagraphs('')).toEqual([]);
  });

  it('REQ-READ-002: returns a single-element array when no separator is present', () => {
    expect(splitIntoParagraphs('one paragraph only.')).toEqual([
      'one paragraph only.',
    ]);
  });
});
