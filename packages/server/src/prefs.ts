import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

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

export async function writePrefs(patch: Partial<Prefs>): Promise<Prefs> {
  const next = { ...(await readPrefs()), ...patch };
  cache = next;
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
