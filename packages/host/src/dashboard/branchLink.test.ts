import { describe, expect, it } from 'vitest';
import { parseBranchReference } from './branchLink.js';

describe('branch link parsing', () => {
  it('accepts an owner/repo@branch reference, including slash branches', () => {
    expect(parseBranchReference('acme/docs@docs/rewrite')).toEqual({
      owner: 'acme',
      repo: 'docs',
      branch: 'docs/rewrite',
    });
  });

  it('accepts a copied GitHub branch URL', () => {
    expect(parseBranchReference('https://github.com/acme/docs/tree/rewrite')).toEqual({
      owner: 'acme',
      repo: 'docs',
      branch: 'rewrite',
    });
  });

  it('does not mistake pull requests or arbitrary hosts for branches', () => {
    expect(parseBranchReference('https://github.com/acme/docs/pull/12')).toBeNull();
    expect(parseBranchReference('https://example.com/acme/docs/tree/rewrite')).toBeNull();
  });
});
