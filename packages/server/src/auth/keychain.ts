import { join } from 'node:path';
import { mkdir, readFile, writeFile, rm, chmod, access } from 'node:fs/promises';
import { DATA_DIR } from '../paths.js';

const SERVICE = 'marky-mcmarkface';
const FALLBACK_FILE = join(DATA_DIR, 'token.json');
const SECURE_FILE = join(DATA_DIR, 'token.secure');

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

interface ElectronSafeStorage {
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

let keyring: KeyringModule | null | undefined;
let electronStorage: ElectronSafeStorage | null | undefined;
const IS_ELECTRON = Boolean(process.versions.electron);

async function loadElectronStorage(): Promise<ElectronSafeStorage | null> {
  if (electronStorage !== undefined) return electronStorage;
  if (!IS_ELECTRON) {
    electronStorage = null;
    return null;
  }

  try {
    // The desktop main process injects its already-initialized Electron safeStorage object before
    // loading this bundle. The command-line installation never defines it and remains optional.
    const loaded = globalThis as typeof globalThis & {
      __markyMcMarkfaceSafeStorage?: ElectronSafeStorage;
    };
    const storage = loaded.__markyMcMarkfaceSafeStorage;
    // On macOS, probing isEncryptionAvailable during startup can synchronously wait on Keychain.
    // Keep startup non-blocking; encryptString/decryptString remain the authoritative operations
    // and their failures are handled without ever falling back to plaintext in Electron.
    electronStorage = storage ?? null;
  } catch {
    electronStorage = null;
  }
  return electronStorage;
}

async function loadKeyring(): Promise<KeyringModule | null> {
  if (keyring !== undefined) return keyring;
  try {
    keyring = (await import('@napi-rs/keyring')) as unknown as KeyringModule;
  } catch {
    console.warn(
      '[marky-mcmarkface] @napi-rs/keyring unavailable — falling back to ~/.marky-mcmarkface/token.json (mode 0600).\n' +
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
  const json = JSON.stringify(value);
  const safeStorage = await loadElectronStorage();
  if (safeStorage) {
    await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    await chmod(DATA_DIR, 0o700).catch(() => {});
    await writeFile(SECURE_FILE, safeStorage.encryptString(json), { mode: 0o600 });
    await chmod(SECURE_FILE, 0o600);
    return;
  }
  if (IS_ELECTRON) throw new Error('Secure credential storage is unavailable on this system.');

  const kr = await loadKeyring();
  if (kr) {
    new kr.Entry(SERVICE, value.login).setPassword(json);
    // Remember which account to read back, without storing the secret itself.
    await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    await chmod(DATA_DIR, 0o700).catch(() => {});
    await writeFile(join(DATA_DIR, 'account'), value.login, 'utf8');
    return;
  }
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await chmod(DATA_DIR, 0o700).catch(() => {});
  await writeFile(FALLBACK_FILE, json, { encoding: 'utf8', mode: 0o600 });
  await chmod(FALLBACK_FILE, 0o600);
}

export async function loadToken(): Promise<StoredToken | null> {
  const safeStorage = await loadElectronStorage();
  if (safeStorage) {
    try {
      return JSON.parse(safeStorage.decryptString(await readFile(SECURE_FILE))) as StoredToken;
    } catch {
      return null;
    }
  }
  if (IS_ELECTRON) return null;

  const kr = await loadKeyring();
  if (kr) {
    try {
      const login = (await readFile(join(DATA_DIR, 'account'), 'utf8')).trim();
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

/**
 * Check for a desktop credential without asking macOS to decrypt it.
 *
 * This is intentionally just a file-system check. Calling `decryptString` here would make the
 * Keychain dialog appear before the window can explain why it is needed.
 */
export async function hasStoredToken(): Promise<boolean> {
  if (!IS_ELECTRON) return false;
  try {
    await access(SECURE_FILE);
    return true;
  } catch {
    return false;
  }
}

/** Decrypt an existing desktop credential after the user explicitly asks to unlock it. */
export async function unlockToken(): Promise<StoredToken> {
  const safeStorage = await loadElectronStorage();
  if (!safeStorage) throw new Error('Secure credential storage is unavailable on this system.');

  let encrypted: Buffer;
  try {
    encrypted = await readFile(SECURE_FILE);
  } catch {
    throw new Error('No saved GitHub connection was found.');
  }

  try {
    return JSON.parse(safeStorage.decryptString(encrypted)) as StoredToken;
  } catch {
    throw new Error('macOS did not unlock the saved GitHub connection. Nothing was changed.');
  }
}

export async function clearToken(): Promise<void> {
  await rm(SECURE_FILE, { force: true });
  const safeStorage = await loadElectronStorage();
  if (safeStorage || IS_ELECTRON) return;

  const kr = await loadKeyring();
  if (kr) {
    try {
      const login = (await readFile(join(DATA_DIR, 'account'), 'utf8')).trim();
      if (login) new kr.Entry(SERVICE, login).deletePassword();
    } catch {
      /* nothing stored */
    }
  }
  await rm(FALLBACK_FILE, { force: true });
  await rm(join(DATA_DIR, 'account'), { force: true });
}
