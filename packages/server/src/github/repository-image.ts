import { GitHubError, type GitHubBinary } from './client.js';
import {
  MAX_REPOSITORY_IMAGE_BYTES,
  encodedRepositoryPath,
  readAssetScope,
  repositoryImageMime,
  resolveRepositoryImagePath,
} from './assets.js';

export interface RepositoryImageClient {
  restBytes(path: string, maxBytes: number): Promise<GitHubBinary>;
}

const empty = (status: number) => new Response(null, { status });

export async function repositoryImageResponse(
  client: RepositoryImageClient,
  capability: string,
  document: string,
  source: string,
): Promise<Response> {
  const scope = readAssetScope(capability);
  if (!scope) return empty(404);

  const path = resolveRepositoryImagePath(document, source);
  if (!path) return empty(400);

  try {
    const encoded = encodedRepositoryPath(path);
    const assetAt = (ref: string) =>
      client.restBytes(
        `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
        MAX_REPOSITORY_IMAGE_BYTES,
      );

    let asset: GitHubBinary;
    try {
      asset = await assetAt(scope.sha);
    } catch (err) {
      // A PR branch can be behind its base branch. Preserve head-first rendering, but let a
      // relative image added to main since the branch diverged remain visible in the document.
      if (!(err instanceof GitHubError && err.status === 404 && scope.baseSha && scope.baseSha !== scope.sha)) {
        throw err;
      }
      asset = await assetAt(scope.baseSha);
    }
    const contentType = repositoryImageMime(asset.body);
    if (!contentType) return empty(415);

    return new Response(asset.body, {
      status: 200,
      headers: {
        // The image may come from a private repository. Keep it out of Chromium's persistent
        // cache; the capability is intentionally useful only to this live review session.
        'Cache-Control': 'private, no-store',
        'Content-Length': String(asset.body.byteLength),
        'Content-Type': contentType,
        // A repository SVG may contain its own links and resource references. It remains useful
        // as an image, but this response is a sandbox with no network or script authority.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    if (err instanceof GitHubError && err.status === 413) return empty(413);
    if (err instanceof GitHubError && err.status === 404) return empty(404);
    return empty(502);
  }
}
