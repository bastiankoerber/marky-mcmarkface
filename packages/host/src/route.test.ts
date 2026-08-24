import { describe, expect, it } from 'vitest';
import { hashForView, parseHash } from './route.js';

describe('review routes', () => {
  it('round-trips a file deep link without treating slashes or punctuation as route syntax', () => {
    const view = { kind: 'review' as const, owner: 'an org', repo: 'docs', number: 42, file: 'guides/a & b.md' };
    expect(parseHash(hashForView(view))).toEqual(view);
  });

  it('keeps old pull-request-only links working', () => {
    expect(parseHash('#/pr/acme/docs/7')).toEqual({ kind: 'review', owner: 'acme', repo: 'docs', number: 7 });
  });

  it('round-trips branch names and document paths independently', () => {
    const view = {
      kind: 'branch' as const,
      owner: 'acme',
      repo: 'docs',
      branch: 'docs/rewrite',
      file: 'guides/start here.md',
    };
    expect(parseHash(hashForView(view))).toEqual(view);
  });

  it('rejects malformed routes', () => {
    expect(parseHash('#/pr/acme/docs/nope')).toEqual({ kind: 'dashboard' });
    expect(parseHash('#/pr/%E0%A4%A/docs/1')).toEqual({ kind: 'dashboard' });
  });
});
