import type { AuthStatus } from '../api.js';

export type PreferredConnection = 'oauth' | 'gh-cli' | 'device' | 'gh-login' | 'bootstrap';

/** Pick the lowest-friction configured path without hiding an existing company-authorized CLI login. */
export function preferredConnection(
  status: Pick<AuthStatus, 'oauthConfigured' | 'deviceFlowConfigured' | 'gh'>,
): PreferredConnection {
  if (status.oauthConfigured) return 'oauth';
  if (status.gh.loggedIn) return 'gh-cli';
  if (status.deviceFlowConfigured) return 'device';
  if (status.gh.available) return 'gh-login';
  return 'bootstrap';
}
