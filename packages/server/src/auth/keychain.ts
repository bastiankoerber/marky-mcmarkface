import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';

const SERVICE = 'pilcrow';
const FALLBACK_DIR = join(homedir(), '.pilcrow');
const FALLBACK_FILE = join(FALLBACK_DIR, 'token.json');

/**
 * Token storage.
 *
 * A non-expiring `repo`-scoped token on a multi-app machine belongs in the Keychain, not in a
 * dotfile — that is the single worst place to put it. The file fallback exists only so the app
 * still runs where the native module will not build, and it is mode 0600 and loudly announced.
 */

interface KeyringModule {
  Entry: new (service: string, account: string) => {
    getPassword(): string;
    setPassword(pw: string): void;
    deletePassword(): boolean;
  };
}

let keyring: KeyringModule | null | undefined;

async function loadKeyring(): Promise<KeyringModule | null> {
  if (keyring !== undefined) return keyring;
  try {
    keyring = (await import('@napi-rs/keyring')) as unknown as KeyringModule;
  } catch {
    console.warn(
      '[pilcrow] @napi-rs/keyring unavailable — falling back to ~/.pilcrow/token.json (mode 0600).\n' +
        '       Install it to keep your GitHub token in the macOS Keychain instead.',
    );
    keyring = null;
  }
  return keyring;
}

export interface StoredToken {
  token: string;
  login: string;
  /** Shown on the "connected" screen — seeing your own face is what catches a wrong account. */
  avatarUrl: string;
  scopes: string;
  /** How the token was obtained, so the UI can explain what it is. */
  source: 'oauth' | 'device-flow' | 'gh-cli' | 'pat';
}

export async function saveToken(value: StoredToken): Promise<void> {
  const kr = await loadKeyring();
  const json = JSON.stringify(value);
  if (kr) {
    new kr.Entry(SERVICE, value.login).setPassword(json);
    // Remember which account to read back, without storing the secret itself.
    await mkdir(FALLBACK_DIR, { recursive: true });
    await writeFile(join(FALLBACK_DIR, 'account'), value.login, 'utf8');
    return;
  }
  await mkdir(FALLBACK_DIR, { recursive: true });
  await writeFile(FALLBACK_FILE, json, { encoding: 'utf8', mode: 0o600 });
  await chmod(FALLBACK_FILE, 0o600);
}

export async function loadToken(): Promise<StoredToken | null> {
  const kr = await loadKeyring();
  if (kr) {
    try {
      const login = (await readFile(join(FALLBACK_DIR, 'account'), 'utf8')).trim();
      if (!login) return null;
      const json = new kr.Entry(SERVICE, login).getPassword();
      return json ? (JSON.parse(json) as StoredToken) : null;
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(await readFile(FALLBACK_FILE, 'utf8')) as StoredToken;
  } catch {
    return null;
  }
}

export async function clearToken(): Promise<void> {
  const kr = await loadKeyring();
  if (kr) {
    try {
      const login = (await readFile(join(FALLBACK_DIR, 'account'), 'utf8')).trim();
      if (login) new kr.Entry(SERVICE, login).deletePassword();
    } catch {
      /* nothing stored */
    }
  }
  await rm(FALLBACK_FILE, { force: true });
  await rm(join(FALLBACK_DIR, 'account'), { force: true });
}
