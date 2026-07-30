import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const exec = promisify(execFile);

const CACHE = new URL('../../../../.cache/corpus/', import.meta.url).pathname;

async function gh(args: string[]): Promise<string> {
  const { stdout } = await exec('gh', args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

/**
 * The committed fixture set, for CI.
 *
 * These are hand-written rather than scraped, for two reasons: a public repository should not
 * carry someone's internal documentation, and a fixture that targets a specific construct is a
 * better regression test than a random file that happens to contain one.
 *
 * It is a smaller claim than the real-corpus run — synthetic prose cannot surprise you the way
 * real prose does — so run `--repos owner/name` before a release. But it means the gate runs on
 * every contributor's pull request instead of nowhere.
 */
export async function loadFixtures(): Promise<Array<{ id: string; source: string }>> {
  const names = (await readdir(FIXTURES)).filter((name) => name.endsWith('.md')).sort();
  return Promise.all(
    names.map(async (name) => ({
      id: `fixtures:${name}`,
      source: await readFile(join(FIXTURES, name), 'utf8'),
    })),
  );
}

/**
 * Pull real markdown out of real repos. Synthetic fixtures cannot fully stand in for this — the
 * failure modes we care about (entities, escapes, raw HTML, nested tables, front matter) show up
 * in combinations nobody thinks to invent.
 */
export async function fetchCorpus(repos: string[], limitPerRepo: number): Promise<Array<{ id: string; source: string }>> {
  const out: Array<{ id: string; source: string }> = [];

  for (const repo of repos) {
    const slug = repo.replace('/', '__');
    const repoDir = join(CACHE, slug);

    if (existsSync(repoDir)) {
      const cached = await readdir(repoDir);
      for (const name of cached.slice(0, limitPerRepo)) {
        out.push({ id: `${repo}:${name}`, source: await readFile(join(repoDir, name), 'utf8') });
      }
      continue;
    }

    await mkdir(repoDir, { recursive: true });

    const meta = JSON.parse(await gh(['api', `repos/${repo}`]));
    const branch = meta.default_branch as string;
    const tree = JSON.parse(await gh(['api', `repos/${repo}/git/trees/${branch}?recursive=1`]));
    if (tree.truncated) {
      console.warn(`  ! ${repo}: tree truncated, sampling from the visible portion only`);
    }

    const mdFiles = (tree.tree as TreeEntry[])
      .filter((e) => e.type === 'blob' && /\.mdx?$/.test(e.path))
      .filter((e) => (e.size ?? 0) > 200 && (e.size ?? 0) < 200_000)
      .slice(0, limitPerRepo);

    for (const entry of mdFiles) {
      const encoded = entry.path.split('/').map(encodeURIComponent).join('/');
      let content: string;
      try {
        content = await gh([
          'api',
          `repos/${repo}/contents/${encoded}?ref=${branch}`,
          '-H',
          'Accept: application/vnd.github.raw',
        ]);
      } catch {
        continue;
      }
      const safe = entry.path.replace(/[^a-zA-Z0-9._-]/g, '_');
      await writeFile(join(repoDir, safe), content, 'utf8');
      out.push({ id: `${repo}:${entry.path}`, source: content });
    }
    console.log(`  fetched ${mdFiles.length} files from ${repo}`);
  }

  return out;
}

export { CACHE };
