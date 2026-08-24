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

  it('opens a copied GitHub document URL at its branch and path', () => {
    expect(
      parseBranchReference(
        'https://github.com/camunda/bai-solutions-internal/blob/main/issues/bai-102-process-os-8-10-release/process-os-8-10-release-scope.md',
      ),
    ).toEqual({
      owner: 'camunda',
      repo: 'bai-solutions-internal',
      branch: 'main',
      file: 'issues/bai-102-process-os-8-10-release/process-os-8-10-release-scope.md',
    });
  });

  it('does not mistake pull requests or arbitrary hosts for branches', () => {
    expect(parseBranchReference('https://github.com/acme/docs/pull/12')).toBeNull();
    expect(parseBranchReference('https://github.com/acme/docs/blob/main')).toBeNull();
    expect(parseBranchReference('https://example.com/acme/docs/tree/rewrite')).toBeNull();
  });
});
