import { describe, expect, it } from 'vitest';
import { commentRange, leadingQuote } from './commentRange.js';

const source = ['# Title', '', 'The quick brown fox', 'jumps over the dog.', '', 'Last line'].join('\n');

describe('leadingQuote', () => {
  it('extracts the source passage Marky prefixes to a comment', () => {
    expect(leadingQuote('> brown fox\n> jumps\n\nPlease tighten this.')).toBe('brown fox\njumps');
  });

  it('does not mistake an ordinary comment for a source quote', () => {
    expect(leadingQuote('Please tighten this.')).toBeNull();
  });
});

describe('commentRange', () => {
  it('recovers a character-precise selection from a quoted passage', () => {
    const exact = 'quick brown fox';
    expect(commentRange(source, { line: 3, body: `> ${exact}\n\nComment` })).toEqual({
      side: 'RIGHT',
      start: source.indexOf(exact),
      end: source.indexOf(exact) + exact.length,
    });
  });

  it('recovers a quoted selection spanning multiple lines', () => {
    const exact = 'brown fox\njumps over';
    expect(commentRange(source, { startLine: 3, line: 4, body: '> brown fox\n> jumps over\n\nComment' })).toEqual({
      side: 'RIGHT',
      start: source.indexOf(exact),
      end: source.indexOf(exact) + exact.length,
    });
  });

  it('falls back to the complete GitHub line span when there is no quote', () => {
    const exact = 'The quick brown fox\njumps over the dog.';
    expect(commentRange(source, { startLine: 3, line: 4, body: 'Comment from GitHub' })).toEqual({
      side: 'RIGHT',
      start: source.indexOf(exact),
      end: source.indexOf(exact) + exact.length,
    });
  });

  it('keeps the side supplied by GitHub', () => {
    expect(commentRange(source, { line: 6, body: 'Comment', side: 'LEFT' })?.side).toBe('LEFT');
  });
});
