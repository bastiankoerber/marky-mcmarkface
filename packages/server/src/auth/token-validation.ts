/** A user-safe authentication error. Never include the token or GitHub's response body. */
export class TokenValidationError extends Error {
  constructor(
    readonly status: 400 | 502,
    message: string,
  ) {
    super(message);
  }
}

function requiresSso(headers: Headers): boolean {
  return headers.get('x-github-sso')?.toLowerCase().includes('required') ?? false;
}

function rateLimited(status: number, headers: Headers): boolean {
  return (
    status === 429 ||
    headers.has('retry-after') ||
    (status === 403 && headers.get('x-ratelimit-remaining') === '0')
  );
}

/** Explain only facts represented by status/headers, which cannot echo credential material. */
export function tokenRejection(status: number, headers: Headers): TokenValidationError {
  if (status === 401) {
    return new TokenValidationError(
      400,
      'GitHub rejected this token. Check that it was copied completely and is not expired or revoked.',
    );
  }
  if (status === 403 && requiresSso(headers)) {
    return new TokenValidationError(
      400,
      'GitHub requires SAML SSO authorization for this token. Authorize it for your organisation in GitHub, then try again.',
    );
  }
  if (rateLimited(status, headers)) {
    return new TokenValidationError(502, 'GitHub could not validate the token because its API rate limit is exhausted.');
  }
  if (status === 403) {
    return new TokenValidationError(
      400,
      'GitHub blocked this token. Your organisation may require approval, SAML SSO authorization, or different repository permissions.',
    );
  }
  return new TokenValidationError(502, `GitHub could not validate this token (${status}). Try again later.`);
}
