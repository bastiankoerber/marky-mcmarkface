import { afterEach, describe, expect, it } from 'vitest';
import { GitHubError, type GitHubBinary } from './client.js';
import { clearAssetScopes, issueAssetScope, MAX_REPOSITORY_IMAGE_BYTES } from './assets.js';
import { repositoryImageResponse, type RepositoryImageClient } from './repository-image.js';

afterEach(() => clearAssetScopes());

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer as ArrayBuffer;

function client(result: GitHubBinary | Error | Array<GitHubBinary | Error>, seen: string[] = []): RepositoryImageClient {
  let call = 0;
  return {
    async restBytes(path, maxBytes) {
      seen.push(`${path} ${maxBytes}`);
      const current = Array.isArray(result) ? result[Math.min(call++, result.length - 1)] : result;
      if (!current) throw new Error('Test image client has no configured response.');
      if (current instanceof Error) throw current;
      return current;
    },
  };
}

describe('repository image response', () => {
  it('fetches only from the capability repository and immutable commit', async () => {
    const capability = issueAssetScope({ owner: 'private org', repo: 'handbook', sha: 'abc/123' });
    const seen: string[] = [];
    const response = await repositoryImageResponse(
      client({ body: png, contentType: 'application/octet-stream' }, seen),
      capability,
      'docs/guide/readme.md',
      '../assets/system diagram.png',
    );

    expect(response.status).toBe(200);
    expect(seen).toEqual([
      `/repos/private%20org/handbook/contents/docs/assets/system%20diagram.png?ref=abc%2F123 ${MAX_REPOSITORY_IMAGE_BYTES}`,
    ]);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });

  it('does not contact GitHub for an invalid capability or traversal path', async () => {
    const seen: string[] = [];
    const fake = client({ body: png, contentType: 'image/png' }, seen);
    expect((await repositoryImageResponse(fake, 'wrong', 'README.md', 'image.png')).status).toBe(404);

    const capability = issueAssetScope({ owner: 'octo', repo: 'docs', sha: 'abc' });
    expect((await repositoryImageResponse(fake, capability, 'README.md', '../../../secret.png')).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('falls back to the immutable base commit only when the image is absent from the head', async () => {
    const capability = issueAssetScope({
      owner: 'octo',
      repo: 'docs',
      sha: 'head123',
      baseSha: 'main456',
    });
    const seen: string[] = [];
    const response = await repositoryImageResponse(
      client([new GitHubError(404, 'missing from head'), { body: png, contentType: 'image/png' }], seen),
      capability,
      'docs/readme.md',
      'images/diagram.png',
    );

    expect(response.status).toBe(200);
    expect(seen).toEqual([
      `/repos/octo/docs/contents/docs/images/diagram.png?ref=head123 ${MAX_REPOSITORY_IMAGE_BYTES}`,
      `/repos/octo/docs/contents/docs/images/diagram.png?ref=main456 ${MAX_REPOSITORY_IMAGE_BYTES}`,
    ]);
  });

  it('does not fall back to the base commit for non-missing head failures', async () => {
    const capability = issueAssetScope({ owner: 'octo', repo: 'docs', sha: 'head', baseSha: 'base' });
    const seen: string[] = [];
    const response = await repositoryImageResponse(
      client(new GitHubError(413, 'too large'), seen),
      capability,
      'README.md',
      'huge.png',
    );

    expect(response.status).toBe(413);
    expect(seen).toHaveLength(1);
  });

  it('rejects non-image bytes and maps safe upstream failures without returning their bodies', async () => {
    const capability = issueAssetScope({ owner: 'octo', repo: 'docs', sha: 'abc' });
    const text = new TextEncoder().encode('private text').buffer as ArrayBuffer;
    expect(
      (await repositoryImageResponse(client({ body: text, contentType: 'text/plain' }), capability, 'README.md', 'x.txt'))
        .status,
    ).toBe(415);

    expect(
      (await repositoryImageResponse(client(new GitHubError(413, 'hidden')), capability, 'README.md', 'huge.png')).status,
    ).toBe(413);
    expect(
      (await repositoryImageResponse(client(new Error('hidden')), capability, 'README.md', 'broken.png')).status,
    ).toBe(502);
  });
});
