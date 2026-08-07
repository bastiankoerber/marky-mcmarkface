import { describe, expect, it } from 'vitest';
import { githubGraphqlErrorMessage, githubRejectionMessage } from './client.js';

describe('githubRejectionMessage', () => {
  it('does not mislabel an organisation policy denial as a rate limit', () => {
    const message = githubRejectionMessage(new Response(null, { status: 403 }));
    expect(message).toMatch(/organisation.*approval.*SAML SSO.*permissions/);
    expect(message).not.toMatch(/rate limit/);
  });

  it('recognizes SAML SSO from GitHub headers without exposing its URL', () => {
    const message = githubRejectionMessage(
      new Response(null, {
        status: 403,
        headers: { 'X-GitHub-SSO': 'required; url=https://example.invalid/private' },
      }),
    );
    expect(message).toMatch(/SAML SSO authorization/);
    expect(message).not.toContain('example.invalid');
  });

  it('recognizes actual rate limiting separately', () => {
    const message = githubRejectionMessage(
      new Response(null, { status: 403, headers: { 'X-RateLimit-Remaining': '0' } }),
    );
    expect(message).toMatch(/rate limit/);
  });
});

describe('githubGraphqlErrorMessage', () => {
  it('turns forbidden GraphQL errors into company-access guidance', () => {
    expect(githubGraphqlErrorMessage([{ type: 'FORBIDDEN', message: 'hidden upstream detail' }])).toMatch(
      /organisation.*approval.*SAML SSO.*permissions/,
    );
  });

  it('does not relay arbitrary upstream text', () => {
    expect(githubGraphqlErrorMessage([{ message: 'sensitive upstream detail' }])).toBe(
      'GitHub could not load pull-request data.',
    );
  });
});
