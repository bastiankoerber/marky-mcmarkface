import { GitHubError, type GitHubClient } from './client.js';

export interface RepositoryFile {
  path: string;
  content: string;
  ref: string;
}

const MAX_BLOB = 1_000_000;
const TEXT_RE = /\.(mdx?|txt|ya?ml|json|toml|ts|tsx|js|jsx|css|html|sh|py|go|java|rs|sql)$/i;

export function isRepositoryFilePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || !TEXT_RE.test(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Load an unchanged file from the repository's current default branch. */
export async function fetchRepositoryFile(
  gh: GitHubClient,
  owner: string,
  repo: string,
  path: string,
): Promise<RepositoryFile | null> {
  if (!isRepositoryFilePath(path)) return null;

  const repository = await gh.rest<{ default_branch: string }>(`/repos/${owner}/${repo}`, { cache: true });
  const ref = repository.default_branch;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  try {
    // The branch can move, so conditional caching revalidates its ETag instead of assuming the
    // response is immutable like the SHA-addressed PR blobs.
    const content = await gh.rest<string>(
      `/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
      { accept: 'application/vnd.github.raw', cache: true },
    );
    if (content.length > MAX_BLOB) return null;
    return { path, content, ref };
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;
    throw error;
  }
}
