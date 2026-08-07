import { describe, expect, it } from 'vitest';
import { tokenRejection } from './token-validation.js';

describe('tokenRejection', () => {
  it('explains invalid or expired tokens without echoing a response body', () => {
    const error = tokenRejection(401, new Headers());
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/expired or revoked/);
  });

  it('distinguishes SAML SSO authorization from a rate limit', () => {
    const error = tokenRejection(403, new Headers({ 'X-GitHub-SSO': 'required; url=https://example.invalid' }));
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/SAML SSO authorization/);
    expect(error.message).not.toContain('example.invalid');
  });

  it('recognizes an exhausted GitHub rate limit', () => {
    const error = tokenRejection(403, new Headers({ 'X-RateLimit-Remaining': '0' }));
    expect(error.status).toBe(502);
    expect(error.message).toMatch(/rate limit/);
  });

  it('points a generic company-policy denial toward approval, SSO, or permissions', () => {
    expect(tokenRejection(403, new Headers()).message).toMatch(/approval.*SAML SSO.*permissions/);
  });
});
