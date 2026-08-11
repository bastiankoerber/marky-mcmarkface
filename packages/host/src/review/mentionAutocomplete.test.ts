import { describe, expect, it } from 'vitest';
import { completeMention, mentionQueryAt } from './mentionAutocomplete.js';

describe('mentionQueryAt', () => {
  it('finds a Copilot prefix at the caret', () => {
    expect(mentionQueryAt('Could you @cop', 14)).toEqual({ start: 10, end: 14, query: 'cop' });
  });

  it('offers completion immediately after @', () => {
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, end: 1, query: '' });
  });

  it('does not treat an email address as a mention', () => {
    expect(mentionQueryAt('send to dev@example', 19)).toBeNull();
  });

  it('includes the rest of an existing username in the replacement range', () => {
    expect(mentionQueryAt('Ask @copliot to fix this', 8)).toEqual({ start: 4, end: 12, query: 'cop' });
  });
});

describe('completeMention', () => {
  it('replaces the prefix and leaves the caret after a trailing space', () => {
    expect(completeMention('Could you @cop', { start: 10, end: 14 }, 'copilot')).toEqual({
      value: 'Could you @copilot ',
      caret: 19,
    });
  });

  it('does not add a space before punctuation', () => {
    expect(completeMention('Thanks @cop, please continue', { start: 7, end: 11 }, 'copilot')).toEqual({
      value: 'Thanks @copilot, please continue',
      caret: 15,
    });
  });
});
