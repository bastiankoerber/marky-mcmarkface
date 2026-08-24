import { describe, expect, it } from 'vitest';
import { suggestionForLines } from './suggestion.js';

describe('suggestionForLines', () => {
  const source = ['# Heading', '', 'A **bold** sentence.', 'Another line.', 'Last line'].join('\n');

  it('returns the complete source line for a selection inside rendered prose', () => {
    expect(suggestionForLines(source, 3, 3)).toBe('A **bold** sentence.');
  });

  it('returns a multi-line replacement without adding a trailing newline', () => {
    expect(suggestionForLines(source, 3, 4)).toBe('A **bold** sentence.\nAnother line.');
  });

  it('handles the final line and normalizes a reversed range', () => {
    expect(suggestionForLines(source, 5, 4)).toBe('Last line');
  });
});
