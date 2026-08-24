import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from './client.js';
import { renderCommentBody, submitReview, type PendingComment } from './review.js';

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

  it('posts file-only feedback without first creating an empty review', async () => {
    const write = vi.fn().mockResolvedValue({ html_url: 'https://github.com/acme/docs/pull/2#comment' });
    const result = await submitReview({ write } as unknown as GitHubClient, 'acme', 'docs', 2, {
      event: 'COMMENT',
      body: '',
      commitId: 'abc',
      comments: [{ ...comment(), subjectType: 'file' }],
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('POST', '/repos/acme/docs/pulls/2/comments', expect.objectContaining({
      subject_type: 'file',
    }));
    expect(result).toMatchObject({ id: 0, fileCommentsPosted: 1 });
  });
});
