import { mkdir, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = resolve(desktopRoot, 'out');
const { productName, version } = JSON.parse(
  await readFile(resolve(desktopRoot, 'package.json'), 'utf8'),
);
const appPath = resolve(outRoot, `${productName}-darwin-${process.arch}`, `${productName}.app`);
const stagePath = resolve(outRoot, '.dmg-stage');
const stagedAppPath = resolve(stagePath, `${productName}.app`);
const makePath = resolve(outRoot, 'make');
const dmgPath = resolve(makePath, `Marky-McMarkface-${version}-${process.arch}.dmg`);

if (process.platform !== 'darwin') {
  throw new Error('DMG creation is only available on macOS.');
}

await rm(stagePath, { recursive: true, force: true });
await mkdir(stagePath, { recursive: true });
await mkdir(makePath, { recursive: true });

try {
  // `fs.cp` rewrites relative framework symlinks to absolute paths by default. That leaves a
  // DMG-installed Electron app pointing back into the build machine and invalidates its code
  // signature. `ditto` is macOS's bundle-aware copier and preserves the framework layout.
  execFileSync('ditto', [appPath, stagedAppPath], { stdio: 'inherit' });

  const frameworkLink = await readlink(
    resolve(stagedAppPath, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'),
  );
  if (isAbsolute(frameworkLink)) {
    throw new Error(`DMG staging rewrote an Electron framework symlink: ${frameworkLink}`);
  }
  execFileSync('codesign', ['--verify', '--deep', '--strict', stagedAppPath], { stdio: 'inherit' });

  await symlink('/Applications', resolve(stagePath, 'Applications'));

  execFileSync(
    'hdiutil',
    [
      'create',
      '-volname',
      productName,
      '-srcfolder',
      stagePath,
      '-ov',
      '-format',
      'UDZO',
      dmgPath,
    ],
    { stdio: 'inherit' },
  );
} finally {
  await rm(stagePath, { recursive: true, force: true });
}

console.log(`Created ${dmgPath}`);
