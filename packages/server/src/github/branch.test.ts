import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from './client.js';
import { applyDocumentSuggestions, BranchReviewError, createBranchPullRequest, fetchBranch, isBranchName } from './branch.js';

describe('branch review', () => {
  it('validates supported Git ref names', () => {
    expect(isBranchName('docs/rewrite')).toBe(true);
    for (const branch of ['', '/main', 'main/', 'docs..rewrite', 'docs\\rewrite', 'topic.lock', 'bad~name']) {
      expect(isBranchName(branch)).toBe(false);
    }
  });

  it('loads a branch comparison without creating a pull request', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path === '/repos/acme/docs') return { default_branch: 'main', html_url: 'https://github.com/acme/docs' };
      if (path === '/user') return { login: 'reader' };
      if (path === '/repos/acme/docs/git/ref/heads/docs/rewrite') return { object: { sha: 'head123' } };
      if (path.startsWith('/repos/acme/docs/compare/')) {
        return {
          status: 'ahead',
          ahead_by: 1,
          base_commit: { sha: 'base123' },
          files: [{ filename: 'README.md', status: 'added', additions: 1, deletions: 0, changes: 1, patch: '@@ -0,0 +1 @@\n+# Hello' }],
        };
      }
      if (path === '/repos/acme/docs/contents/README.md?ref=head123') return '# Hello\n';
      throw new Error(`Unexpected request: ${path}`);
    });
    const write = vi.fn();

    const detail = await fetchBranch({ rest, write } as unknown as GitHubClient, 'acme', 'docs', 'docs/rewrite');

    expect(detail).toMatchObject({ number: 0, branchReview: true, baseRef: 'main', headRef: 'docs/rewrite' });
    expect(detail.files[0]?.head).toBe('# Hello\n');
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects a fully merged branch instead of opening a blank review', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path === '/repos/acme/docs') return { default_branch: 'main', html_url: 'https://github.com/acme/docs' };
      if (path === '/user') return { login: 'reader' };
      if (path.includes('/git/ref/heads/')) return { object: { sha: 'old-head' } };
      return { status: 'behind', ahead_by: 0, base_commit: { sha: 'base123' }, files: [] };
    });

    await expect(fetchBranch({ rest } as unknown as GitHubClient, 'acme', 'docs', 'merged')).rejects.toThrow(
      'Branch merged has no changes from main.',
    );
  });

  it('opens one unchanged document from a pasted blob URL without requiring a branch diff', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path === '/repos/acme/docs') return { default_branch: 'main', html_url: 'https://github.com/acme/docs' };
      if (path === '/user') return { login: 'reader' };
      if (path === '/repos/acme/docs/git/ref/heads/main') return { object: { sha: 'head123' } };
      if (path === '/repos/acme/docs/contents/guides/start.md?ref=main') return '# Start\n\nRead this.\n';
      throw new Error(`Unexpected request: ${path}`);
    });

    const detail = await fetchBranch({ rest } as unknown as GitHubClient, 'acme', 'docs', 'main', 'guides/start.md');

    expect(detail).toMatchObject({
      state: 'document',
      baseRef: 'main',
      headSha: 'head123',
      documentReview: { path: 'guides/start.md' },
    });
    expect(detail.files[0]).toMatchObject({ path: 'guides/start.md', base: '# Start\n\nRead this.\n' });
    expect(detail.files[0]?.patch.rightLines).toEqual([[1, 4]]);
    expect(rest.mock.calls.some(([path]) => String(path).includes('/compare/'))).toBe(false);
  });

  it('applies multiple whole-line document suggestions without moving earlier ranges', () => {
    const source = ['# Title', '', 'First paragraph.', 'Second paragraph.', 'End.'].join('\n');
    expect(
      applyDocumentSuggestions(source, [
        { path: 'README.md', side: 'RIGHT', line: 3, body: '', suggestion: 'Clear first paragraph.' },
        { path: 'README.md', side: 'RIGHT', line: 5, body: '', suggestion: 'The end.' },
      ]),
    ).toBe(['# Title', '', 'Clear first paragraph.', 'Second paragraph.', 'The end.'].join('\n'));
  });

  it('refuses overlapping document suggestions', () => {
    expect(() =>
      applyDocumentSuggestions('one\ntwo\nthree', [
        { path: 'README.md', side: 'RIGHT', startLine: 1, line: 2, body: '', suggestion: 'first' },
        { path: 'README.md', side: 'RIGHT', startLine: 2, line: 3, body: '', suggestion: 'second' },
      ]),
    ).toThrow('Suggested edits overlap.');
  });

  it('creates the pull request only after rechecking the reviewed commit', async () => {
    const rest = vi.fn()
      .mockResolvedValueOnce({ default_branch: 'main' })
      .mockResolvedValueOnce({ object: { sha: 'head123' } });
    const write = vi.fn().mockResolvedValueOnce({
      number: 14,
      html_url: 'https://github.com/acme/docs/pull/14',
      head: { sha: 'head123' },
    });
    const result = await createBranchPullRequest(
      { rest, write } as unknown as GitHubClient,
      'acme',
      'docs',
      { branch: 'rewrite', expectedHeadSha: 'head123', title: ' Clearer docs ', body: ' Context ', comments: [] },
    );

    expect(write).toHaveBeenCalledWith('POST', '/repos/acme/docs/pulls', {
      title: 'Clearer docs',
      head: 'rewrite',
      base: 'main',
      body: 'Context',
    });
    expect(result).toEqual({
      number: 14,
      url: 'https://github.com/acme/docs/pull/14',
      reviewUrl: null,
      reviewError: null,
    });
  });

  it('does not create a pull request when the branch moved after review', async () => {
    const rest = vi.fn()
      .mockResolvedValueOnce({ default_branch: 'main' })
      .mockResolvedValueOnce({ object: { sha: 'new-head' } });
    const write = vi.fn();

    await expect(
      createBranchPullRequest(
        { rest, write } as unknown as GitHubClient,
        'acme',
        'docs',
        { branch: 'rewrite', expectedHeadSha: 'old-head', title: 'Docs', body: '', comments: [] },
      ),
    ).rejects.toBeInstanceOf(BranchReviewError);
    expect(write).not.toHaveBeenCalled();
  });

  it('commits document suggestions to a new branch before creating the pull request', async () => {
    const rest = vi.fn(async (path: string) => {
      if (path.endsWith('/git/ref/heads/main')) return { object: { sha: 'head123' } };
      if (path.endsWith('/contents/guides/start.md?ref=main')) return '# Start\nOld copy.\n';
      if (path.endsWith('/git/commits/head123')) return { tree: { sha: 'base-tree' } };
      throw new Error(`Unexpected request: ${path}`);
    });
    const write = vi.fn(async (_method: string, path: string, body: any) => {
      if (path.endsWith('/git/blobs')) {
        expect(body.content).toBe('# Start\nNew copy.\n');
        return { sha: 'new-blob' };
      }
      if (path.endsWith('/git/trees')) return { sha: 'new-tree' };
      if (path.endsWith('/git/commits')) return { sha: 'new-commit' };
      if (path.endsWith('/git/refs')) return {};
      if (path.endsWith('/pulls')) return { number: 17, html_url: 'https://github.com/acme/docs/pull/17' };
      if (path.endsWith('/pulls/17/comments')) return { html_url: 'https://github.com/acme/docs/pull/17#comment' };
      throw new Error(`Unexpected write: ${path}`);
    });

    const result = await createBranchPullRequest(
      { rest, write } as unknown as GitHubClient,
      'acme',
      'docs',
      {
        branch: 'main',
        documentPath: 'guides/start.md',
        expectedHeadSha: 'head123',
        title: 'Improve start guide',
        body: 'Clearer copy.',
        comments: [
          { path: 'guides/start.md', side: 'RIGHT', line: 2, body: '> Old copy.', suggestion: 'New copy.' },
        ],
      },
    );

    const refWrite = write.mock.calls.find(([, path]) => String(path).endsWith('/git/refs'));
    expect(refWrite?.[2]).toMatchObject({ ref: expect.stringMatching(/^refs\/heads\/marky\/start-/), sha: 'new-commit' });
    const prWrite = write.mock.calls.find(([, path]) => String(path).endsWith('/pulls'));
    expect(prWrite?.[2]).toMatchObject({ base: 'main', title: 'Improve start guide' });
    expect(result).toMatchObject({ number: 17, url: 'https://github.com/acme/docs/pull/17', reviewError: null });
  });
});
