import { describe, expect, it } from 'vitest';
import { resolveRepositoryLink } from './repositoryLink.js';

describe('resolveRepositoryLink', () => {
  it('resolves sibling, parent, and root-relative repository paths', () => {
    expect(resolveRepositoryLink('setup.md', 'docs/index.md')).toEqual({ path: 'docs/setup.md', fragment: null });
    expect(resolveRepositoryLink('../README.md#usage', 'docs/index.md')).toEqual({ path: 'README.md', fragment: 'usage' });
    expect(resolveRepositoryLink('/CONTRIBUTING.md', 'docs/index.md')).toEqual({ path: 'CONTRIBUTING.md', fragment: null });
  });

  it('decodes paths while dropping query strings used by static-site links', () => {
    expect(resolveRepositoryLink('./hello%20world.md?plain=1', 'docs/index.md')).toEqual({
      path: 'docs/hello world.md',
      fragment: null,
    });
  });

  it('leaves external, in-document, directory, and malformed links to the browser', () => {
    for (const href of ['https://example.com/x', 'mailto:a@example.com', '//example.com/x', '#heading', '../', '%E0%A4%A']) {
      expect(resolveRepositoryLink(href, 'docs/index.md')).toBeNull();
    }
  });
});
