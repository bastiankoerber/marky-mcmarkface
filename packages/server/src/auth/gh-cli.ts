import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Import the GitHub CLI's token.
 *
 * Offered as a convenience, never as the default, and the UI must disclose why: that token
 * belongs to the GitHub CLI's own OAuth app, so every call marky-mcmarkface makes appears in org audit logs
 * as "GitHub CLI" rather than as marky-mcmarkface. It also carries scopes marky-mcmarkface has no business holding —
 * `workflow` (rewrite CI) and `admin:public_key` (add SSH keys to the account).
 */

export interface GhStatus {
  available: boolean;
  loggedIn: boolean;
  login?: string;
  scopes?: string;
  /** Scopes gh holds that marky-mcmarkface would never request. Surfaced in the UI before the user opts in. */
  excessScopes?: string[];
  reason?: string;
}

const MARKY_MCMARKFACE_SCOPES = new Set(['repo', 'read:org']);

/** Env vars `gh` prefers over its own stored credential. */
const AMBIENT_TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

async function ghAuthToken(ignoreAmbient: boolean): Promise<string> {
  const env = { ...process.env };
  if (ignoreAmbient) for (const key of AMBIENT_TOKEN_VARS) delete env[key];
  const { stdout } = await exec('gh', ['auth', 'token'], { env });
  return stdout.trim();
}

const probe = (token: string) =>
  fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'marky-mcmarkface' },
  });

/**
 * Get a *working* token out of the GitHub CLI.
 *
 * `gh auth token` prefers `GH_TOKEN` / `GITHUB_TOKEN` from the environment over the credential
 * it stores in the keyring. Those variables are very often stale leftovers — a CI secret, an old
 * PAT exported from a shell profile — and when they are, `gh auth status` cheerfully reports you
 * as logged in while every API call 401s. So: try what `gh` gives us, and if GitHub rejects it
 * while an ambient variable is set, ask again with those variables stripped to force the keyring
 * credential.
 */
async function resolveToken(): Promise<{ token: string; res: Response } | { reason: string }> {
  const ambient = AMBIENT_TOKEN_VARS.filter((key) => process.env[key]);

  let token: string;
  try {
    token = await ghAuthToken(false);
  } catch (err) {
    const detail = String((err as { stderr?: string }).stderr ?? (err as Error).message).trim();
    return {
      reason: detail ? `GitHub CLI could not return a token: ${detail}` : 'GitHub CLI is installed but not logged in.',
    };
  }
  if (!token) return { reason: 'GitHub CLI returned no token.' };

  const res = await probe(token);
  if (res.ok || ambient.length === 0) return { token, res };

  try {
    const stored = await ghAuthToken(true);
    if (stored && stored !== token) {
      const retry = await probe(stored);
      if (retry.ok) return { token: stored, res: retry };
    }
  } catch {
    /* fall through and report the original rejection */
  }
  return { token, res };
}

export async function ghStatus(): Promise<GhStatus> {
  try {
    await exec('gh', ['--version']);
  } catch {
    return { available: false, loggedIn: false, reason: 'GitHub CLI is not installed.' };
  }

  const attempts = await resolveToken();
  if ('reason' in attempts) return { available: true, loggedIn: false, reason: attempts.reason };
  const { token, res } = attempts;
  if (!res.ok) {
    // Include shape, never the value. A wrong length or an unexpected prefix means `gh` handed
    // us something other than its own credential.
    const shape = `${token.slice(0, 4)}…, ${token.length} chars`;
    return {
      available: true,
      loggedIn: false,
      reason: `GitHub rejected the CLI token (${res.status}; ${shape}).`,
    };
  }

  const scopes = res.headers.get('x-oauth-scopes') ?? '';
  const user = (await res.json()) as { login: string };
  const excess = scopes
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !MARKY_MCMARKFACE_SCOPES.has(s));

  return { available: true, loggedIn: true, login: user.login, scopes, excessScopes: excess };
}

export async function ghToken(): Promise<string> {
  // Same resolution as ghStatus, so the button never adopts a token the status screen just
  // told the user is broken.
  const attempts = await resolveToken();
  if ('reason' in attempts) throw new Error(attempts.reason);
  if (!attempts.res.ok) throw new Error(`GitHub rejected the CLI token (${attempts.res.status}).`);
  const token = attempts.token;
  if (!token) throw new Error('gh auth token returned nothing');
  return token;
}
