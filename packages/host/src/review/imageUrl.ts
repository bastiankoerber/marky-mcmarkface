const GITHUB_IMAGE_HOSTS = new Set(['avatars.githubusercontent.com']);

function isDirectGitHubImage(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (GITHUB_IMAGE_HOSTS.has(url.hostname) ||
        url.hostname.endsWith('.githubusercontent.com') ||
        (url.hostname === 'github.com' && url.pathname.startsWith('/user-attachments/assets/')))
    );
  } catch {
    return false;
  }
}

/**
 * Keep arbitrary remote images blocked: opening a private document must not become a read receipt.
 * Repository-relative images use the opaque localhost capability issued with the PR instead.
 */
export function resolveReviewImageUrl(source: string, documentPath: string, imageBaseUrl?: string): string | null {
  const value = source.trim();
  if (!value) return null;
  if (/^data:image\//i.test(value)) return value;
  if (isDirectGitHubImage(value)) return value;
  if (value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value) || !imageBaseUrl) return null;

  const query = new URLSearchParams({ document: documentPath, source: value });
  return `${imageBaseUrl}?${query}`;
}
