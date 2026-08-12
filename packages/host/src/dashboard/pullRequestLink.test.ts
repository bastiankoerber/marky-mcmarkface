import { describe, expect, it } from 'vitest';
import { parsePullRequestReference } from './pullRequestLink.js';

describe('pull request link parsing', () => {
  it('opens a copied GitHub pull request URL', () => {
    expect(parsePullRequestReference('https://github.com/acme/docs/pull/42')).toEqual({
      owner: 'acme',
      repo: 'docs',
      number: 42,
    });
  });

  it('finds a pull request URL inside a Slack message', () => {
    expect(
      parsePullRequestReference('Could you review <https://github.com/acme/docs-site/pull/91/files|this PR> today?'),
    ).toEqual({ owner: 'acme', repo: 'docs-site', number: 91 });
  });

  it('accepts compact owner/repo#number shorthand', () => {
    expect(parsePullRequestReference(' acme/docs # 7 ')).toEqual({ owner: 'acme', repo: 'docs', number: 7 });
  });

  it('rejects non-PR and non-GitHub links', () => {
    expect(parsePullRequestReference('https://github.com/acme/docs/issues/42')).toBeNull();
    expect(parsePullRequestReference('https://gitlab.com/acme/docs/pull/42')).toBeNull();
    expect(parsePullRequestReference('https://github.com/acme/docs/pull/42-not-a-number')).toBeNull();
    expect(parsePullRequestReference('acme/docs#0')).toBeNull();
  });
});
