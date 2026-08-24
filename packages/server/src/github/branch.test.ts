import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from './client.js';
import { BranchReviewError, createBranchPullRequest, fetchBranch, isBranchName } from './branch.js';

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
});
