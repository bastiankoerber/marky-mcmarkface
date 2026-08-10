export type View =
  | { kind: 'dashboard' }
  | { kind: 'review'; owner: string; repo: string; number: number; file?: string };

export function hashForView(view: View): string {
  if (view.kind === 'dashboard') return '';
  const path = `#/pr/${encodeURIComponent(view.owner)}/${encodeURIComponent(view.repo)}/${view.number}`;
  if (!view.file) return path;
  return `${path}?${new URLSearchParams({ file: view.file })}`;
}

export function parseHash(hash: string): View {
  const question = hash.indexOf('?');
  const pathname = question === -1 ? hash : hash.slice(0, question);
  const match = /^#\/pr\/([^/]+)\/([^/]+)\/(\d+)$/.exec(pathname);
  if (!match) return { kind: 'dashboard' };

  try {
    const file = question === -1 ? null : new URLSearchParams(hash.slice(question + 1)).get('file');
    return {
      kind: 'review',
      owner: decodeURIComponent(match[1]!),
      repo: decodeURIComponent(match[2]!),
      number: Number(match[3]),
      ...(file ? { file } : {}),
    };
  } catch {
    return { kind: 'dashboard' };
  }
}
