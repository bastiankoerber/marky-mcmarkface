import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';

const DIR = join(homedir(), '.pilcrow');
const FILE = join(DIR, 'prefs.json');

export interface Prefs {
  /** Repos the user pinned. Pinned repos sort first; nothing is ever hidden by this. */
  pinnedRepos: string[];
  /** Whether the first-run pin card has been dismissed. */
  pinCardDismissed: boolean;
  /** path -> viewer id, for "open with". */
  viewerOverrides: Record<string, string>;
  /** Files marked viewed, keyed `owner/repo#number:path`. */
  viewed: string[];
}

const DEFAULTS: Prefs = { pinnedRepos: [], pinCardDismissed: false, viewerOverrides: {}, viewed: [] };

let cache: Prefs | null = null;

export async function readPrefs(): Promise<Prefs> {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...(JSON.parse(await readFile(FILE, 'utf8')) as Partial<Prefs>) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

/**
 * Only known keys are persisted. This is written from a browser-reachable endpoint, so without
 * an allowlist anything with page access could put arbitrary JSON of arbitrary size in the
 * user's home directory.
 */
function sanitisePatch(patch: Record<string, unknown>): Partial<Prefs> {
  const out: Partial<Prefs> = {};
  if (Array.isArray(patch.pinnedRepos)) {
    out.pinnedRepos = patch.pinnedRepos.filter((v): v is string => typeof v === 'string').slice(0, 200);
  }
  if (typeof patch.pinCardDismissed === 'boolean') out.pinCardDismissed = patch.pinCardDismissed;
  if (Array.isArray(patch.viewed)) {
    out.viewed = patch.viewed.filter((v): v is string => typeof v === 'string').slice(0, 5000);
  }
  if (patch.viewerOverrides && typeof patch.viewerOverrides === 'object' && !Array.isArray(patch.viewerOverrides)) {
    const entries = Object.entries(patch.viewerOverrides as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string')
      .slice(0, 1000) as Array<[string, string]>;
    out.viewerOverrides = Object.fromEntries(entries);
  }
  return out;
}

export async function writePrefs(patch: Record<string, unknown>): Promise<Prefs> {
  const next = { ...(await readPrefs()), ...sanitisePatch(patch) };
  cache = next;
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  await chmod(DIR, 0o700).catch(() => {});
  await writeFile(FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
