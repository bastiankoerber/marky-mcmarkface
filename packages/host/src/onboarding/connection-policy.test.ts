import { describe, expect, it } from 'vitest';
import { preferredConnection } from './connection-policy.js';

const status = (overrides: {
  oauthConfigured?: boolean;
  deviceFlowConfigured?: boolean;
  available?: boolean;
  loggedIn?: boolean;
}) => ({
  oauthConfigured: overrides.oauthConfigured ?? false,
  deviceFlowConfigured: overrides.deviceFlowConfigured ?? false,
  gh: {
    available: overrides.available ?? false,
    loggedIn: overrides.loggedIn ?? false,
  },
});

describe('preferredConnection', () => {
  it('keeps a complete one-click OAuth registration first', () => {
    expect(
      preferredConnection(
        status({ oauthConfigured: true, deviceFlowConfigured: true, available: true, loggedIn: true }),
      ),
    ).toBe('oauth');
  });

  it('prefers an existing GitHub CLI login over bundled device flow', () => {
    expect(preferredConnection(status({ deviceFlowConfigured: true, available: true, loggedIn: true }))).toBe(
      'gh-cli',
    );
  });

  it('uses bundled device flow when the CLI is unavailable or signed out', () => {
    expect(preferredConnection(status({ deviceFlowConfigured: true }))).toBe('device');
    expect(preferredConnection(status({ deviceFlowConfigured: true, available: true }))).toBe('device');
  });

  it('offers CLI login or bootstrap only when no configured auth path exists', () => {
    expect(preferredConnection(status({ available: true }))).toBe('gh-login');
    expect(preferredConnection(status({}))).toBe('bootstrap');
  });
});
