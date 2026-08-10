import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubClient, GitHubError, githubGraphqlErrorMessage, githubRejectionMessage } from './client.js';

afterEach(() => vi.unstubAllGlobals());

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

describe('GitHubClient.restBytes', () => {
  it('keeps the token on api.github.com and returns binary bytes', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'application/octet-stream' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GitHubClient('test-token').restBytes('/repos/octo/docs/contents/image.png', 10);
    expect(new Uint8Array(result.body)).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/octo/docs/contents/image.png');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });

  it('rejects a reported body larger than the caller permits before reading it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'Content-Length': '11' } })));
    const error = await new GitHubClient('test-token').restBytes('/asset', 10).catch((caught) => caught);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(413);
  });

  it('stops an unreported streaming body as soon as it crosses the limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(11))));
    const error = await new GitHubClient('test-token').restBytes('/asset', 10).catch((caught) => caught);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(413);
  });
});
