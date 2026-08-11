import { afterEach, describe, expect, it } from 'vitest';
import {
  clearAssetScopes,
  encodedRepositoryPath,
  issueAssetScope,
  readAssetScope,
  repositoryImageMime,
  resolveRepositoryImagePath,
} from './assets.js';

afterEach(() => clearAssetScopes());

describe('repository image paths', () => {
  it.each([
    ['docs/guide/readme.md', 'diagram.png', 'docs/guide/diagram.png'],
    ['docs/guide/readme.md', '../assets/diagram.png', 'docs/assets/diagram.png'],
    ['docs/guide/readme.md', '/assets/diagram.png', 'assets/diagram.png'],
    ['docs/readme.md', 'a%20diagram.png?raw=1#preview', 'docs/a diagram.png'],
  ])('resolves %s + %s inside the repository', (document, source, expected) => {
    expect(resolveRepositoryImagePath(document, source)).toBe(expected);
  });

  it.each([
    ['README.md', '../../../private.png'],
    ['README.md', '/../../private.png'],
    ['README.md', 'https://tracker.example/pixel.png'],
    ['README.md', '//tracker.example/pixel.png'],
    ['../README.md', 'image.png'],
    ['README.md', '%E0%A4%A'],
    ['README.md', ''],
  ])('rejects an unsafe source %s + %s', (document, source) => {
    expect(resolveRepositoryImagePath(document, source)).toBeNull();
  });

  it('encodes each GitHub path segment without changing hierarchy', () => {
    expect(encodedRepositoryPath('docs/a diagram#1.png')).toBe('docs/a%20diagram%231.png');
  });
});

describe('asset capabilities', () => {
  it('are unguessable and bound to the immutable PR head and base commits', () => {
    const scope = { owner: 'octo', repo: 'docs', sha: 'abc123', baseSha: 'base456' };
    const token = issueAssetScope(scope);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(readAssetScope(token)).toEqual(scope);
    expect(readAssetScope('not-a-capability')).toBeNull();
  });

  it('are revoked together when credentials change', () => {
    const token = issueAssetScope({ owner: 'octo', repo: 'docs', sha: 'abc123' });
    clearAssetScopes();
    expect(readAssetScope(token)).toBeNull();
  });
});

describe('repository image signatures', () => {
  const body = (bytes: number[]) => new Uint8Array(bytes).buffer as ArrayBuffer;

  it('recognises supported raster formats independently of response headers', () => {
    expect(repositoryImageMime(body([137, 80, 78, 71, 13, 10, 26, 10]))).toBe('image/png');
    expect(repositoryImageMime(body([0xff, 0xd8, 0xff, 0xdb]))).toBe('image/jpeg');
    expect(repositoryImageMime(new TextEncoder().encode('GIF89a').buffer as ArrayBuffer)).toBe('image/gif');
  });

  it('recognises SVG but rejects HTML and arbitrary repository files', () => {
    expect(repositoryImageMime(new TextEncoder().encode('<svg viewBox="0 0 1 1"></svg>').buffer as ArrayBuffer)).toBe(
      'image/svg+xml',
    );
    expect(repositoryImageMime(new TextEncoder().encode('<html>not an image</html>').buffer as ArrayBuffer)).toBeNull();
    expect(repositoryImageMime(new TextEncoder().encode('secret text').buffer as ArrayBuffer)).toBeNull();
  });
});
