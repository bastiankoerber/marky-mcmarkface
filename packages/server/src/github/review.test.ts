import { describe, expect, it } from 'vitest';
import { renderCommentBody, type PendingComment } from './review.js';

const comment = (suggestion?: string, body = 'Use the shorter wording.'): PendingComment => ({
  path: 'README.md',
  side: 'RIGHT',
  line: 4,
  body,
  ...(suggestion === undefined ? {} : { suggestion }),
});

describe('renderCommentBody', () => {
  it('leaves ordinary comments untouched', () => {
    expect(renderCommentBody(comment())).toBe('Use the shorter wording.');
  });

  it('appends a GitHub suggestion block', () => {
    expect(renderCommentBody(comment('Clearer copy.'))).toBe(
      'Use the shorter wording.\n\n```suggestion\nClearer copy.\n```',
    );
  });

  it('supports a suggestion with no explanation', () => {
    expect(renderCommentBody(comment('', ''))).toBe('```suggestion\n\n```');
  });

  it('uses a longer fence when suggesting Markdown that contains backticks', () => {
    expect(renderCommentBody(comment('```ts\nconst value = 1;\n```'))).toContain(
      '````suggestion\n```ts\nconst value = 1;\n```\n````',
    );
  });
});
