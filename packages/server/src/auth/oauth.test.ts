import { describe, it, expect, beforeEach } from 'vitest';
import { createVerifier, challengeFor, createState, statesMatch, beginFlow, takeFlow, clearFlow } from './oauth.js';

/**
 * PKCE is the part of sign-in that has no visible failure mode: get the challenge wrong and
 * GitHub simply refuses the exchange with a generic error. These pin it against the RFC.
 */

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B test vector', () => {
    // The one published verifier/challenge pair. If this breaks, the S256 encoding is wrong.
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('generates verifiers inside the RFC length window, from the unreserved set', () => {
    for (let i = 0; i < 50; i++) {
      const verifier = createVerifier();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
      // base64url only: no +, /, or = padding, which GitHub would reject.
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    }
  });

  it('produces a distinct verifier every time', () => {
    const seen = new Set(Array.from({ length: 100 }, () => createVerifier()));
    expect(seen.size).toBe(100);
  });

  it('produces challenges with no base64 padding', () => {
    expect(challengeFor(createVerifier())).toMatch(/^[A-Za-z0-9\-_]{43}$/);
  });
});

describe('state', () => {
  it('compares equal states', () => {
    const state = createState();
    expect(statesMatch(state, state)).toBe(true);
  });

  it('rejects a different state, and a different-length one without throwing', () => {
    expect(statesMatch(createState(), createState())).toBe(false);
    expect(statesMatch('short', createState())).toBe(false);
    expect(statesMatch('', '')).toBe(true);
  });
});

describe('flow lifecycle', () => {
  const REDIRECT = 'http://127.0.0.1:7423/gh/callback';

  beforeEach(() => {
    clearFlow();
    process.env.MARKY_MCMARKFACE_GITHUB_CLIENT_ID = 'test-client-id';
    process.env.MARKY_MCMARKFACE_GITHUB_CLIENT_SECRET = 'test-client-secret';
  });

  it('builds an authorize URL with every parameter GitHub requires', () => {
    const started = beginFlow(REDIRECT)!;
    expect(started).not.toBeNull();
    const url = new URL(started.url);

    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')).toBe('repo read:org');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // The challenge on the wire must correspond to the verifier we kept.
    expect(url.searchParams.get('code_challenge')).toBe(challengeFor(started.flow.verifier));
    expect(url.searchParams.get('state')).toBe(started.flow.state);
  });

  it('never leaks the verifier or the client secret into the URL', () => {
    const started = beginFlow(REDIRECT)!;
    expect(started.url).not.toContain(started.flow.verifier);
    expect(started.url).not.toContain('test-client-secret');
  });

  it('returns the flow for a matching state', () => {
    const started = beginFlow(REDIRECT)!;
    expect(takeFlow(started.flow.state)?.verifier).toBe(started.flow.verifier);
  });

  it('rejects a mismatched state — this is the CSRF check', () => {
    beginFlow(REDIRECT);
    expect(takeFlow('not-the-state')).toBeNull();
  });

  it('is single use, so a replayed callback cannot reuse the verifier', () => {
    const started = beginFlow(REDIRECT)!;
    expect(takeFlow(started.flow.state)).not.toBeNull();
    expect(takeFlow(started.flow.state)).toBeNull();
  });

  it('starting a second flow abandons the first', () => {
    const first = beginFlow(REDIRECT)!;
    beginFlow(REDIRECT);
    expect(takeFlow(first.flow.state)).toBeNull();
  });

  it('returns null when no credentials are configured, rather than a broken URL', () => {
    delete process.env.MARKY_MCMARKFACE_GITHUB_CLIENT_ID;
    delete process.env.MARKY_MCMARKFACE_GITHUB_CLIENT_SECRET;
    expect(beginFlow(REDIRECT)).toBeNull();
  });
});
