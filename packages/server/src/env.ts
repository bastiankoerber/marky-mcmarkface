import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Load `.env` from the repository root.
 *
 * `.env.example` has always told people to copy it to `.env` — and nothing read the file, so
 * following the documented setup did precisely nothing. Rather than delete the instruction,
 * make it true.
 *
 * Deliberately hand-rolled: this needs to parse `KEY=value` and nothing else, and a dependency
 * that runs at startup in a process holding a GitHub token is a dependency worth not having.
 *
 * Real environment variables always win, so `PILCROW_PORT=1234 pnpm dev` behaves as expected and
 * CI is never overridden by a stray file.
 */
export function loadDotEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '../../..');

  let contents: string;
  try {
    contents = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    return; // absent is the normal case
  }

  for (const raw of contents.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;

    let value = line.slice(eq + 1).trim();
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);

    process.env[key] = value;
  }
}

/*
 * Run on import.
 *
 * ES modules hoist every `import` above the module body, so a `loadDotEnv()` call placed among
 * the imports of another file would run *after* those modules had already been evaluated. Doing
 * the work here, and importing this module first, is what actually guarantees the ordering.
 */
loadDotEnv();
