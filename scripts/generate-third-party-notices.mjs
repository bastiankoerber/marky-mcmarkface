import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const licenseGroups = JSON.parse(
  execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  }),
);

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const packages = new Map();
const installedPackages = new Map();
const visitedNodeModules = new Set();

function indexPackage(packagePath) {
  const manifestPath = join(packagePath, 'package.json');
  if (!existsSync(manifestPath)) return;

  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (pkg.name && pkg.version) installedPackages.set(`${pkg.name}@${pkg.version}`, packagePath);

  indexNodeModules(join(packagePath, 'node_modules'));
}

function indexNodeModules(nodeModulesPath) {
  if (!existsSync(nodeModulesPath)) return;

  const realPath = realpathSync(nodeModulesPath);
  if (visitedNodeModules.has(realPath)) return;
  visitedNodeModules.add(realPath);

  for (const entry of readdirSync(nodeModulesPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;

    const entryPath = join(nodeModulesPath, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scopedEntry of readdirSync(entryPath, { withFileTypes: true })) {
        indexPackage(join(entryPath, scopedEntry.name));
      }
    } else {
      indexPackage(entryPath);
    }
  }
}

// The hoisted linker keeps secondary versions beside their direct dependants. Index only package
// boundaries and nested node_modules directories, avoiding a costly walk through package files.
indexNodeModules(join(projectRoot, 'node_modules'));

for (const entries of Object.values(licenseGroups)) {
  for (const dependency of entries) {
    // Platform keyring packages contain the same project binary under the parent package's MIT
    // license. Listing only the parent keeps this file deterministic across build machines.
    if (dependency.name.startsWith('@napi-rs/keyring-')) continue;

    // With the hoisted linker, pnpm can report a virtual-store path that is absent on Linux.
    // Prefer valid reported paths, then resolve every requested version from the installed tree.
    const candidatePaths = [
      ...dependency.paths,
      ...dependency.versions.map((version) =>
        installedPackages.get(`${dependency.name}@${version}`),
      ),
    ].filter(Boolean);
    for (const packagePath of new Set(candidatePaths)) {
      if (!existsSync(join(packagePath, 'package.json'))) continue;
      const pkg = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'));
      if (!dependency.versions.includes(pkg.version)) continue;
      packages.set(`${pkg.name}@${pkg.version}`, packagePath);
    }
  }
}

function sourceUrl(pkg) {
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  return (repository ?? pkg.homepage ?? '')
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '');
}

const sections = [];
for (const [key, packagePath] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  // pnpm reports optional packages for every platform; only installed packages enter an artifact.
  if (!existsSync(join(packagePath, 'package.json'))) continue;
  const pkg = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'));
  let licensePath = packagePath;
  let licenseFiles = readdirSync(licensePath)
    .filter((name) => /^(?:licen[cs]e|copying|notice)(?:\..*)?$/i.test(name))
    .sort();

  // A few old packages reference a web-hosted license without shipping it. Keep a reviewed copy
  // in the repository so generated distributions remain self-contained and reproducible.
  if (licenseFiles.length === 0) {
    const overrideName = `${pkg.name.replaceAll('/', '__')}-${pkg.version}.txt`;
    const overridePath = fileURLToPath(new URL('../third_party_licenses/', import.meta.url));
    if (existsSync(join(overridePath, overrideName))) {
      licensePath = overridePath;
      licenseFiles = [overrideName];
    }
  }

  if (licenseFiles.length === 0) {
    throw new Error(`${key} has no license or notice file at ${packagePath}`);
  }

  const source = sourceUrl(pkg);
  const texts = licenseFiles.map((name) => {
    const text = readFileSync(join(licensePath, name), 'utf8').trim();
    return `### ${name}\n\n\`\`\`\`text\n${text}\n\`\`\`\``;
  });

  sections.push(
    `## ${pkg.name} ${pkg.version}\n\n` +
      `License: ${pkg.license ?? 'See included text'}${source ? `\n\nSource: ${source}` : ''}\n\n` +
      texts.join('\n\n'),
  );
}

const output = `# Third-party notices

Marky McMarkface is MIT-licensed, but its compiled application includes third-party software under the
licenses reproduced below. This file is generated from the production dependency graph with
\`pnpm notices\`; do not edit it by hand.

Bundled font licenses and provenance are maintained separately under
\`packages/host/public/fonts/\` and ship alongside the fonts.

${sections.join('\n\n---\n\n')}
`;

writeFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), output, 'utf8');
