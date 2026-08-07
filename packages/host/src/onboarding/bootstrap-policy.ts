/** Select the sign-in path supported by the registration the user just saved. */
export function authPhaseAfterBootstrap(clientSecret: string): 'access' | 'device' {
  return clientSecret.trim() ? 'access' : 'device';
}
