import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from './client.js';
import { fetchRepositoryFile, isRepositoryFilePath } from './repository-file.js';

describe('repository file fallback', () => {
  it('reads an encoded path from the latest default branch', async () => {
    const rest = vi.fn().mockResolvedValueOnce({ default_branch: 'trunk' }).mockResolvedValueOnce('# Hello\n');
    const result = await fetchRepositoryFile({ rest } as unknown as GitHubClient, 'acme', 'docs', 'guides/hello world.md');

    expect(result).toEqual({ path: 'guides/hello world.md', content: '# Hello\n', ref: 'trunk' });
    expect(rest).toHaveBeenNthCalledWith(1, '/repos/acme/docs', { cache: true });
    expect(rest).toHaveBeenNthCalledWith(
      2,
      '/repos/acme/docs/contents/guides/hello%20world.md?ref=trunk',
      { accept: 'application/vnd.github.raw', cache: true },
    );
  });

  it('rejects traversal, directories, and unsupported binary files before calling GitHub', async () => {
    for (const path of ['', '../secret.md', 'docs/../secret.md', '/README.md', 'docs/', 'image.png']) {
      expect(isRepositoryFilePath(path)).toBe(false);
    }
    const rest = vi.fn();
    await expect(fetchRepositoryFile({ rest } as unknown as GitHubClient, 'acme', 'docs', '../secret.md')).resolves.toBeNull();
    expect(rest).not.toHaveBeenCalled();
  });
});
