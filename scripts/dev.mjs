import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * One command for both halves: the Hono API on 127.0.0.1:7423 and the Vite dev server on 5180,
 * which proxies /api to it. In production there is only the Hono server — it serves the built
 * assets itself, so there is a single origin and no proxy.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const children = [];

function run(name, command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const tag = `[${name}]`;
  const pipe = (stream, out) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim()) out.write(`${tag} ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${tag} exited with ${code}\n`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('api', 'npx', ['tsx', 'packages/server/src/index.ts'], root);
run('ui', 'npx', ['vite'], join(root, 'packages/host'));
