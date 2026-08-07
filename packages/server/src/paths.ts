import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Desktop builds use Electron's per-user Application Support directory. The command-line and
 * browser installation keep the historical dot-directory so the two installation modes do not
 * unexpectedly share credentials or mutable state.
 */
export const DATA_DIR =
  process.env.MARKY_MCMARKFACE_DATA_DIR || join(homedir(), '.marky-mcmarkface');
