import { build } from 'esbuild';
import { cp, copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktopDir, '../..');
const dist = join(desktopDir, 'dist');
const appFiles = join(desktopDir, 'app');

await rm(dist, { recursive: true, force: true });
await rm(appFiles, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(join(appFiles, 'icons'), { recursive: true });
await mkdir(join(appFiles, 'legal'), { recursive: true });

await build({
  entryPoints: [join(desktopDir, 'src/main.ts')],
  outfile: join(dist, 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: ['electron', '@napi-rs/keyring'],
  define: {
    __MARKY_SIGNED_RELEASE__: JSON.stringify(process.env.MARKY_RELEASE_SIGNING === 'true'),
  },
  banner: {
    js: "import { createRequire as __markyCreateRequire } from 'node:module'; const require = __markyCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});

await cp(join(root, 'packages/host/dist'), join(appFiles, 'ui'), { recursive: true });
await copyFile(join(root, 'packages/host/public/icons/icon-512.png'), join(appFiles, 'icons/icon-512.png'));
await copyFile(join(root, 'LICENSE'), join(appFiles, 'legal/LICENSE.txt'));
await copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(appFiles, 'legal/THIRD_PARTY_NOTICES.md'));
