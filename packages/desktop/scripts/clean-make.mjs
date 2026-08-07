import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const makePath = resolve(desktopRoot, 'out', 'make');

await rm(makePath, { recursive: true, force: true });
